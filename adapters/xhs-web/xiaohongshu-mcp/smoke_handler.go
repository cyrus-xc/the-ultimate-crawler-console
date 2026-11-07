package main

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xpzouying/xiaohongshu-mcp/crawler"
)

// smokeHandler 只读、串行的实验接口；所有原始证据由调用方保存。
func (s *AppServer) smokeHandler(c *gin.Context) {
	var req struct {
		Kind    string `json:"kind"`
		ID      string `json:"id"`
		Token   string `json:"xsec_token"`
		Target  int    `json:"target"`
		Seconds int    `json:"seconds"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.ID == "" {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}
	if req.Kind != "profile" && req.Kind != "detail" {
		c.JSON(400, gin.H{"error": "read-only operation required"})
		return
	}
	if req.Target <= 0 || req.Target > 100 {
		req.Target = 50
	}
	if req.Seconds <= 0 || req.Seconds > 90 {
		req.Seconds = 45
	}
	start := time.Now()
	data, err := readEvidence(c.Request.Context(), EvidenceArgs{Kind: req.Kind, ID: req.ID, Token: req.Token,
		Target: req.Target, Seconds: req.Seconds, Comments: req.Kind == "detail"})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"success": false, "error": crawler.ErrorCode(err), "elapsed_seconds": time.Since(start).Seconds()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": data, "elapsed_seconds": time.Since(start).Seconds()})
}
