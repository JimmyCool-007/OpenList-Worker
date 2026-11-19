package main

import (
	"fmt"
	"math"
	"os"
	"strings"
	"time"
)

const (
	downloadBoxMinColumns = 32
	downloadBoxMaxWidth   = 96
	downloadBoxHeight     = 5 // borders + two content rows + separator
)

// These fields are protected by outputMu, alongside activeProgressLine.
var activeBoxLines int

// A frame always consists of five physical terminal lines. Every line is
// shorter than the PTY's reported width, including on MobaXterm: redraw can
// move up exactly five rows without leaving wrapped status text behind.
func boxWidth(columns int) int {
	return min(downloadBoxMaxWidth, max(6, columns-2))
}

func boxRow(content string, width int) string {
	inside := width - 4
	content = trimCells(content, inside)
	return "│ " + content + strings.Repeat(" ", inside-terminalCells(content)) + " │"
}

func boxedDownloadRows(first, second string, columns int) []string {
	w := boxWidth(columns)
	return []string{
		"┌" + strings.Repeat("─", w-2) + "┐",
		boxRow(first, w),
		"├" + strings.Repeat("─", w-2) + "┤",
		boxRow(second, w),
		"└" + strings.Repeat("─", w-2) + "┘",
	}
}

func boxTitle(verb, label string, total int64, inside int) string {
	// Remote file paths were validated, but also guard against control
	// characters so a filename cannot inject terminal cursor sequences.
	label = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 || r == 0x9b {
			return ' '
		}
		return r
	}, label)
	left := verb + label
	right := byteUnits(total)
	if inside-terminalCells(right) < 12 {
		return trimCells(left, inside)
	}
	available := inside - terminalCells(right) - 2
	left = trimCells(left, available)
	return left + strings.Repeat(" ", inside-terminalCells(left)-terminalCells(right)) + right
}

func formatDownloadBox(label string, total int64, fraction float64, speed, eta string, columns int) []string {
	width := boxWidth(columns)
	inside := width - 4
	name := strings.TrimPrefix(label, "Download ")
	title := boxTitle("下载: ", name, total, inside)
	fraction = math.Max(0, math.Min(1, fraction))
	percent := fmt.Sprintf("%.0f%%", fraction*100)
	prefix := "进度: "
	suffixes := []string{
		"  " + percent + "  " + speed + "/s  ETA " + eta,
		"  " + percent + "  " + speed + "/s",
		"  " + percent + "  ETA " + eta,
		"  " + percent,
	}
	// Prefer all metrics; progressively drop lower-priority fields when
	// narrow PTYs cannot display a useful progress bar alongside them.
	const minBar = 6
	suffix := suffixes[len(suffixes)-1]
	for _, s := range suffixes {
		if terminalCells(prefix)+terminalCells(s)+minBar+2 <= inside {
			suffix = s
			break
		}
	}
	barWidth := min(24, inside-terminalCells(prefix)-terminalCells(suffix)-2)
	var status string
	if barWidth < minBar {
		status = trimCells(prefix+percent, inside)
	} else {
		filled := min(barWidth, max(0, int(math.Floor(fraction*float64(barWidth)))))
		bar := strings.Repeat("=", filled)
		if filled < barWidth {
			bar += ">" + strings.Repeat("-", barWidth-filled-1)
		}
		status = prefix + "[" + bar + "]" + suffix
	}
	return boxedDownloadRows(title, status, columns)
}

func formatElapsed(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	seconds := int64(d.Round(time.Second) / time.Second)
	return fmt.Sprintf("%02d:%02d:%02d", seconds/3600, (seconds/60)%60, seconds%60)
}

func formatDownloadCompleted(name string, size int64, elapsed time.Duration, columns int) []string {
	inside := boxWidth(columns) - 4
	title := boxTitle("下载完成: ", name, size, inside)
	average := int64(0)
	if elapsed > 0 {
		average = int64(float64(size) / elapsed.Seconds())
	}
	timeLabel := "耗时: " + formatElapsed(elapsed)
	details := []string{
		timeLabel + "  平均速度: " + byteUnits(average) + "/s  已校验",
		timeLabel + "  已校验",
		"已下载并校验",
	}
	for _, s := range details {
		if terminalCells(s) <= inside {
			return boxedDownloadRows(title, s, columns)
		}
	}
	return boxedDownloadRows(title, trimCells(details[len(details)-1], inside), columns)
}

// Cursor is left immediately after a newline following the bottom border.
// Erasing and moving up five physical rows makes repeated draws in-place.
func eraseProgressLocked() {
	if activeBoxLines != 0 {
		fmt.Fprintf(os.Stderr, "\r\x1b[%dA\x1b[J", activeBoxLines)
		activeBoxLines = 0
	}
	if activeProgressLine {
		fmt.Fprint(os.Stderr, "\r\x1b[2K")
		activeProgressLine = false
	}
}

func drawDownloadBox(rows []string) {
	outputMu.Lock()
	defer outputMu.Unlock()
	eraseProgressLocked()
	fmt.Fprintln(os.Stderr, strings.Join(rows, "\n"))
	activeBoxLines = len(rows)
}

// A download has been checksummed and atomically published. Replace its
// in-flight box with a final black-and-white two-row summary. Do not claim
// completion from the 100% transfer callback, before checksum verification.
func downloadFinished(name string, total int64, elapsed time.Duration) {
	if !interactiveProgress || terminalColumns() < downloadBoxMinColumns {
		report("Downloaded and verified %q (%s)", name, byteUnits(total))
		return
	}
	outputMu.Lock()
	defer outputMu.Unlock()
	eraseProgressLocked()
	fmt.Fprintln(os.Stderr, strings.Join(formatDownloadCompleted(name, total, elapsed, terminalColumns()), "\n"))
	// Keep the completed box visible. The next transfer starts a fresh box.
}

func (p *progress) drawBox(now time.Time) {
	fraction := 1.0
	if p.total > 0 {
		fraction = float64(p.done) / float64(p.total)
	}
	elapsed := max(.001, now.Sub(p.start).Seconds())
	speed := int64(float64(max(0, p.done-p.base)) / elapsed)
	eta := "--"
	if speed > 0 && p.done < p.total {
		eta = (time.Duration(float64(p.total-p.done) / float64(speed)) * time.Second).Round(time.Second).String()
	} else if p.done >= p.total {
		eta = "0s"
	}
	drawDownloadBox(formatDownloadBox(p.label, p.total, fraction, byteUnits(speed), eta, terminalColumns()))
}
