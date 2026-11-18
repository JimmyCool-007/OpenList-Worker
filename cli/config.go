package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
	"time"
	"unsafe"
)

type session struct {
	Server    string
	Token     string
	UserID    int64
	ExpiresAt int64
}

var tokenPattern = regexp.MustCompile("^ol_[0-9a-f]{64}$")

func configDir() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "ol"), nil
}

func privateDir(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !fi.IsDir() || fi.Mode().Perm()&0077 != 0 || fi.Sys().(*syscall.Stat_t).Uid != uint32(os.Getuid()) {
		return fmt.Errorf("%s must be a private directory owned by this user (chmod 700)", dir)
	}
	return nil
}

func loadPrivate(path string, out any) error {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return &os.PathError{Op: "open", Path: path, Err: err}
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	fi, err := file.Stat()
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() || fi.Mode().Perm() != 0600 || fi.Sys().(*syscall.Stat_t).Uid != uint32(os.Getuid()) {
		return errors.New("configuration must be a regular file owned by this user with permissions 0600")
	}
	return json.NewDecoder(io.LimitReader(file, 65536)).Decode(out)
}

func savePrivate(path string, data any) error {
	dir := filepath.Dir(path)
	if err := privateDir(dir); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	err = json.NewEncoder(file).Encode(data)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return err
	}
	directory, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func loadSession(path string, checkExpiry bool) (session, error) {
	var s session
	if err := loadPrivate(path, &s); err != nil {
		if os.IsNotExist(err) {
			return s, errors.New("run ol login")
		}
		return s, err
	}
	if !tokenPattern.MatchString(s.Token) {
		return s, errors.New("invalid local session. Run ol login")
	}
	if checkExpiry && time.Now().UnixMilli() >= s.ExpiresAt {
		return s, errors.New("session expired. Run ol login")
	}
	return s, nil
}

func taskID() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	id[6] = id[6]&0x0f | 0x40
	id[8] = id[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:]), nil
}

func keyOf(parts ...string) string {
	h := sha256.New()
	for _, part := range parts {
		fmt.Fprintf(h, "%d:", len(part))
		io.WriteString(h, part)
	}
	return hex.EncodeToString(h.Sum(nil))
}

func lockFile(dir, key string) (func(), error) {
	if err := privateDir(dir); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, key+".lock")
	fd, err := syscall.Open(path, syscall.O_CREAT|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		syscall.Close(fd)
		return nil, errors.New("another ol process is working on the same destination")
	}
	return func() { syscall.Close(fd) }, nil
}

func terminalMode(file *os.File, request uintptr, mode *syscall.Termios) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), request, uintptr(unsafe.Pointer(mode)))
	if errno != 0 {
		return errno
	}
	return nil
}
