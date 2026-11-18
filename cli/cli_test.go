package main

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func testClient(t *testing.T, handler http.HandlerFunc) (*client, *httptest.Server) {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	c, err := newClient(server.URL, "ol_"+strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	c.http.Transport = server.Client().Transport
	return c, server
}

func sendJSON(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(data)
}

func TestSessionStorageAndLogout(t *testing.T) {
	var revoked bool
	var mu sync.Mutex
	c, server := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/api/cli/v1/logout" ||
			r.Header.Get("Authorization") != "Bearer ol_"+strings.Repeat("a", 64) {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		mu.Lock()
		revoked = true
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	dir, _ := configDir()
	file := filepath.Join(dir, "session.json")
	active := session{server.URL, c.token, 7, time.Now().Add(time.Hour).UnixMilli()}
	if err := savePrivate(file, active); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(file)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("session mode: %v %v", info, err)
	}
	got, err := loadSession(file, true)
	if err != nil || got != active {
		t.Fatalf("load session: %+v %v", got, err)
	}
	expired := active
	expired.ExpiresAt = time.Now().Add(-time.Hour).UnixMilli()
	if err := savePrivate(file, expired); err != nil {
		t.Fatal(err)
	}
	if _, err := loadSession(file, true); err == nil {
		t.Fatal("expired session accepted")
	}
	if err := logout(t.Context(), c, file); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if !revoked {
		t.Fatal("server did not receive revocation")
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("local session was not removed")
	}
}

func TestUploadTree(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "dataset")
	sub := filepath.Join(dir, "数据 集")
	if err := os.MkdirAll(sub, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "空文件"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sample"), []byte("a"), 0600); err != nil {
		t.Fatal(err)
	}
	files, folders, err := uploadTree(dir, "folder/")
	if err != nil || len(files) != 2 || len(folders) != 3 ||
		folders[0] != "folder" || folders[2] != "folder/dataset/数据 集" ||
		files[1].remote != "folder/dataset/数据 集/空文件" || files[1].size != 0 {
		t.Fatalf("upload tree: %+v %v %v", files, folders, err)
	}
	big := filepath.Join(dir, "sample")
	if err := os.Truncate(big, maxFile+1); err != nil {
		t.Fatal(err)
	}
	if _, _, err := uploadTree(dir, ""); err == nil {
		t.Fatal("accepted file above cap")
	}
}

// The Worker reads JSON properties with JavaScript destructuring, which is
// case-sensitive. A Go decoder alone would accept both "Path" and "path".
func TestUploadPlanMatchesWorkerJSONContract(t *testing.T) {
	want := uploadPlan{
		ID: "f1b0f4e4-4934-4411-a90d-0ed9e28d835f",
		Path: "Document/数据集.txt",
		MD5: strings.Repeat("a", 32),
		SHA256: strings.Repeat("b", 64),
		Size: 1024,
		PartSize: 50 * mib,
	}
	payload, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		t.Fatal(err)
	}
	required := []string{"id", "path", "md5", "sha256", "size", "partSize"}
	if len(fields) != len(required) {
		t.Fatalf("unexpected Worker upload JSON fields: %s", payload)
	}
	for _, key := range required {
		if _, ok := fields[key]; !ok {
			t.Fatalf("missing case-sensitive Worker property %q in %s", key, payload)
		}
	}
	var decodedPath string
	if err := json.Unmarshal(fields["path"], &decodedPath); err != nil || decodedPath != want.Path {
		t.Fatalf("incorrect remote path: %q %v", decodedPath, err)
	}
	// Existing checkpoints were written with Go's default upper-case keys.
	// They must remain readable after changing the JSON tags.
	var old uploadPlan
	legacy := `{"ID":"f1b0f4e4-4934-4411-a90d-0ed9e28d835f","Path":"Document/数据集.txt","MD5":"` + want.MD5 + `","SHA256":"` + want.SHA256 + `","Size":1024,"PartSize":52428800}`
	if err := json.Unmarshal([]byte(legacy), &old); err != nil || old != want {
		t.Fatalf("pre-fix checkpoint not compatible: %+v %v", old, err)
	}
}

func TestUploadTreeSingleFileDestination(t *testing.T) {
	file := filepath.Join(t.TempDir(), "数据 集.txt")
	if err := os.WriteFile(file, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ dest, want string }{
		{"", "数据 集.txt"},
		{"Document/", "Document/数据 集.txt"},
		{"Document/custom.txt", "Document/custom.txt"},
	} {
		files, folders, err := uploadTree(file, tc.dest)
		if err != nil || len(folders) != 0 && tc.dest == "" || len(files) != 1 || files[0].remote != tc.want {
			t.Fatalf("uploadTree(%q): files=%+v folders=%v err=%v", tc.dest, files, folders, err)
		}
	}
}

