package main

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestDownloadBoxMonochromeTwoRowsAndFitsTerminal(t *testing.T) {
	for _, width := range []int{32, 36, 40, 60, 80, 100, 160} {
		for _, label := range []string{
			`Download "test-500mb.bin"`,
			`Download "dataset/very-long-name-500mb.bin"`,
			`Download "数据集/模型🙂.bin"`,
		} {
			for _, fraction := range []float64{0, 0.667, 1} {
				frame := formatDownloadBox(label, 500000000, fraction, "2.1 MiB", "1m55s", width)
				if len(frame) != downloadBoxHeight {
					t.Fatalf("expected exactly two content rows and three border rows, got %d", len(frame))
				}
				for i, row := range frame {
					if !utf8.ValidString(row) || strings.ContainsAny(row, "\r\n\x1b") {
						t.Fatalf("invalid frame line %d: %q", i, row)
					}
					if got := terminalCells(row); got != boxWidth(width) || got > width-2 {
						t.Errorf("line %d uses %d cells at terminal width %d: %q", i, got, width, row)
					}
				}
				if !strings.HasPrefix(frame[0], "┌") || !strings.HasPrefix(frame[1], "│") ||
					!strings.HasPrefix(frame[2], "├") || !strings.HasPrefix(frame[3], "│") ||
					!strings.HasPrefix(frame[4], "└") {
					t.Errorf("unexpected box frame: %q", frame)
				}
				if !strings.Contains(frame[3], "进度:") || !strings.Contains(frame[3], "%") {
					t.Errorf("missing percentage or label: %q", frame[3])
				}
				if strings.Contains(strings.Join(frame, ""), "已校验") {
					t.Error("unverified in-flight transfer must not display verified status")
				}
			}
		}
	}
}

func TestDownloadBoxMetricsAndCompletedState(t *testing.T) {
	running := formatDownloadBox(`Download "test-500mb.bin"`, 500000000, .664, "2.1 MiB", "1m55s", 100)
	if !strings.Contains(running[1], "test-500mb.bin") ||
		!strings.Contains(running[1], "476.8 MiB") ||
		!strings.Contains(running[3], "66%") ||
		!strings.Contains(running[3], "2.1 MiB/s") ||
		!strings.Contains(running[3], "ETA 1m55s") {
		t.Fatalf("wide terminal lost key progress fields: %q", running)
	}
	done := formatDownloadCompleted("test-500mb.bin", 500000000, 3*time.Minute+2*time.Second, 100)
	if !strings.Contains(done[1], "下载完成:") ||
		!strings.Contains(done[3], "00:03:02") ||
		!strings.Contains(done[3], "平均速度:") ||
		!strings.Contains(done[3], "已校验") {
		t.Fatalf("completion UI missing verified summary: %q", done)
	}
}

func TestDownloadBoxSanitizesTerminalControls(t *testing.T) {
	frame := formatDownloadBox("Download test\x1b[31mfile\n.bin", 100, .5, "1 B", "1s", 80)
	if strings.Contains(strings.Join(frame, ""), "\x1b") ||
		strings.Contains(frame[1], "\n") {
		t.Fatalf("filename was allowed to inject terminal controls: %q", frame)
	}
}

func TestDownloadBoxElapsed(t *testing.T) {
	for _, tc := range []struct {
		duration time.Duration
		want     string
	}{
		{-time.Second, "00:00:00"},
		{59 * time.Second, "00:00:59"},
		{time.Hour + time.Minute + 2*time.Second, "01:01:02"},
	} {
		if got := formatElapsed(tc.duration); got != tc.want {
			t.Errorf("formatElapsed(%v)=%q want %q", tc.duration, got, tc.want)
		}
	}
}
