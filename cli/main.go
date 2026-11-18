package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

var version = "dev"

const (
	mib      int64 = 1 << 20
	maxFile  int64 = 5_000_000_000
	maxParts       = 8
)

const usage = "OpenList CLI\n\n" +
	"  ol login [--server https://drive.jimmy007.com]\n" +
	"  ol logout | whoami | version | help\n" +
	"  ol ls [remote-directory]\n" +
	"  ol upload local-path [--to remote] [--concurrency 3] [--part-size 50MiB]\n" +
	"  ol download remote-path [--to local] [--concurrency 3]\n" +
	"  ol status [task-id]\n" +
	"  ol cancel task-id\n"

type options struct {
	arg, to, server string
	concurrency     int
	partSize        int64
}

func parseOptions(command string, args []string) (options, error) {
	o := options{server: defaultServer, concurrency: 3, partSize: 50 * mib}
	flags := true
	for len(args) > 0 {
		arg := args[0]
		args = args[1:]
		if flags && arg == "--" {
			flags = false
			continue
		}
		if !flags || !strings.HasPrefix(arg, "--") {
			if o.arg != "" || arg == "" {
				return o, errors.New("expected one path or task ID")
			}
			o.arg = arg
			continue
		}
		name, value, assigned := strings.Cut(arg, "=")
		if !assigned {
			if len(args) == 0 || strings.HasPrefix(args[0], "--") {
				return o, fmt.Errorf("%s requires a value", name)
			}
			value, args = args[0], args[1:]
		}
		if value == "" {
			return o, fmt.Errorf("%s requires a value", name)
		}
		switch {
		case name == "--to" && (command == "upload" || command == "download"):
			o.to = value
		case name == "--server" && command == "login":
			o.server = value
		case name == "--concurrency" && (command == "upload" || command == "download"):
			n, err := strconv.Atoi(value)
			if err != nil || n < 1 || n > maxParts {
				return o, errors.New("concurrency must be between 1 and 8")
			}
			o.concurrency = n
		case name == "--part-size" && command == "upload":
			n, err := strconv.ParseInt(strings.TrimSuffix(strings.ToLower(value), "mib"), 10, 64)
			if err != nil || n < 5 || n > 50 {
				return o, errors.New("part size must be 5–50 MiB. Example: --part-size 25MiB")
			}
			o.partSize = n * mib
		default:
			return o, fmt.Errorf("unsupported option %s", name)
		}
	}
	switch command {
	case "upload", "download", "cancel":
		if o.arg == "" {
			return o, errors.New("a path or task ID is required")
		}
	case "ls", "status":
	default:
		if o.arg != "" {
			return o, errors.New("this command takes no positional arguments")
		}
	}
	return o, nil
}

type identity struct {
	UserID    int64
	Username  string
	ExpiresAt int64
	Root      string
	Token     string
}

type entry struct {
	Name, MD5, SHA256, Version string
	Size                       *int64
	IsDir                      bool
}

type task struct {
	ID, Path, State, Error string
	Bytes, Size, Offset    int64
	Transferring           bool
}

func (t task) phase() string {
	switch t.State {
	case "creating", "putting", "open":
		return "uploading to R2"
	case "sealing":
		return "completing R2 multipart"
	case "staged":
		if t.Transferring {
			return "transferring to Google Drive"
		}
		return "R2 upload complete, queued for Google Drive"
	case "verified":
		return "Google Drive verified, R2 cleanup pending"
	case "done":
		return "Google Drive verified, R2 cleaned"
	case "failed":
		return "failed"
	case "aborted":
		if t.Error != "" {
			return "failed, R2 cleaned"
		}
		return "cancelled, R2 cleaned"
	case "aborting":
		return "cleaning R2"
	default:
		return t.State
	}
}

func printTask(t task) {
	fmt.Printf("%s  %s  %q", t.ID, t.phase(), t.Path)
	if t.Size > 0 {
		fmt.Printf("  Drive %s / %s", byteUnits(t.Offset), byteUnits(t.Size))
	}
	if t.Error != "" {
		fmt.Printf("  %s", t.Error)
	}
	fmt.Println()
}

