package main

import (
	"fmt"
	"io"
	"sync"
	"time"
)

type progress struct {
	mu          sync.Mutex
	label       string
	total, base int64
	done        int64
	start, last time.Time
}

func newProgress(label string, total, already int64) *progress {
	now := time.Now()
	return &progress{label: label, total: total, base: already, done: already, start: now, last: now}
}

func (p *progress) add(bytes int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.done += bytes
	p.print(false)
}

func (p *progress) print(force bool) {
	now := time.Now()
	if !force && now.Sub(p.last) < 2*time.Second {
		return
	}
	p.last = now
	speed := int64(float64(max(0, p.done-p.base)) / max(0.001, now.Sub(p.start).Seconds()))
	eta := "-"
	if speed > 0 {
		eta = (time.Duration(float64(max(0, p.total-p.done))/float64(speed)*float64(time.Second))).Round(time.Second).String()
	}
	report("%s  %s / %s  %s/s  ETA %s", p.label, byteUnits(p.done), byteUnits(p.total), byteUnits(speed), eta)
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
