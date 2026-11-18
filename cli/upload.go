package main

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var taskIDPattern = regexp.MustCompile("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")

type source struct {
	local, remote string
	size          int64
}

type uploadPlan struct {
	// Match the case-sensitive field names destructured by the Worker CLI API.
	// These tags also apply to local checkpoints; encoding/json accepts
	// pre-fix checkpoints with capitalized keys when reading them.
	ID       string `json:"id"`
	Path     string `json:"path"`
	MD5      string `json:"md5"`
	SHA256   string `json:"sha256"`
	Size     int64  `json:"size"`
	PartSize int64  `json:"partSize"`
}

type part struct {
	PartNumber int    `json:"partNumber"`
	ETag       string `json:"etag"`
	Size       int64  `json:"-"`
}

type remotePart struct {
	PartNumber int
	ETag       string
	Size       int64
}

func uploadTree(local, dest string) ([]source, []string, error) {
	root, err := filepath.Abs(local)
	if err != nil {
		return nil, nil, err
	}
	if !safeComponent(filepath.Base(root)) {
		return nil, nil, errors.New("unsupported local path name")
	}
	target, err := remotePath(dest)
	if err != nil {
		return nil, nil, err
	}
	if target == "" || strings.HasSuffix(dest, "/") {
		target = path.Join(target, filepath.Base(root))
	}
	var files []source
	var folders []string
	err = filepath.WalkDir(root, func(local string, file fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !safeComponent(file.Name()) {
			return fmt.Errorf("unsupported path name %q", local)
		}
		name, err := filepath.Rel(root, local)
		if err != nil {
			return err
		}
		remote := path.Join(target, filepath.ToSlash(name))
		if file.IsDir() {
			folders = append(folders, remote)
			return nil
		}
		info, err := file.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("%q is not a regular file", local)
		}
		if info.Size() > maxFile {
			return fmt.Errorf("%q is %d bytes. Single-file limit is 5,000,000,000 bytes", local, info.Size())
		}
		files = append(files, source{local, remote, info.Size()})
		return nil
	})
	var parents []string
	for parent := path.Dir(target); parent != "."; parent = path.Dir(parent) {
		parents = append(parents, parent)
	}
	for i, j := 0, len(parents)-1; i < j; i, j = i+1, j-1 {
		parents[i], parents[j] = parents[j], parents[i]
	}
	return files, append(parents, folders...), err
}

func createRemoteFolder(ctx context.Context, c *client, folder string) error {
	return c.json(ctx, http.MethodPost, "/mkdir", nil, map[string]string{"path": folder}, nil)
}

func upload(ctx context.Context, c *client, s session, config string, o options) error {
	report("Single-file upload limit: 5,000,000,000 bytes.")
	files, folders, err := uploadTree(o.arg, o.to)
	if err != nil {
		return err
	}
	for _, folder := range folders {
		if err := createRemoteFolder(ctx, c, folder); err != nil {
			return fmt.Errorf("create %q: %w", folder, err)
		}
	}
	if len(files) == 0 {
		report("Created %d remote directories.", len(folders))
		return nil
	}
	partSlots := make(chan struct{}, o.concurrency)
	largeFile := make(chan struct{}, 1)
	return parallel(ctx, o.concurrency, files, func(ctx context.Context, f source) error {
		if f.size >= 50*mib {
			if err := takeSlot(ctx, largeFile); err != nil {
				return err
			}
			defer func() { <-largeFile }()
		}
		return uploadFile(ctx, c, s, config, f, o, partSlots)
	})
}

func takeSlot(ctx context.Context, slots chan struct{}) error {
	select {
	case slots <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func openSource(name string) (*os.File, error) {
	fd, err := syscall.Open(name, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), name)
	return f, nil
}

func scanSource(ctx context.Context, f *os.File, p *uploadPlan) ([]part, error) {
	wholeMD5, wholeSHA := md5.New(), sha256.New()
	parts := make([]part, 0, (p.Size+p.PartSize-1)/p.PartSize)
	for offset := int64(0); offset < p.Size; offset += p.PartSize {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		n := min(p.PartSize, p.Size-offset)
		partMD5 := md5.New()
		if _, err := io.CopyN(io.MultiWriter(wholeMD5, wholeSHA, partMD5), f, n); err != nil {
			return nil, err
		}
		parts = append(parts, part{PartNumber: len(parts) + 1, ETag: hex.EncodeToString(partMD5.Sum(nil)), Size: n})
	}
	p.MD5, p.SHA256 = hex.EncodeToString(wholeMD5.Sum(nil)), hex.EncodeToString(wholeSHA.Sum(nil))
	return parts, nil
}

func sameSource(f *os.File, before os.FileInfo) error {
	after, err := f.Stat()
	if err != nil {
		return err
	}
	if after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		return errors.New("local file changed during upload")
	}
	return nil
}

