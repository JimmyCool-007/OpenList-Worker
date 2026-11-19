package main

import (
	"os"
	"strconv"
	"syscall"
	"unsafe"
)

// terminalColumns reads the actual PTY width, which is updated by SSH when
// MobaXterm or another terminal is resized. COLUMNS is only a fallback.
func terminalColumns() int {
	var size struct {
		rows, cols, xpixel, ypixel uint16
	}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, os.Stderr.Fd(),
		uintptr(syscall.TIOCGWINSZ), uintptr(unsafe.Pointer(&size)))
	if errno == 0 && size.cols > 0 {
		return int(size.cols)
	}
	if value, err := strconv.Atoi(os.Getenv("COLUMNS")); err == nil && value > 0 {
		return value
	}
	// Prefer a compact fallback over the old unbounded 100+ column line.
	return 72
}
