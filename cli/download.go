package main

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type downloadItem struct {
	remote, local string
	entry         entry
}

func download(ctx context.Context, c *client, s session, config string, o options) error {
	remote, err := remotePath(o.arg)
	if err != nil {
		return err
	}
	remoteEntry, err := statRemote(ctx, c, remote)
	if err != nil {
		return err
	}
	target := path.Base(remote)
	if o.to != "" {
		target = o.to
		info, err := os.Stat(target)
		if strings.HasSuffix(target, "/") || err == nil && info.IsDir() {
			target = filepath.Join(target, path.Base(remote))
		}
	}
	dest, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
		return err
	}
	root, err := os.OpenRoot(filepath.Dir(dest))
	if err != nil {
		return err
	}
	defer root.Close()

	initial := downloadItem{remote, filepath.Base(dest), remoteEntry}
	slots := make(chan struct{}, o.concurrency)
	if !remoteEntry.IsDir {
		return downloadFile(ctx, c, s, config, root, initial, slots, o.concurrency)
	}
	var files []downloadItem
	var folders []string
	if err := downloadTree(ctx, c, downloadItem{remote, ".", remoteEntry}, &files, &folders); err != nil {
		return err
	}
	if err := root.Mkdir(initial.local, 0755); err != nil && !os.IsExist(err) {
		return err
	}
	expected, err := root.Lstat(initial.local)
	if err != nil {
		return err
	}
	if !expected.IsDir() {
		return errors.New("download directory must be a real directory")
	}
	sub, err := root.OpenRoot(initial.local)
	if err != nil {
		return err
	}
	defer sub.Close()
	actual, err := sub.Stat(".")
	if err != nil || !os.SameFile(expected, actual) {
		return errors.New("download directory changed")
	}
	for _, folder := range folders {
		if err := sub.MkdirAll(folder, 0755); err != nil {
			return err
		}
	}
	return parallel(ctx, o.concurrency, files, func(ctx context.Context, item downloadItem) error {
		return downloadFile(ctx, c, s, config, sub, item, slots, o.concurrency)
	})
}