func uploadFile(ctx context.Context, c *client, s session, config string, file source, o options, slots chan struct{}) error {
	err := uploadFileTask(ctx, c, s, config, file, o, slots)
	if err != nil {
		return fmt.Errorf("upload %q: %w", file.remote, err)
	}
	return nil
}

func uploadFileTask(ctx context.Context, c *client, s session, config string, file source, o options, slots chan struct{}) error {
	dir := filepath.Join(config, "uploads")
	key := keyOf(c.server, strconv.FormatInt(s.UserID, 10), file.remote)
	unlock, err := lockFile(dir, key)
	if err != nil {
		return err
	}
	defer unlock()
	checkpoint := filepath.Join(dir, key+".json")
	var previous uploadPlan
	err = loadPrivate(checkpoint, &previous)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err == nil && (!taskIDPattern.MatchString(previous.ID) || previous.PartSize < 5*mib || previous.PartSize > 50*mib) {
		return errors.New("invalid upload checkpoint")
	}
	f, err := openSource(file.local)
	if err != nil {
		return err
	}
	defer f.Close()
	before, err := f.Stat()
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() || before.Size() != file.size {
		return errors.New("local file changed before upload")
	}
	plan := uploadPlan{Path: file.remote, Size: file.size, PartSize: o.partSize}
	if previous.ID != "" {
		plan.ID, plan.PartSize = previous.ID, previous.PartSize
	}
	parts, err := scanSource(ctx, f, &plan)
	if err != nil {
		return err
	}
	if err := sameSource(f, before); err != nil {
		return err
	}
	if previous.ID != "" && (previous.SHA256 != plan.SHA256 || previous.Size != plan.Size) {
		var old task
		err := c.json(ctx, http.MethodGet, "/tasks/"+previous.ID, nil, nil, &old)
		if !hasStatus(err, 404) && (err != nil || old.State != "aborted" && old.State != "done") {
			return fmt.Errorf("local content changed while task %s still exists. Check ol status before resuming", previous.ID)
		}
		plan.ID = ""
	}
	var t task
	for range 2 {
		if plan.ID == "" {
			plan.ID, err = taskID()
			if err != nil {
				return err
			}
		}
		if err := savePrivate(checkpoint, plan); err != nil {
			return err
		}
		err = c.json(ctx, http.MethodPost, "/tasks", nil, plan, &t)
		if hasStatus(err, 412) {
			if matched, statErr := verifyExisting(ctx, c, plan); statErr == nil && matched {
				report("Verified existing Google Drive file %q", file.remote)
				return os.Remove(checkpoint)
			}
			return errors.New("a different or unverifiable file already exists in Google Drive")
		}
		if err != nil {
			return err
		}
		if t.ID != plan.ID {
			return errors.New("server returned a different task ID")
		}
		if t.State != "aborted" {
			break
		}
		if t.Error != "" {
			_ = os.Remove(checkpoint)
			return fmt.Errorf("task %s failed and R2 was cleaned: %s", t.ID, t.Error)
		}
		plan.ID = ""
	}
	if t.State == "aborted" {
		return errors.New("upload task was cancelled. Run the upload again")
	}
	if t.State == "done" {
		ok, err := verifyExisting(ctx, c, plan)
		if err != nil {
			if hasStatus(err, 404) {
				_ = os.Remove(checkpoint)
			}
			return err
		}
		if !ok {
			_ = os.Remove(checkpoint)
			return errors.New("Drive file has changed since this task completed")
		}
	}
	route := "/tasks/" + plan.ID
	report("%s  %s  %q", plan.ID, t.phase(), file.remote)
	if t.State == "open" {
		if err := sendParts(ctx, c, f, route, plan, parts, slots, o.concurrency); err != nil {
			return err
		}
		if err := sameSource(f, before); err != nil {
			return err
		}
		if err := c.json(ctx, http.MethodPost, route+"/complete", nil, map[string]any{"parts": parts, "size": plan.Size}, &t); err != nil {
			return err
		}
	}
	if err := waitTask(ctx, c, route, file.remote, t); err != nil {
		if hasCode(err, "FailedAndCleaned") {
			_ = os.Remove(checkpoint)
		}
		return err
	}
	return os.Remove(checkpoint)
}

func statRemote(ctx context.Context, c *client, p string) (entry, error) {
	var e entry
	err := c.json(ctx, http.MethodGet, "/stat", url.Values{"path": {p}}, nil, &e)
	return e, err
}

func verifyExisting(ctx context.Context, c *client, plan uploadPlan) (bool, error) {
	e, err := statRemote(ctx, c, plan.Path)
	if err != nil || e.IsDir || e.Size == nil || *e.Size != plan.Size {
		return false, err
	}
	if e.SHA256 != "" {
		return strings.EqualFold(e.SHA256, plan.SHA256), nil
	}
	return strings.EqualFold(e.MD5, plan.MD5), nil
}

