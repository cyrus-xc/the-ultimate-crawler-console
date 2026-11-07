package crawler

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
)

const DiagnosticsVersion = "crawler_diagnostics_v1"

type documentTiming struct {
	Path        string `json:"path"`
	RequestedAt string `json:"requested_at"`
	ResponseAt  string `json:"response_at,omitempty"`
	HTTPStatus  int    `json:"http_status,omitempty"`
}

type readDiagnostic struct {
	BrowserRestarts    int                           `json:"browser_restarts"`
	NetworkRetries     int                           `json:"network_retries,omitempty"`
	BrowserLaunches    int                           `json:"browser_launches"`
	BrowserLaunchWhy   string                        `json:"browser_launch_reason,omitempty"`
	Version            string                        `json:"version"`
	EngineStartedAt    string                        `json:"engine_started_at"`
	EngineFinishedAt   string                        `json:"engine_finished_at"`
	BrowserReadyAt     string                        `json:"browser_ready_at,omitempty"`
	NetworkRequests    int                           `json:"network_requests"`
	Documents          []documentTiming              `json:"documents"`
	DocumentsTruncated bool                          `json:"documents_truncated"`
	Access             *xiaohongshu.AccessDiagnostic `json:"access,omitempty"`
}

type diagnosticError struct {
	cause      error
	diagnostic readDiagnostic
}

func (e *diagnosticError) Error() string { return e.cause.Error() }
func (e *diagnosticError) Unwrap() error { return e.cause }

func ErrorDiagnostics(err error) any {
	var e *diagnosticError
	if errors.As(err, &e) {
		return e.diagnostic
	}
	return nil
}

type readTrace struct {
	mu       sync.Mutex
	d        readDiagnostic
	requests map[proto.NetworkRequestID]int
}

func newReadTrace() *readTrace {
	return &readTrace{d: readDiagnostic{Version: DiagnosticsVersion, EngineStartedAt: stamp(), Documents: []documentTiming{}}, requests: map[proto.NetworkRequestID]int{}}
}
func stamp() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func (t *readTrace) requested(e *proto.NetworkRequestWillBeSent) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.d.NetworkRequests++
	if e.Type != proto.NetworkResourceTypeDocument || e.Request == nil {
		return
	}
	if len(t.d.Documents) >= 16 {
		t.d.DocumentsTruncated = true
		return
	}
	// Redirect responses belong to the previous request with the same ID.
	if i, ok := t.requests[e.RequestID]; ok && e.RedirectResponse != nil {
		t.d.Documents[i].HTTPStatus = e.RedirectResponse.Status
		t.d.Documents[i].ResponseAt = stamp()
	}
	t.requests[e.RequestID] = len(t.d.Documents)
	requestedAt := stamp()
	if e.WallTime > 0 {
		requestedAt = e.WallTime.Time().UTC().Format(time.RFC3339Nano)
	}
	t.d.Documents = append(t.d.Documents, documentTiming{Path: xiaohongshu.DiagnosticPath(e.Request.URL), RequestedAt: requestedAt})
}
func (t *readTrace) responded(e *proto.NetworkResponseReceived) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if i, ok := t.requests[e.RequestID]; ok && e.Response != nil {
		t.d.Documents[i].HTTPStatus = e.Response.Status
		t.d.Documents[i].ResponseAt = stamp()
	}
}
func (t *readTrace) attach(page *rod.Page) func() {
	ctx, cancel := context.WithCancel(page.GetContext())
	// Enable the domain before collection starts, so a reused tab's document
	// requests are measured as well as requests on a newly created page.
	_ = (proto.NetworkEnable{}).Call(page.Context(ctx))
	wait := page.Context(ctx).EachEvent(t.requested, t.responded)
	t.mu.Lock()
	t.d.BrowserReadyAt = stamp()
	t.mu.Unlock()
	done := make(chan struct{})
	go func() { defer close(done); wait() }()
	return func() { cancel(); <-done }
}
func (t *readTrace) finish(err error) readDiagnostic {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.d.EngineFinishedAt = stamp()
	var access *xiaohongshu.AccessError
	if errors.As(err, &access) {
		t.d.Access = &access.Diagnostic
	}
	return t.d
}