func safeComponent(name string) bool {
	if name == "" || name == "." || name == ".." || !utf8.ValidString(name) ||
		strings.ContainsAny(name, "/\\") || strings.Contains(name, "...") {
		return false
	}
	for i := 0; i < len(name); i++ {
		if name[i] < 32 || name[i] == 127 {
			return false
		}
		if name[i] == '%' && i+2 < len(name) && strings.ContainsRune("0123456789abcdefABCDEF", rune(name[i+1])) &&
			strings.ContainsRune("0123456789abcdefABCDEF", rune(name[i+2])) {
			return false
		}
	}
	return true
}

func remotePath(input string) (string, error) {
	p := strings.TrimSuffix(input, "/")
	if input == "" {
		return "", nil
	}
	for _, name := range strings.Split(p, "/") {
		if !safeComponent(name) {
			return "", errors.New("invalid Drive path. Use a path relative to the Drive root")
		}
	}
	return p, nil
}

func terminalInput(ctx context.Context, tty *os.File, reader *bufio.Reader, label string, hide bool) (string, error) {
	fmt.Fprint(tty, label)
	if hide {
		var original syscall.Termios
		if err := terminalMode(tty, syscall.TCGETS, &original); err != nil {
			return "", err
		}
		hidden := original
		hidden.Lflag &^= syscall.ECHO | syscall.ECHONL
		if err := terminalMode(tty, syscall.TCSETS, &hidden); err != nil {
			return "", err
		}
		defer func() {
			_ = terminalMode(tty, syscall.TCSETS, &original)
			fmt.Fprintln(tty)
		}()
	}
	type result struct {
		line string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		line, err := reader.ReadString('\n')
		done <- result{strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r"), err}
	}()
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case r := <-done:
		return r.line, r.err
	}
}

