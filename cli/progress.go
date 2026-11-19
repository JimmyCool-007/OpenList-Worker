package main

import (
	"fmt"
	"io"
	"math"
	"os"
	"strings"
	"sync"
	"time"
	"unicode"
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
		line = fitTerminalLine(line, terminalColumns())
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


// terminalCells counts display columns, not UTF-8 bytes or runes. Wide CJK
// and emoji glyphs commonly occupy two cells; combining marks occupy none.
// Overestimating joined emoji widths is safe: it leaves extra right margin.
func runeCells(r rune) int {
	if unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Me, r) || unicode.Is(unicode.Cf, r) {
		return 0
	}
	if r >= 0x1100 && (r <= 0x115f || r == 0x2329 || r == 0x232a ||
		(r >= 0x2e80 && r <= 0xa4cf && r != 0x303f) ||
		(r >= 0xac00 && r <= 0xd7a3) ||
		(r >= 0xf900 && r <= 0xfaff) ||
		(r >= 0xfe10 && r <= 0xfe19) ||
		(r >= 0xfe30 && r <= 0xfe6f) ||
		(r >= 0xff00 && r <= 0xff60) ||
		(r >= 0xffe0 && r <= 0xffe6) ||
		(r >= 0x1f300 && r <= 0x1faff) ||
		(r >= 0x20000 && r <= 0x3fffd)) {
		return 2
	}
	return 1
}

func terminalCells(s string) int {
	n := 0
	for _, r := range s {
		n += runeCells(r)
	}
	return n
}

// trimCells never cuts a UTF-8 sequence and reserves room for an ellipsis.
func trimCells(s string, maxCells int) string {
	if maxCells <= 0 {
		return ""
	}
	if terminalCells(s) <= maxCells {
		return s
	}
	if maxCells == 1 {
		return "…"
	}
	var b strings.Builder
	n := 0
	for _, r := range s {
		w := runeCells(r)
		if n+w > maxCells-1 {
			break
		}
		b.WriteRune(r)
		n += w
	}
	return b.String() + "…"
}

// Keep two spare columns: emitting into the final terminal column can cause
// immediate autowrap on some SSH terminals, breaking carriage-return redraws.
func fitTerminalLine(line string, columns int) string {
	return trimCells(line, max(1, columns-2))
}

// formatLiveProgress preserves the most useful status fields in narrow
// terminals, shrinks the label/bar, and never creates a wrapped progress line.
func formatLiveProgress(label string, fraction float64, done, total, speed, eta string, columns int) string {
	width := max(1, columns-2)
	pct := fmt.Sprintf("%.0f%%", 100*fraction)
	suffixes := []string{
		fmt.Sprintf("  %s  %s/%s  %s/s  ETA %s", pct, done, total, speed, eta),
		fmt.Sprintf("  %s  %s/%s  %s/s", pct, done, total, speed),
		fmt.Sprintf("  %s  %s/s  ETA %s", pct, speed, eta),
		fmt.Sprintf("  %s  ETA %s", pct, eta),
		"  " + pct,
	}
	suffix := suffixes[len(suffixes)-1]
	const minLabel = 9
	const minBar = 6
	// Prefer a full status and a meaningful bar, falling back to smaller
	// layouts only when the terminal cannot fit both.
	for _, candidate := range suffixes {
		if terminalCells(candidate)+minLabel+minBar+4 <= width {
			suffix = candidate
			break
		}
	}
	if terminalCells(suffix) >= width {
		return trimCells(pct, width)
	}
	if terminalCells(suffix)+minLabel+minBar+4 > width {
		// Ultra-narrow windows show the label and percentage without a bar.
		return trimCells(label, width-terminalCells(suffix)) + suffix
	}
	label = trimCells(label, width-terminalCells(suffix)-4-minBar)
	barWidth := min(progressWidth, width-terminalCells(label)-terminalCells(suffix)-4)
	filled := min(barWidth, max(0, int(math.Round(fraction*float64(barWidth)))))
	bar := strings.Repeat("█", filled) + strings.Repeat("░", barWidth-filled)
	return label + "  [" + bar + "]" + suffix
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
	if interactiveProgress {
		return formatLiveProgress(compactLabel(p.label), fraction,
			byteUnits(done), byteUnits(total), byteUnits(speed), eta, terminalColumns())
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
