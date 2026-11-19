package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"
)

// A batch holds at most 4 * 16 MiB in memory with default concurrency.
// Ranges are downloaded concurrently but appended to the partial file only
// after every range in the batch is verified, preserving a contiguous prefix
// that the existing resume logic can safely reuse after a crash.
const downloadPartSize int64 = 16 << 20

var errBoundedRangesUnavailable = errors.New("bounded download ranges unavailable")

type downloadPart struct {
	index int
	start int64
	end   int64 // inclusive
}

func downloadParts(start, total int64, concurrency int) []downloadPart {
	parts := make([]downloadPart, 0, concurrency)
	for at := start; at < total && len(parts) < concurrency; at += downloadPartSize {
		end := min(at+downloadPartSize, total) - 1
		parts = append(parts, downloadPart{index: len(parts), start: at, end: end})
	}
	return parts
}

// fetchParallel commits verified batches in file order. A failed batch is
// discarded and retried by the caller from the last committed prefix.
// The shared slots channel caps total HTTP downloads across a folder.
func fetchParallel(ctx context.Context, c *client, f *os.File, item downloadItem, offset, total int64, concurrency int, slots chan struct{}) error {
	progress := newProgress(fileLabel("Download", item.remote), total, offset)
	for offset < total {
		parts := downloadParts(offset, total, concurrency)
		data := make([][]byte, len(parts))
		err := parallel(ctx, concurrency, parts, func(ctx context.Context, part downloadPart) error {
			b, err := fetchBounded(ctx, c, item, part, total, slots, progress)
			if err != nil {
				return err
			}
			data[part.index] = b
			return nil
		})
		if err != nil {
			progress.set(offset, true)
			return err
		}
		for _, b := range data {
			n, err := f.Write(b)
			offset += int64(n)
			if err != nil {
				return err
			}
			if n != len(b) {
				return io.ErrShortWrite
			}
		}
		// Commit only contiguous bytes before scheduling the next batch.
		// If interrupted, an on-disk prefix remains valid for Range resume.
		if err := f.Sync(); err != nil {
			return err
		}
	}
	progress.print(true)
	return nil
}

func fetchBounded(ctx context.Context, c *client, item downloadItem, part downloadPart, total int64, slots chan struct{}, progress *progress) ([]byte, error) {
	if err := takeSlot(ctx, slots); err != nil {
		return nil, err
	}
	defer func() { <-slots }()
	requestCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	idle := time.AfterFunc(90*time.Second, cancel)
	defer idle.Stop()

	headers := http.Header{
		"X-Ol-Version": {item.entry.Version},
		"Range":        {fmt.Sprintf("bytes=%d-%d", part.start, part.end)},
		"Accept-Encoding": {"identity"},
	}
	response, err := c.request(requestCtx, http.MethodGet, "/download",
		url.Values{"path": {item.remote}}, nil, 0, headers)
	if err != nil {
		if hasStatus(err, http.StatusRequestedRangeNotSatisfiable) || hasStatus(err, http.StatusNotImplemented) {
			return nil, errBoundedRangesUnavailable
		}
		if requestCtx.Err() != nil && ctx.Err() == nil {
			return nil, networkError{timeout: true}
		}
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusOK {
		// Older Workers or upstream servers may ignore bounded Range.
		// Never buffer the full file in that case.
		return nil, errBoundedRangesUnavailable
	}
	expectedLength := part.end - part.start + 1
	expectedRange := fmt.Sprintf("bytes %d-%d/%d", part.start, part.end, total)
	if response.StatusCode != http.StatusPartialContent ||
		response.Header.Get("Content-Range") != expectedRange ||
		response.ContentLength >= 0 && response.ContentLength != expectedLength {
		return nil, fmt.Errorf("%w: incorrect bounded download response", io.ErrUnexpectedEOF)
	}
	// Limit in-memory buffering to the requested part plus one excess byte.
	r := countedReader{r: io.LimitReader(response.Body, expectedLength+1), step: func(n int) {
		if n > 0 {
			idle.Reset(90 * time.Second)
			progress.add(int64(n))
		}
	}}
	data, err := io.ReadAll(r)
	if err != nil {
		if requestCtx.Err() != nil && ctx.Err() == nil {
			return nil, networkError{timeout: true}
		}
		return nil, err
	}
	if int64(len(data)) != expectedLength {
		return nil, fmt.Errorf("%w: bounded download part size mismatch", io.ErrUnexpectedEOF)
	}
	return data, nil
}