func downloadTree(ctx context.Context, c *client, dir downloadItem, files *[]downloadItem, folders *[]string) error {
	*folders = append(*folders, dir.local)
	var nested []downloadItem
	names := make(map[string]bool)
	err := eachPage(ctx, c, "/list", dir.remote, func(e entry) error {
		if !safeComponent(e.Name) || names[e.Name] {
			return fmt.Errorf("unsafe or ambiguous name %q in Drive folder %q", e.Name, dir.remote)
		}
		names[e.Name] = true
		item := downloadItem{path.Join(dir.remote, e.Name), filepath.Join(dir.local, e.Name), e}
		if e.IsDir {
			nested = append(nested, item)
		} else {
			*files = append(*files, item)
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, child := range nested {
		if err := downloadTree(ctx, c, child, files, folders); err != nil {
			return err
		}
	}
	return nil
}

func downloadFile(ctx context.Context, c *client, s session, config string, root *os.Root, item downloadItem, slots chan struct{}, concurrency int) error {
	if err := fetchFile(ctx, c, s, config, root, item, slots, concurrency); err != nil {
		return fmt.Errorf("download %q: %w", item.remote, err)
	}
	return nil
}

func fetchFile(ctx context.Context, c *client, s session, config string, root *os.Root, item downloadItem, slots chan struct{}, concurrency int) error {
	e := item.entry
	if e.Size == nil || *e.Size < 0 || e.Version == "" {
		return errors.New("Drive does not expose downloadable file metadata")
	}
	var n int64 = *e.Size
	unlock, err := lockFile(filepath.Join(config, "downloads"), keyOf(root.Name(), item.local))
	if err != nil {
		return err
	}
	defer unlock()
	if _, err := root.Lstat(item.local); err == nil {
		file, err := root.OpenFile(item.local, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
		if err != nil {
			return err
		}
		defer file.Close()
		if (e.MD5 != "" || e.SHA256 != "") && checkLocal(file, e) == nil {
			report("Verified existing local file %q", item.local)
			return nil
		}
		return errors.New("a different or unverifiable local file already exists")
	} else if !os.IsNotExist(err) {
		return err
	}

	key := keyOf(c.server, strconv.FormatInt(s.UserID, 10), item.remote, item.local, e.Version, e.MD5, e.SHA256)
	partial := filepath.Join(filepath.Dir(item.local), ".ol-part-"+key)
	f, err := root.OpenFile(partial, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	sys := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || sys.Nlink != 1 || sys.Uid != uint32(os.Getuid()) {
		return errors.New("unsafe local partial download file")
	}
	err = retry(ctx, func() error {
		offset, err := f.Seek(0, io.SeekEnd)
		if err != nil {
			return err
		}
		if offset > n || (offset > 0 && strings.HasSuffix(e.Version, ":") && e.MD5 == "" && e.SHA256 == "") {
			if err := truncateFile(f); err != nil {
				return err
			}
			offset = 0
		}
		if offset < n || n == 0 {
			if concurrency > 1 && n-offset >= 2*downloadPartSize {
				err = fetchParallel(ctx, c, f, item, offset, n, concurrency, slots)
				if errors.Is(err, errBoundedRangesUnavailable) {
					report("Bounded Range unavailable for %q; falling back to single connection", item.remote)
					offset, err = f.Seek(0, io.SeekEnd)
					if err != nil {
						return err
					}
					err = fetchRange(ctx, c, f, item, offset, n, slots)
				}
			} else {
				err = fetchRange(ctx, c, f, item, offset, n, slots)
			}
			if err != nil {
				return err
			}
		}
		if err := checkLocal(f, e); err != nil {
			if errors.Is(err, errChecksum) {
				if truncErr := truncateFile(f); truncErr != nil {
					return truncErr
				}
				return fmt.Errorf("%w: downloaded checksum differs", io.ErrUnexpectedEOF)
			}
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	// A hard link publishes the verified bytes atomically and fails if the name exists.
	if err := root.Link(partial, item.local); err != nil {
		return err
	}
	if err := root.Remove(partial); err != nil {
		return err
	}
	report("Downloaded and verified %q (%s)", item.local, byteUnits(n))
	return nil
}

func truncateFile(f *os.File) error {
	if err := f.Truncate(0); err != nil {
		return err
	}
	_, err := f.Seek(0, io.SeekStart)
	return err
}

var contentRange = regexp.MustCompile("^bytes ([0-9]+)-([0-9]+)/([0-9]+)$")

func correctRange(header string, start, size int64) bool {
	match := contentRange.FindStringSubmatch(header)
	if match == nil {
		return false
	}
	return match[1] == strconv.FormatInt(start, 10) &&
		match[2] == strconv.FormatInt(size-1, 10) && match[3] == strconv.FormatInt(size, 10)
}

func fetchRange(ctx context.Context, c *client, f *os.File, item downloadItem, offset, total int64, slots chan struct{}) error {
	if err := takeSlot(ctx, slots); err != nil {
		return err
	}
	defer func() { <-slots }()
	requestCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	ticker := time.AfterFunc(90*time.Second, cancel)
	defer ticker.Stop()
	headers := http.Header{"X-Ol-Version": {item.entry.Version}}
	if offset > 0 {
		headers.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	response, err := c.request(requestCtx, http.MethodGet, "/download", url.Values{"path": {item.remote}}, nil, 0, headers)
	if err != nil {
		if hasStatus(err, 416) && offset > 0 {
			if err := truncateFile(f); err != nil {
				return err
			}
			return io.ErrUnexpectedEOF
		}
		if requestCtx.Err() != nil && ctx.Err() == nil {
			return networkError{timeout: true}
		}
		return err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusPartialContent {
		if !correctRange(response.Header.Get("Content-Range"), offset, total) {
			return errors.New("server returned an unexpected byte range")
		}
	} else if response.StatusCode != http.StatusOK {
		return errors.New("server returned an unexpected download response")
	} else if offset > 0 {
		if err := truncateFile(f); err != nil {
			return err
		}
		offset = 0
	}
	if response.ContentLength >= 0 && response.ContentLength != total-offset {
		return fmt.Errorf("%w: response size differs from Drive metadata", io.ErrUnexpectedEOF)
	}
	progress := newProgress(fileLabel("Download", item.remote), total, offset)
	r := countedReader{response.Body, func(n int) {
		if n > 0 {
			ticker.Reset(90 * time.Second)
			progress.add(int64(n))
		}
	}}
	_, err = io.CopyN(f, r, total-offset)
	if err != nil {
		if errors.Is(err, io.EOF) || requestCtx.Err() != nil && ctx.Err() == nil {
			return io.ErrUnexpectedEOF
		}
		return err
	}
	var extra [1]byte
	check, err := io.ReadFull(r, extra[:])
	if check > 0 {
		if err := truncateFile(f); err != nil {
			return err
		}
		return errors.New("server sent more bytes than Drive metadata specifies")
	}
	if err != io.EOF {
		if requestCtx.Err() != nil && ctx.Err() == nil {
			return io.ErrUnexpectedEOF
		}
		if err == nil {
			return io.ErrUnexpectedEOF
		}
		return err
	}
	progress.print(true)
	return nil
}

var errChecksum = errors.New("file checksum differs")

func checkLocal(file *os.File, e entry) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != *e.Size {
		return io.ErrUnexpectedEOF
	}
	if e.SHA256 == "" && e.MD5 == "" {
		return nil
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	hash, want := sha256.New(), e.SHA256
	if want == "" {
		hash, want = md5.New(), e.MD5
	}
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	if !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), want) {
		return errChecksum
	}
	return nil
}
