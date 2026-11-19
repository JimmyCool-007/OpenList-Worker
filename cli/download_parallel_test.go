package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func rangeTestBlob(size int) []byte {
	data := make([]byte, size)
	for i := range data {
		data[i] = byte(i*17 + 3)
	}
	return data
}

// The mock returns the same strict 206 framing as the Worker and records
// active transfers to ensure a large single file actually uses four streams.
func rangeTestClient(t *testing.T, blob []byte, hook func(start, end int64, bounded bool) int) (*client, entry) {
	t.Helper()
	size := int64(len(blob))
	e := entry{Name: "test-large.bin", Version: "google-id:7", Size: &size,
		SHA256: fmt.Sprintf("%x", sha256.Sum256(blob))}
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/cli/v1/stat":
			sendJSON(w, e)
			return
		case "/api/cli/v1/download":
		default:
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("X-Ol-Version") != e.Version || r.Header.Get("Authorization") == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		start, end, bounded := int64(0), size-1, false
		if raw := r.Header.Get("Range"); raw != "" {
			if !strings.HasPrefix(raw, "bytes=") {
				http.Error(w, "bad range", 416)
				return
			}
			before, after, ok := strings.Cut(strings.TrimPrefix(raw, "bytes="), "-")
			var err error
			start, err = strconv.ParseInt(before, 10, 64)
			if !ok || err != nil {
				http.Error(w, "bad range", 416)
				return
			}
			if after != "" {
				end, err = strconv.ParseInt(after, 10, 64)
				if err != nil {
					http.Error(w, "bad range", 416)
					return
				}
				bounded = true
			}
			if start >= size || end >= size || end < start {
				http.Error(w, "bad range", 416)
				return
			}
		}
		if hook != nil {
			if status := hook(start, end, bounded); status != 0 {
				http.Error(w, "simulated failure", status)
				return
			}
		}
		w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
		if r.Header.Get("Range") != "" {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
			w.WriteHeader(http.StatusPartialContent)
		}
		_, _ = w.Write(blob[start : end+1])
	})
	return c, e
}

func TestDownloadPartsPlan(t *testing.T) {
	parts := downloadParts(11, 4*downloadPartSize+22, 4)
	if len(parts) != 4 || parts[0].start != 11 || parts[0].end != 11+downloadPartSize-1 {
		t.Fatalf("unexpected first download batch: %+v", parts)
	}
	for i, part := range parts {
		if part.index != i || part.end < part.start || part.end-part.start+1 > downloadPartSize {
			t.Fatalf("invalid part: %+v", part)
		}
		if i > 0 && part.start != parts[i-1].end+1 {
			t.Fatalf("gap or overlap between parts: %+v", parts)
		}
	}
}

func TestParallelDownloadSingleFileUsesFourStreams(t *testing.T) {
	blob := rangeTestBlob(int(4*downloadPartSize + 1024))
	var active, peak atomic.Int32
	var bounded atomic.Int32
	c, e := rangeTestClient(t, blob, func(start, end int64, isBounded bool) int {
		if !isBounded {
			t.Error("large file was downloaded without bounded Range")
			return 400
		}
		bounded.Add(1)
		n := active.Add(1)
		for {
			was := peak.Load()
			if n <= was || peak.CompareAndSwap(was, n) {
				break
			}
		}
		time.Sleep(30 * time.Millisecond)
		active.Add(-1)
		return 0
	})
	dir := t.TempDir()
	if err := download(t.Context(), c, session{UserID: 7}, t.TempDir(),
		options{arg: e.Name, to: dir, concurrency: 4}); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dir, e.Name))
	if err != nil || !bytes.Equal(got, blob) {
		t.Fatalf("downloaded bytes differ: %v", err)
	}
	if peak.Load() < 2 || peak.Load() > 4 || bounded.Load() != 5 {
		t.Fatalf("expected four concurrent Range streams and five chunks, peak=%d requests=%d",
			peak.Load(), bounded.Load())
	}
}

func TestParallelDownloadFallsBackWhenRangesUnsupported(t *testing.T) {
	blob := rangeTestBlob(int(2*downloadPartSize + 8192))
	var bounded, single atomic.Int32
	c, e := rangeTestClient(t, blob, func(start, end int64, isBounded bool) int {
		if isBounded {
			bounded.Add(1)
			return http.StatusRequestedRangeNotSatisfiable // old Worker
		}
		single.Add(1)
		return 0
	})
	dir := t.TempDir()
	if err := download(t.Context(), c, session{UserID: 7}, t.TempDir(),
		options{arg: e.Name, to: dir, concurrency: 4}); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dir, e.Name))
	if err != nil || !bytes.Equal(got, blob) {
		t.Fatalf("fallback downloaded incorrect bytes: %v", err)
	}
	if bounded.Load() < 1 || single.Load() != 1 {
		t.Fatalf("fallback not used: bounded=%d single=%d", bounded.Load(), single.Load())
	}
}

func TestParallelDownloadResumeKeepsContiguousPrefix(t *testing.T) {
	blob := rangeTestBlob(int(4*downloadPartSize + 2048))
	var fail atomic.Bool
	fail.Store(true)
	var mu sync.Mutex
	var resumes []int64
	c, e := rangeTestClient(t, blob, func(start, end int64, bounded bool) int {
		if !bounded && start > 0 {
			mu.Lock()
			resumes = append(resumes, start)
			mu.Unlock()
		}
		if bounded && start >= 4*downloadPartSize && fail.Load() {
			return http.StatusBadRequest
		}
		return 0
	})
	dir, cfg := t.TempDir(), t.TempDir()
	opts := options{arg: e.Name, to: dir, concurrency: 4}
	if err := download(t.Context(), c, session{UserID: 7}, cfg, opts); err == nil {
		t.Fatal("failed batch was incorrectly published")
	}
	if _, err := os.Stat(filepath.Join(dir, e.Name)); !os.IsNotExist(err) {
		t.Fatal("unverified file was published")
	}
	fail.Store(false)
	if err := download(t.Context(), c, session{UserID: 7}, cfg, opts); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if len(resumes) != 1 || resumes[0] != 4*downloadPartSize {
		t.Errorf("resume did not keep contiguous verified batch: %v", resumes)
	}
	mu.Unlock()
	got, err := os.ReadFile(filepath.Join(dir, e.Name))
	if err != nil || !bytes.Equal(got, blob) {
		t.Fatalf("resumed bytes differ: %v", err)
	}
}

func TestBoundedRangeRejectsCorruptHeaders(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/cli/v1/download" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Range", "bytes 0-3/999") // not the requested total
		w.Header().Set("Content-Length", "4")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = io.WriteString(w, "abcd")
	})
	total := int64(100)
	item := downloadItem{remote: "test.bin", entry: entry{Version: "x:2", Size: &total}}
	p := newProgress("Download test.bin", total, 0)
	_, err := fetchBounded(context.Background(), c, item, downloadPart{0, 0, 3}, total,
		make(chan struct{}, 4), p)
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("incorrect Content-Range was accepted: %v", err)
	}
}