func sendParts(ctx context.Context, c *client, file *os.File, route string, plan uploadPlan, parts []part, slots chan struct{}, concurrency int) error {
	var existing []remotePart
	if err := c.json(ctx, http.MethodGet, route+"/parts", nil, nil, &existing); err != nil {
		return err
	}
	remote := make(map[int]remotePart, len(existing))
	for _, p := range existing {
		remote[p.PartNumber] = p
	}
	var reused int64
	var pending []part
	for _, p := range parts {
		if have := remote[p.PartNumber]; p.ETag == have.ETag && p.Size == have.Size {
			reused += p.Size
			continue
		}
		pending = append(pending, p)
	}
	progress := newProgress(fileLabel("R2", plan.Path), plan.Size, reused)
	if reused > 0 {
		report("Reusing %s of verified R2 parts for %q", byteUnits(reused), plan.Path)
	}
	err := parallel(ctx, concurrency, pending, func(ctx context.Context, p part) error {
		return retry(ctx, func() error {
			if err := takeSlot(ctx, slots); err != nil {
				return err
			}
			defer func() { <-slots }()
			requestCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
			defer cancel()
			section := io.NewSectionReader(file, int64(p.PartNumber-1)*plan.PartSize, p.Size)
			var sent int64
			var mu sync.Mutex
			active, confirmed := true, false
			body := countedReader{section, func(n int) {
				mu.Lock()
				defer mu.Unlock()
				if active {
					sent += int64(n)
					progress.add(int64(n))
				}
			}}
			defer func() {
				mu.Lock()
				defer mu.Unlock()
				active = false
				if !confirmed {
					progress.add(-sent)
				}
			}()
			response, err := c.request(requestCtx, http.MethodPut, route+"/parts/"+strconv.Itoa(p.PartNumber),
				nil, body, p.Size, http.Header{"x-ol-md5": {p.ETag}, "Content-Type": {"application/octet-stream"}})
			if err != nil {
				return err
			}
			defer response.Body.Close()
			got, err := decodePart(response)
			if err != nil {
				return err
			}
			if got.PartNumber != p.PartNumber || got.ETag != p.ETag || got.Size != p.Size {
				return errors.New("R2 returned an unexpected part checksum or length")
			}
			confirmed = true
			return nil
		})
	})
	if err == nil {
		progress.print(true)
	}
	return err
}

func decodePart(response *http.Response) (remotePart, error) {
	var got remotePart
	if err := json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(&got); err != nil {
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			return got, io.ErrUnexpectedEOF
		}
		return got, errors.New("invalid upload part response")
	}
	return got, nil
}

func waitTask(ctx context.Context, c *client, route, remote string, t task) error {
	last := ""
	delay := 2 * time.Second
	var drive *progress
	driveFinished := false
	for {
		phase := t.phase()
		if phase != last {
			report("%s  %s  %q", t.ID, phase, remote)
			last = phase
		}

		// These are Google Drive bytes reported by the Worker, not bytes
		// uploaded to R2. Repeated polls never increment the progress.
		if t.Size > 0 && ((t.State == "staged" && t.Transferring) ||
			t.State == "verified" || t.State == "done") {
			if drive == nil {
				drive = newProgress(fileLabel("Drive", remote), t.Size, t.Offset)
			}
			if t.State == "verified" || t.State == "done" {
				if !driveFinished {
					drive.set(t.Size, true)
					driveFinished = true
				}
			} else {
				drive.set(t.Offset, false)
			}
		}
		switch t.State {
		case "done":
			return nil
		case "aborted":
			if t.Error != "" {
				return &apiError{Status: 409, Code: "FailedAndCleaned", Message: t.Error}
			}
			return errors.New("upload was cancelled")
		case "failed":
			return fmt.Errorf("task %s failed: %s", t.ID, t.Error)
		}
		if err := waitForStatusPoll(ctx, delay, t, remote); err != nil {
			return err
		}
		var next task
		if err := c.json(ctx, http.MethodGet, route, nil, nil, &next); err != nil {
			return err
		}
		t = next
		delay = min(15*time.Second, delay*2)
	}
}

func waitForStatusPoll(ctx context.Context, delay time.Duration, t task, remote string) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	waiting := t.State == "sealing" || t.State == "verified" ||
		t.State == "aborting" || (t.State == "staged" && !t.Transferring)
	if !interactiveProgress || !waiting {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return nil
		}
	}
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	label := fileLabel(t.phase(), remote)
	waitingProgress(label, 0)
	frame := 1
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return nil
		case <-ticker.C:
			waitingProgress(label, frame)
			frame++
		}
	}
}
