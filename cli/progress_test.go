package main

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestLiveProgressFitsNarrowSSHWindows(t *testing.T) {
	labels := []string{
		`Download "test-500mb.bin"`,
		`Download "datasets/very-long-directory-name/very-long-file-name-500mb.bin"`,
		`Download "数据集/测试🙂/五百兆.bin"`,
	}
	for _, label := range labels {
		for _, columns := range []int{6, 12, 20, 24, 32, 40, 60, 80, 100, 120, 160} {
			for _, fraction := range []float64{0, 0.48, 1} {
				line := formatLiveProgress(label, fraction,
					"231.1 MiB", "476.8 MiB", "2.1 MiB", "1m55s", columns)
				if n := terminalCells(line); n > max(1, columns-2) {
					t.Errorf("width %d, label %q: line used %d cells: %q", columns, label, n, line)
				}
				if !utf8.ValidString(line) || strings.ContainsAny(line, "\r\n\x1b") {
					t.Errorf("invalid progress display: %q", line)
				}
				if columns >= 40 && fraction == 0.48 && !strings.Contains(line, "48%") {
					t.Errorf("percentage missing at width %d: %q", columns, line)
				}
			}
		}
	}
}

func TestNarrowProgressAdaptsStatus(t *testing.T) {
	label := `Download "test-500mb.bin"`
	full := formatLiveProgress(label, .48, "231.1 MiB", "476.8 MiB", "2.1 MiB", "1m55s", 160)
	if !strings.Contains(full, "ETA 1m55s") || !strings.Contains(full, "231.1 MiB/476.8 MiB") {
		t.Errorf("wide terminal lost transfer metrics: %q", full)
	}
	narrow := formatLiveProgress(label, .48, "231.1 MiB", "476.8 MiB", "2.1 MiB", "1m55s", 40)
	if !strings.Contains(narrow, "48%") || !strings.Contains(narrow, "[") {
		t.Errorf("narrow terminal lost progress bar or percent: %q", narrow)
	}
}

func TestTerminalCellWidthsAndTrim(t *testing.T) {
	if got := terminalCells("测试🙂a\u0301"); got != 7 {
		t.Fatalf("expected 7 cells, got %d", got)
	}
	for _, columns := range []int{2, 5, 12, 30} {
		line := fitTerminalLine("Download 数据集/🙂/test-500mb.bin  [████████░░░]  50%", columns)
		if terminalCells(line) > max(1, columns-2) {
			t.Fatalf("terminal width %d overflow: %q", columns, line)
		}
		if !utf8.ValidString(line) {
			t.Fatalf("invalid UTF-8 after trim: %q", line)
		}
	}
}