func login(ctx context.Context, file string, server string) error {
	c, err := newClient(server, "")
	if err != nil {
		return err
	}
	if _, err := os.Lstat(file); err == nil {
		current, err := loadSession(file, false)
		if err != nil {
			return err
		}
		if current.ExpiresAt > time.Now().UnixMilli() {
			return errors.New("this server already has a local session. Run ol logout before logging in again")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return errors.New("ol login requires an interactive terminal")
	}
	defer tty.Close()
	reader := bufio.NewReader(tty)
	fmt.Fprintf(tty, "OpenList CLI\n\nServer: %s\n\n", c.server)
	username, err := terminalInput(ctx, tty, reader, "Username: ", false)
	if err != nil {
		return err
	}
	password, err := terminalInput(ctx, tty, reader, "Password: ", true)
	if err != nil {
		return err
	}
	input := map[string]string{"username": strings.TrimSpace(username), "password": password}
	var result identity
	err = c.json(ctx, http.MethodPost, "/login", nil, input, &result)
	if hasCode(err, "OTPRequired") {
		input["otp_code"], err = terminalInput(ctx, tty, reader, "One-time code: ", true)
		if err == nil {
			err = c.json(ctx, http.MethodPost, "/login", nil, input, &result)
		}
	}
	if err != nil {
		return err
	}
	if !tokenPattern.MatchString(result.Token) || result.ExpiresAt <= time.Now().UnixMilli() {
		return errors.New("server returned an invalid session")
	}
	c.token = result.Token
	if err := savePrivate(file, session{c.server, result.Token, result.UserID, result.ExpiresAt}); err != nil {
		if revokeErr := c.json(ctx, http.MethodPost, "/logout", nil, nil, nil); revokeErr != nil {
			return fmt.Errorf("could not save session or revoke it on the server: %w", err)
		}
		return err
	}
	fmt.Println("Login successful. Session expires in 30 days.")
	return nil
}

func logout(ctx context.Context, c *client, file string) error {
	if err := c.json(ctx, http.MethodPost, "/logout", nil, nil, nil); err != nil {
		return fmt.Errorf("could not confirm session revocation. Local session retained: %w", err)
	}
	if err := os.Remove(file); err != nil {
		return err
	}
	fmt.Println("Logged out. Session revoked.")
	return nil
}

func parallel[T any](ctx context.Context, max int, items []T, job func(context.Context, T) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	work := make(chan T)
	var wg sync.WaitGroup
	var once sync.Once
	var first error
	for range min(max, len(items)) {
		wg.Go(func() {
			for item := range work {
				if ctx.Err() != nil {
					return
				}
				if err := job(ctx, item); err != nil {
					once.Do(func() { first = err; cancel() })
					return
				}
			}
		})
	}
dispatch:
	for _, item := range items {
		select {
		case <-ctx.Done():
			break dispatch
		case work <- item:
		}
	}
	close(work)
	wg.Wait()
	if first != nil {
		return first
	}
	return ctx.Err()
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 || (len(args) == 1 && (args[0] == "help" || args[0] == "--help" || args[0] == "-h")) {
		fmt.Print(usage)
		return nil
	}
	command := args[0]
	if len(args) == 2 && (args[1] == "--help" || args[1] == "-h") {
		fmt.Print(usage)
		return nil
	}
	o, err := parseOptions(command, args[1:])
	if err != nil {
		return err
	}
	switch command {
	case "version", "--version":
		fmt.Println("ol " + version)
		return nil
	case "login", "logout", "whoami", "ls", "status", "cancel", "upload", "download":
	default:
		return errors.New("unknown command. Run ol help")
	}
	dir, err := configDir()
	if err != nil {
		return err
	}
	file := filepath.Join(dir, "session.json")
	if command == "login" || command == "logout" {
		unlock, err := lockFile(dir, "session")
		if err != nil {
			return err
		}
		defer unlock()
	}
	if command == "login" {
		return login(ctx, file, o.server)
	}
	if command == "logout" {
		if _, err := os.Lstat(file); os.IsNotExist(err) {
			fmt.Println("Already logged out.")
			return nil
		}
	}
	s, err := loadSession(file, command != "logout")
	if err != nil {
		return err
	}
	c, err := newClient(s.Server, s.Token)
	if err != nil {
		return err
	}
	switch command {
	case "logout":
		return logout(ctx, c, file)
	case "whoami":
		var me identity
		if err := c.json(ctx, http.MethodGet, "/whoami", nil, nil, &me); err != nil {
			return err
		}
		fmt.Printf("%s (user %d)\nServer: %s\nDrive root: %s\nSession expires: %s\n",
			me.Username, me.UserID, c.server, me.Root, time.UnixMilli(me.ExpiresAt).Local().Format(time.RFC3339))
	case "ls":
		p, err := remotePath(o.arg)
		if err != nil {
			return err
		}
		return eachPage(ctx, c, "/list", p, func(item entry) error {
			size := "-"
			if item.Size != nil {
				size = byteUnits(*item.Size)
			}
			fmt.Printf("%10s  %q\n", size, item.Name+map[bool]string{true: "/"}[item.IsDir])
			return nil
		})
	case "status", "cancel":
		if o.arg == "" {
			return eachPage(ctx, c, "/tasks", "", func(item task) error {
				printTask(item)
				return nil
			})
		}
		if !taskIDPattern.MatchString(o.arg) {
			return errors.New("invalid task ID")
		}
		if command == "cancel" {
			if err := c.json(ctx, http.MethodPost, "/tasks/"+o.arg+"/cancel", nil, nil, nil); err != nil {
				return err
			}
			fmt.Printf("Cancelled %s. R2 staging released.\n", o.arg)
			return nil
		}
		var t task
		if err := c.json(ctx, http.MethodGet, "/tasks/"+o.arg, nil, nil, &t); err != nil {
			return err
		}
		printTask(t)
	case "upload":
		return upload(ctx, c, s, dir, o)
	case "download":
		return download(ctx, c, s, dir, o)
	}
	return nil
}

func byteUnits(size int64) string {
	switch {
	case size >= 1<<30:
		return fmt.Sprintf("%.1f GiB", float64(size)/(1<<30))
	case size >= mib:
		return fmt.Sprintf("%.1f MiB", float64(size)/float64(mib))
	case size >= 1024:
		return fmt.Sprintf("%.1f KiB", float64(size)/1024)
	default:
		return fmt.Sprintf("%d B", size)
	}
}

var outputMu sync.Mutex

func report(format string, args ...any) {
	outputMu.Lock()
	defer outputMu.Unlock()
	if activeProgressLine {
		fmt.Fprint(os.Stderr, "\r\x1b[2K")
		activeProgressLine = false
	}
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		clearProgressLine()
		if errors.Is(err, io.EOF) {
			err = errors.New("input ended")
		}
		fmt.Fprintln(os.Stderr, "ol:", err)
		os.Exit(1)
	}
}
