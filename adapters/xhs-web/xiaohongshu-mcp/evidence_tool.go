package main

import (
	"context"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/xpzouying/xiaohongshu-mcp/crawler"
)

type EvidenceArgs = crawler.Request

var evidenceEngine = crawler.New()

// MCP 只做协议适配，与独立命令使用同一采集引擎。
func readEvidence(ctx context.Context, req EvidenceArgs) (map[string]any, error) {
	if req.Target == 0 {
		req.Target = 50
	}
	if req.Seconds == 0 {
		req.Seconds = 45
	}
	return evidenceEngine.Read(ctx, req)
}
func registerEvidenceTool(server *mcp.Server) {
	mcp.AddTool(server, &mcp.Tool{Name: "read_evidence", Description: "Read raw XHS search, profile or note evidence with bounded comments; read-only.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: boolPtr(false)}}, withPanicRecovery("read_evidence", func(ctx context.Context, _ *mcp.CallToolRequest, args EvidenceArgs) (*mcp.CallToolResult, any, error) {
		data, err := readEvidence(ctx, args)
		return nil, data, err
	}))
}
