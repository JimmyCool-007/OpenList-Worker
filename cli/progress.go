package main

import (
	"fmt"
	"io"
	"math"
	"os"
	"strings"
	"sync"
	"time"
)

const progressWidth = 18

// An interactive terminal gets one in-place line; redirected output stays
// line-oriented so logs remain readable in containers and CI.
var interactiveProgress = func() bool {
	info, err := os.Stderr.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0 &&
		os.Getenv("TERM") != "" && os.Getenv("TERM") != "dumb"
}()

var activeProgressLine bool // protected by outputMu (in main.go)

func progressLine(line string, finish bool) {
	outputMu.Lock()
	defer outputMu.Unlock()
	if interactiveProgress {
		fmt.Fprint(os.Stderr, "\r\x1b[2K", line)
		if finish {
			fmt.Fprintln(os.Stderr)
			activeProgressLine = false
		} else {
			activeProgressLine = true
		}
		return
	}
	fmt.Fprintln(os.Stderr, line)
}

// Clear the live status before reporting errors (which are printed directly
// by main) or exiting a cancelled transfer.
func clearProgressLine() {
	outputMu.Lock()
	defer outputMu.Unlock()
	if activeProgressLine {
		fmt.Fprint(os.Stderr, "\r\x1b[2K")
		activeProgressLine = false
	}
}

// The finalizing and cleanup stages have no measurable percentage. Animate
// those stages only on a terminal rather than inventing a progress fraction.
func waitingProgress(label string, frame int) {
	if !interactiveProgress {
		return
	}
	frames := []string{"|", "/", "-", "\\"}
	progressLine(fmt.Sprintf("%s  %s", compactLabel(label), frames[frame%len(frames)]), false)
}

func compactLabel(label string) string {
	const limit = 37
	r := []rune(label)
	if len(r) <= limit {
		return label
	}
	return string(r[:13]) + "…" + string(r[len(r)-(limit-14):])
}

type progress struct {
	mu          sync.Mutex
	label       string
	total, base int64
	done        int64
	start, last time.Time
}

func newProgress(label string, total, already int64) *progress {
	now := time.Now()
	total = max(0, total)
	already = min(total, max(0, already))
	p := &progress{label: label, total: total, base: already, done: already, start: now, last: now}
	if interactiveProgress {
		p.last = time.Time{}
		p.print(false)
	}
	return p
}

func (p *progress) add(bytes int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.done = min(p.total, max(0, p.done+bytes))
	p.renderLocked(false)
}

// set reports server-side Google Drive bytes, not bytes sent to R2.
// It prevents repeated status polls from inflating the total.
func (p *progress) set(bytes int64, force bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.done = min(p.total, max(0, bytes))
	p.renderLocked(force)
}

func (p *progress) print(force bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.renderLocked(force)
}

func (p *progress) renderLocked(force bool) {
	now := time.Now()
	interval := 2 * time.Second
	if interactiveProgress {
		interval = 200 * time.Millisecond
	}
	if !force && now.Sub(p.last) < interval {
		return
	}
	p.last = now
	progressLine(p.format(now), force)
}

func (p *progress) format(now time.Time) string {
	total := max(0, p.total)
	done := min(total, max(0, p.done))
	fraction := 1.0
	if total != 0 {
		fraction = float64(done) / float64(total)
	}
	filled := min(progressWidth, max(0, int(math.Round(fraction*progressWidth))))
	bar := strings.Repeat("█", filled) + strings.Repeat("░", progressWidth-filled)
	elapsed := max(0.001, now.Sub(p.start).Seconds())
	speed := int64(float64(max(0, done-p.base)) / elapsed)
	eta := "--"
	if speed > 0 && done < total {
		remaining := time.Duration(float64(total-done) / float64(speed) * float64(time.Second))
		eta = remaining.Round(time.Second).String()
	} else if done == total {
		eta = "0s"
	}
	return fmt.Sprintf("%s  [%s] %3.0f%%  %s/%s  %s/s  ETA %s",
		compactLabel(p.label), bar, 100*fraction,
		byteUnits(done), byteUnits(total), byteUnits(speed), eta)
}

type countedReader struct {
	r    io.Reader
	step func(int)
}

func (r countedReader) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	r.step(n)
	return n, err
}

func fileLabel(operation, remote string) string {
	return fmt.Sprintf("%s %q", operation, remote)
}
