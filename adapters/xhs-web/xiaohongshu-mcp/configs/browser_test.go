package configs

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestFingerprintSeedFromEnv 校验 XHS_FP_SEED 解析：非法/非正数一律回退 0（随机）。
func TestFingerprintSeedFromEnv(t *testing.T) {
	tests := []struct {
		name string
		env  string
		want int
	}{
		{name: "未设返回0", env: "", want: 0},
		{name: "合法seed", env: "98759", want: 98759},
		{name: "非数字回退0", env: "abc", want: 0},
		{name: "零回退0", env: "0", want: 0},
		{name: "负数回退0", env: "-5", want: 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("XHS_FP_SEED", tt.env)
			assert.Equal(t, tt.want, FingerprintSeedFromEnv())
		})
	}
}

func TestProxyFromEnv(t *testing.T) {
	t.Run("未设为空", func(t *testing.T) {
		t.Setenv("XHS_PROXY", "")
		assert.Equal(t, "", ProxyFromEnv())
	})
	t.Run("读取代理地址", func(t *testing.T) {
		t.Setenv("XHS_PROXY", "socks5://127.0.0.1:1080")
		assert.Equal(t, "socks5://127.0.0.1:1080", ProxyFromEnv())
	})
}

// TestHeadfulFromEnv 校验 XHS_CRAWLER_HEADFUL 解析：默认无头，只有显式真值才可见。
func TestHeadfulFromEnv(t *testing.T) {
	for _, tt := range []struct {
		env  string
		want bool
	}{
		{env: "", want: false},
		{env: "false", want: false},
		{env: "true", want: true},
		{env: "TRUE", want: true},
		{env: "1", want: true},
		{env: "yes", want: true},
		{env: " on ", want: false},
	} {
		t.Setenv("XHS_CRAWLER_HEADFUL", tt.env)
		assert.Equal(t, tt.want, HeadfulFromEnv())
	}
}
