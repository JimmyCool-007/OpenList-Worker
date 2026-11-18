package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const defaultServer = "https://drive.jimmy007.com"

type client struct {
	server string
	token  string
	http   *http.Client
}

type apiError struct {
	Status  int
	Code    string
	Message string
}

func (e *apiError) Error() string {
	if e.Status == 401 && e.Code != "OTPRequired" && e.Code != "InvalidCredentials" {
		return "session expired or revoked. Run ol login"
	}
	return fmt.Sprintf("%s (HTTP %d)", e.Message, e.Status)
}

func hasStatus(err error, status int) bool {
	var api *apiError
	return errors.As(err, &api) && api.Status == status
}

func hasCode(err error, code string) bool {
	var api *apiError
	return errors.As(err, &api) && api.Code == code
}

func newClient(server, token string) (*client, error) {
	u, err := url.Parse(strings.TrimSpace(server))
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("server must be an HTTPS origin, such as " + defaultServer)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	transport.ResponseHeaderTimeout = 90 * time.Second
	transport.MaxIdleConnsPerHost = 16
	return &client{
		server: "https://" + u.Host, token: token,
		http: &http.Client{
			Transport: transport,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 5 || via[0].Method != http.MethodGet ||
					!strings.HasSuffix(via[0].URL.Path, "/download") ||
					req.URL.Scheme != "https" || req.URL.User != nil {
					return http.ErrUseLastResponse
				}
				// Even a same-origin download redirect only needs range negotiation.
				rangeHeader := req.Header.Get("Range")
				req.Header = make(http.Header)
				if rangeHeader != "" {
					req.Header.Set("Range", rangeHeader)
				}
				return nil
			},
		},
	}, nil
}

func (c *client) request(ctx context.Context, method, route string, query url.Values, body io.Reader, length int64, headers http.Header) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.server+"/api/cli/v1"+route, body)
	if err != nil {
		return nil, errors.New("could not construct request")
	}
	req.URL.RawQuery = query.Encode()
	req.ContentLength = length
	if headers != nil {
		req.Header = headers.Clone()
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// url.Error can contain a signed upstream URL in its string.
		var request *url.Error
		if errors.As(err, &request) {
			return nil, networkError{timeout: request.Timeout()}
		}
		return nil, networkError{}
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return resp, nil
	}
	defer resp.Body.Close()
	result := &apiError{Status: resp.StatusCode, Message: http.StatusText(resp.StatusCode)}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(result)
	result.Status = resp.StatusCode
	return nil, result
}

type networkError struct{ timeout bool }

func (e networkError) Error() string {
	if e.timeout {
		return "network request timed out"
	}
	return "network request failed"
}

func retryable(err error) bool {
	var api *apiError
	var network networkError
	var netErr net.Error
	if errors.As(err, &api) {
		return api.Status == 429 || api.Status == 408 || api.Status >= 500 ||
			api.Code == "OperationAborted"
	}
	return errors.As(err, &network) || errors.As(err, &netErr) ||
		errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, context.DeadlineExceeded)
}

func retry(ctx context.Context, operation func() error) error {
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		if err = ctx.Err(); err != nil {
			return err
		}
		err = operation()
		if err == nil || !retryable(err) || attempt == 4 {
			return err
		}
		delay := (time.Duration(1<<attempt) * 500 * time.Millisecond) + time.Duration(rand.IntN(500))*time.Millisecond
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return err
}

func (c *client) json(ctx context.Context, method, route string, query url.Values, input, output any) error {
	var payload []byte
	var err error
	if input != nil {
		payload, err = json.Marshal(input)
		if err != nil {
			return err
		}
	}
	perform := func() error {
		requestCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
		defer cancel()
		var body io.Reader
		if payload != nil {
			body = bytes.NewReader(payload)
		}
		resp, err := c.request(requestCtx, method, route, query, body, int64(len(payload)),
			http.Header{"Content-Type": {"application/json"}})
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if output == nil {
			if resp.StatusCode != http.StatusNoContent {
				return errors.New("unexpected server response. Verify that the Worker CLI API is deployed")
			}
			return nil
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(output); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return io.ErrUnexpectedEOF
			}
			return errors.New("invalid server response. Verify that the Worker CLI API is deployed")
		}
		return nil
	}
	// A lost login response can never be reused and login is rate limited.
	if route == "/login" {
		return perform()
	}
	return retry(ctx, perform)
}

type page[T any] struct {
	Entries []T
	Next    string
}

func eachPage[T any](ctx context.Context, c *client, route, remote string, visit func(T) error) error {
	var cursor string
	seen := make(map[string]bool)
	for {
		var result page[T]
		query := url.Values{"path": {remote}, "cursor": {cursor}}
		if err := c.json(ctx, http.MethodGet, route, query, nil, &result); err != nil {
			return err
		}
		for _, item := range result.Entries {
			if err := visit(item); err != nil {
				return err
			}
		}
		if result.Next == "" {
			return nil
		}
		if seen[result.Next] {
			return errors.New("server returned the same listing cursor twice")
		}
		cursor = result.Next
		seen[cursor] = true
	}
}