func TestMultipart300MiBResumeAndConflict(t *testing.T) {
	const total = 300 * mib
	const chunk = 50 * mib
	path := filepath.Join(t.TempDir(), "测试 300.bin")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := f.Truncate(total); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	committed := map[int]remotePart{}
	requested := map[int]int{}
	stop := true
	var taskName string
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		p := r.URL.Path
		switch {
		case p == "/api/cli/v1/tasks":
			data, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, "invalid body", 400)
				return
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(data, &fields); err != nil ||
				fields["id"] == nil || fields["path"] == nil ||
				fields["md5"] == nil || fields["sha256"] == nil ||
				fields["size"] == nil || fields["partSize"] == nil {
				http.Error(w, "upload payload does not match Worker JSON contract", 400)
				return
			}
			var plan uploadPlan
			if err := json.Unmarshal(data, &plan); err != nil || plan.Size != total || plan.PartSize != chunk {
				http.Error(w, "invalid plan", 400)
				return
			}
			if taskName != "" && taskName != plan.ID {
				http.Error(w, "idempotency key changed", 409)
				return
			}
			taskName = plan.ID
			sendJSON(w, task{ID: plan.ID, State: "open"})
		case strings.HasSuffix(p, "/parts"):
			out := make([]remotePart, 0, len(committed))
			for _, v := range committed {
				out = append(out, v)
			}
			sendJSON(w, out)
		case strings.Contains(p, "/parts/"):
			part, _ := strconv.Atoi(filepath.Base(p))
			requested[part]++
			if part == 2 && stop {
				http.Error(w, "simulated interruption", 400)
				return
			}
			h := md5.New()
			n, err := io.Copy(h, r.Body)
			sum := fmt.Sprintf("%x", h.Sum(nil))
			if err != nil || n != chunk || sum != r.Header.Get("x-ol-md5") {
				http.Error(w, "bad part", 400)
				return
			}
			committed[part] = remotePart{part, sum, n}
			sendJSON(w, committed[part])
		case strings.HasSuffix(p, "/complete"):
			var manifest struct {
				Parts []part
				Size  int64
			}
			_ = json.NewDecoder(r.Body).Decode(&manifest)
			if manifest.Size != total || len(manifest.Parts) != 6 || len(committed) != 6 {
				http.Error(w, "bad completion", 400)
				return
			}
			sendJSON(w, task{ID: taskName, State: "done", Size: total})
		default:
			http.Error(w, "unexpected route", 400)
		}
	})
	session := session{UserID: 5}
	config := t.TempDir()
	opt := options{concurrency: 1, partSize: chunk}
	src := source{path, "测试 300.bin", total}
	slots := make(chan struct{}, 1)
	if err := uploadFile(t.Context(), c, session, config, src, opt, slots); err == nil {
		t.Fatal("first attempt reported success")
	}
	mu.Lock()
	stop = false
	mu.Unlock()
	if err := uploadFile(t.Context(), c, session, config, src, opt, slots); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(committed) != 6 || requested[1] != 1 || requested[2] != 2 {
		t.Fatalf("parts did not resume: %v", requested)
	}
}

func TestRecursiveDownloadResumeAndRedirect(t *testing.T) {
	const body = "dataset file"
	var mu sync.Mutex
	var seenRange bool
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("Referer") != "" ||
			r.Header.Get("X-Ol-Version") != "" {
			t.Error("credential or version leaked to redirect")
		}
		if r.Header.Get("Range") == "" {
			w.Header().Set("Content-Length", strconv.Itoa(len(body)))
			fmt.Fprint(w, body[:5])
			return
		}
		if r.Header.Get("Range") != "bytes=5-" {
			t.Errorf("unexpected resumed range %q", r.Header.Get("Range"))
		}
		mu.Lock()
		seenRange = true
		mu.Unlock()
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 5-%d/%d", len(body)-1, len(body)))
		w.WriteHeader(http.StatusPartialContent)
		fmt.Fprint(w, body[5:])
	}))
	defer target.Close()
	file := entry{Name: "测试 file.txt", Version: "x:1", SHA256: fmt.Sprintf("%x", sha256.Sum256([]byte(body)))}
	size := int64(len(body))
	file.Size = &size
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/cli/v1/stat":
			sendJSON(w, entry{Name: "nested", IsDir: true})
		case "/api/cli/v1/list":
			sendJSON(w, page[entry]{Entries: []entry{file}})
		case "/api/cli/v1/download":
			if r.Header.Get("Authorization") == "" || r.Header.Get("X-Ol-Version") != file.Version {
				t.Error("missing request authentication or expected version")
			}
			http.Redirect(w, r, target.URL, 302)
		default:
			http.NotFound(w, r)
		}
	})
	dest := t.TempDir()
	if err := download(t.Context(), c, session{}, t.TempDir(), options{arg: "nested/", to: dest, concurrency: 2}); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dest, "nested", file.Name))
	if string(got) != body || err != nil {
		t.Fatalf("downloaded %q: %v", got, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if !seenRange {
		t.Fatal("download restarted instead of resuming")
	}
}

func TestUnsafeNamesAndDownloadRange(t *testing.T) {
	for _, name := range []string{"../escape", "/abs", "a/../b", "dir\\file", "%2f", "x...y", "dir//name"} {
		if _, err := remotePath(name); err == nil {
			t.Errorf("accepted invalid path %q", name)
		}
	}
	if correctRange("bytes 5-7/9", 5, 9) || !correctRange("bytes 5-8/9", 5, 9) {
		t.Fatal("accepted mismatched range")
	}
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		sendJSON(w, page[entry]{Entries: []entry{{Name: "../escape"}}})
	})
	err := downloadTree(context.Background(), c, downloadItem{remote: "root", local: "."}, new([]downloadItem), new([]string))
	if err == nil {
		t.Fatal("download planning accepted traversal")
	}
}
