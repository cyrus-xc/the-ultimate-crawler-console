// Package headless_browser provides a simple headless browser library powered by go-rod with built-in stealth mode support.
package headless_browser

import (
	"context"
	"encoding/json"
	"math/rand"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"github.com/go-rod/rod/lib/launcher/flags"
	"github.com/go-rod/rod/lib/proto"
	"github.com/go-rod/stealth"
	"github.com/sirupsen/logrus"
)

// Browser represents a headless browser instance with an underlying rod.Browser and launcher.
type Browser struct {
	browser           *rod.Browser
	launcher          *launcher.Launcher
	stealthJS         bool // NewPage 是否注入 go-rod/stealth 的 JS 补丁
	persistentProfile bool
	profileDir        string
	cancel            context.CancelFunc

	// uaOverride：每个新页面套用的一致 UA/Client-Hints 覆盖。
	// go-rod 建页面时 CloakBrowser 的 UA 版本补丁不激活（页面退回旧版 UA、uaFullVersion 空），
	// 这里用浏览器实读的真实版本 + 平台补丁实读的 platform 三项拼出自洽元数据补回。nil = 不覆盖。
	uaOverride *proto.NetworkSetUserAgentOverride
}

// Config holds the configuration options for the browser.
type Config struct {
	Headless      bool   // Whether to run browser in headless mode
	UserAgent     string // 自定义 UA。空 = 不覆盖，交给浏览器/指纹补丁自报（推荐，避免与 Client Hints 矛盾）
	Cookies       string // JSON string of cookies to set
	ChromeBinPath string // Custom Chrome/Chromium executable path
	UserDataDir   string // Explicit persistent profile; never removed by Close.
	Proxy         string // Proxy server URL (e.g. "http://host:port", "socks5://host:port")

	// Fingerprint 为 true 时，传入 CloakBrowser 的源码级指纹参数
	// （--fingerprint={seed} 与 --fingerprint-platform={platform}），激活其一致指纹引擎。
	// 仅对 CloakBrowser Chromium 有效；普通 Chrome 会忽略这些未知参数。
	Fingerprint         bool
	FingerprintPlatform string // 空 = 按运行 OS 自动：linux/windows→windows，darwin→macos
	FingerprintSeed     int    // 0 = 每次启动随机 seed

	// StealthJS 是否用 go-rod/stealth 注入 JS 指纹补丁。
	// 用 CloakBrowser 时应设为 false：源码级补丁已处理，再注入 JS 反而制造矛盾且本身可被检测。
	StealthJS bool

	// Language 覆盖 Accept-Language 与 navigator.languages（如 "zh-CN"）。空 = 不覆盖。
	// 仅在启用 Fingerprint 的一致 UA 覆盖时生效。
	Language string

	// ExtraFlags 透传任意浏览器启动 flag（如 fingerprint-chromium 的
	// "fingerprint-brand":"Chrome"、"fingerprint-hardware-concurrency":"8"）。
	// 键不带前导 "--"。
	ExtraFlags map[string]string

	Trace bool // Whether to enable tracing (not implemented yet)
}

// Option is a functional option for configuring the browser.
type Option func(*Config)

func WithUserDataDir(path string) Option { return func(c *Config) { c.UserDataDir = path } }

// newDefaultConfig returns a new Config with default values.
func newDefaultConfig() *Config {
	return &Config{
		Headless:      true,
		UserAgent:     "", // 默认不覆盖 UA
		Cookies:       "",
		ChromeBinPath: "", // Empty means auto-detect
		StealthJS:     true,
		Trace:         false,
	}
}

// WithHeadless sets whether the browser should run in headless mode.
func WithHeadless(headless bool) Option {
	return func(c *Config) {
		c.Headless = headless
	}
}

// WithUserAgent sets a custom user agent string for the browser.
// 注意：配合 CloakBrowser 使用时不建议设置，强制 UA 会与 Client Hints 产生矛盾。
func WithUserAgent(userAgent string) Option {
	return func(c *Config) {
		c.UserAgent = userAgent
	}
}

// WithCookies sets cookies for the browser from a JSON string.
// The cookies should be in the format expected by proto.NetworkCookie.
func WithCookies(cookies string) Option {
	return func(c *Config) {
		c.Cookies = cookies
	}
}

// WithChromeBinPath sets a custom Chrome/Chromium executable path.
// If not set or empty, launcher will auto-detect or download a browser.
// Common paths:
//   - macOS: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
//   - Linux: "/usr/bin/google-chrome" or "/usr/bin/chromium"
//   - Windows: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
func WithChromeBinPath(path string) Option {
	return func(c *Config) {
		c.ChromeBinPath = path
	}
}

// WithProxy sets a proxy server for all browser requests.
// Supports HTTP, HTTPS, and SOCKS5 proxies.
// Example: "http://proxy.example.com:8080", "socks5://127.0.0.1:1080"
//
// Note: Chrome's --proxy-server flag does not support embedded credentials
// (e.g. "http://user:pass@host:port"). For authenticated proxies, handle
// authentication separately at the page level.
func WithProxy(proxy string) Option {
	return func(c *Config) {
		c.Proxy = proxy
	}
}

// WithFingerprint 启用 CloakBrowser 源码级指纹引擎。
// platform 传空则按运行 OS 自动选择（Linux 服务器呈现 Windows 画像，mac 呈现 macOS）。
func WithFingerprint(platform string) Option {
	return func(c *Config) {
		c.Fingerprint = true
		c.FingerprintPlatform = platform
	}
}

// WithFingerprintSeed 固定指纹 seed（0 表示每次随机）。同一 seed 产出同一套一致指纹。
func WithFingerprintSeed(seed int) Option {
	return func(c *Config) {
		c.FingerprintSeed = seed
	}
}

// WithStealthJS 控制是否注入 go-rod/stealth 的 JS 补丁。用 CloakBrowser 时应传 false。
func WithStealthJS(enabled bool) Option {
	return func(c *Config) {
		c.StealthJS = enabled
	}
}

// WithLanguage 覆盖 Accept-Language 与 navigator.languages（如 "zh-CN"）。仅在启用 Fingerprint 时生效。
func WithLanguage(lang string) Option {
	return func(c *Config) {
		c.Language = lang
	}
}

// WithExtraFlags 透传任意浏览器启动 flag（键不带前导 "--"）。
func WithExtraFlags(flags map[string]string) Option {
	return func(c *Config) {
		c.ExtraFlags = flags
	}
}

func WithTrace() Option {
	return func(c *Config) {
		c.Trace = true
	}
}

// autoFingerprintPlatform 按运行 OS 返回 CloakBrowser 的指纹平台。
// Linux 服务器上呈现 Windows 画像（最常见的真实用户画像，且避免 Linux 桌面的稀有特征）。
func autoFingerprintPlatform() string {
	if runtime.GOOS == "darwin" {
		return "macos"
	}
	return "windows"
}

// New creates a new Browser instance with the provided options.
// It initializes a Chrome browser with stealth mode enabled.
func New(options ...Option) *Browser {
	cfg := newDefaultConfig()
	for _, option := range options {
		option(cfg)
	}
	if cfg.UserDataDir != "" {
		if pid, free := waitProfileReleased(cfg.UserDataDir, profileReleaseWait); !free {
			logrus.Warnf("[profile] SingletonLock still held by pid=%d after %s dir=%s", pid, profileReleaseWait, cfg.UserDataDir)
		}
	}

	startup, startupCancel := context.WithCancel(context.Background())
	startupTimer := time.AfterFunc(10*time.Second, startupCancel)
	defer startupTimer.Stop()
	l := launcher.New().Context(startup).
		Headless(cfg.Headless).
		Set("--no-sandbox")
	if cfg.UserDataDir != "" {
		l = l.UserDataDir(cfg.UserDataDir)
	}
	// Windows 直接启动浏览器，不使用被系统拦截的 leakless 辅助程序。
	if runtime.GOOS == "windows" {
		l = l.Leakless(false)
	}

	// 仅在显式指定 UA 时才覆盖，避免与 Client Hints 矛盾
	if cfg.UserAgent != "" {
		l = l.Set("user-agent", cfg.UserAgent)
	}

	// 传入 CloakBrowser 指纹参数以激活其源码级一致指纹引擎
	if cfg.Fingerprint {
		platform := cfg.FingerprintPlatform
		if platform == "" {
			platform = autoFingerprintPlatform()
		}
		seed := cfg.FingerprintSeed
		if seed == 0 {
			seed = rand.Intn(89999) + 10000 // 10000-99999
		}
		l = l.Set("fingerprint", strconv.Itoa(seed)).
			Set("fingerprint-platform", platform)
		logrus.Infof("fingerprint enabled: platform=%s seed=%d", platform, seed)
	}

	// 透传额外 flag（如 fingerprint-chromium 的 fingerprint-brand / hardware-concurrency）
	for k, v := range cfg.ExtraFlags {
		l = l.Set(flags.Flag(k), v)
	}

	// Set custom Chrome binary path if provided
	if cfg.ChromeBinPath != "" {
		l = l.Bin(cfg.ChromeBinPath)
	}

	// Set proxy server if provided
	if cfg.Proxy != "" {
		l = l.Proxy(cfg.Proxy)
	}

	url, launchErr := l.Launch()
	if launchErr != nil {
		startupCancel()
		terminateOwnedTree(l.PID())
		l.Kill()
		panic(launchErr)
	}
	completed := false
	defer func() {
		if !completed {
			startupCancel()
			terminateOwnedTree(l.PID())
			l.Kill()
		}
	}()

	browser := rod.New().
		ControlURL(url).
		Trace(cfg.Trace).
		Context(startup).
		MustConnect()

	// 加载 cookies
	if cfg.Cookies != "" {
		var cookies []*proto.NetworkCookie
		if err := json.Unmarshal([]byte(cfg.Cookies), &cookies); err != nil {
			logrus.Warnf("failed to unmarshal cookies: %v", err)
		} else {
			browser.MustSetCookies(cookies...)
		}
	}

	b := &Browser{
		browser:           browser,
		launcher:          l,
		stealthJS:         cfg.StealthJS,
		persistentProfile: cfg.UserDataDir != "",
		profileDir:        cfg.UserDataDir,
		cancel:            startupCancel,
	}

	// 启用指纹时，构建一致 UA 覆盖，补回 go-rod 建页面丢失的 UA 版本保真度
	if cfg.Fingerprint {
		if ov, err := buildUAOverride(browser, cfg.Language); err != nil {
			logrus.Warnf("build UA override failed, skip: %v", err)
		} else {
			b.uaOverride = ov
		}
	}

	completed = true
	return b
}

// buildUAOverride 用浏览器实读的真实版本补回 go-rod 建页面丢失的 UA 版本保真度。
//
// 分工：版本相关字段（UA 串、brands、fullVersionList、uaFullVersion）由本覆盖负责，
// 版本随 Browser.getVersion 实读、零硬编码（本机 145，Docker 146）；
// platform/platformVersion/architecture 等平台字段留空，交给 CloakBrowser「始终生效」的
// 源码级补丁在真实页面上填充（已验证：留空不会被覆盖，补丁按 --fingerprint-platform 给出
// 自洽的平台值，mac→macOS/arm，Docker→Windows）。这样本覆盖绝不与补丁的平台一致性冲突。
func buildUAOverride(browser *rod.Browser, language string) (*proto.NetworkSetUserAgentOverride, error) {
	ver, err := proto.BrowserGetVersion{}.Call(browser)
	if err != nil {
		return nil, err
	}
	fullVersion := strings.TrimPrefix(ver.Product, "Chrome/") // 如 145.0.7632.109
	major := fullVersion
	if i := strings.IndexByte(fullVersion, '.'); i > 0 {
		major = fullVersion[:i]
	}

	ov := &proto.NetworkSetUserAgentOverride{
		UserAgent: ver.UserAgent, // 浏览器真实 UA（正确平台+版本）
		UserAgentMetadata: &proto.EmulationUserAgentMetadata{
			Brands: []*proto.EmulationUserAgentBrandVersion{
				{Brand: "Not:A-Brand", Version: "99"},
				{Brand: "Google Chrome", Version: major},
				{Brand: "Chromium", Version: major},
			},
			FullVersionList: []*proto.EmulationUserAgentBrandVersion{
				{Brand: "Not:A-Brand", Version: "99.0.0.0"},
				{Brand: "Google Chrome", Version: fullVersion},
				{Brand: "Chromium", Version: fullVersion},
			},
			FullVersion: fullVersion,
			// 平台字段留空：交给 CloakBrowser 始终生效的补丁填充
		},
	}
	// Accept-Language 传不带 q 值的形式，否则 navigator.languages 会混入 "zh;q=0.9"
	if language != "" {
		ov.AcceptLanguage = language + "," + primaryLang(language)
	}

	logrus.Infof("UA coherence: version=%s", ver.Product)
	return ov, nil
}

// primaryLang 取语言主标签，如 "zh-CN" → "zh"。
func primaryLang(lang string) string {
	if i := strings.IndexByte(lang, '-'); i > 0 {
		return lang[:i]
	}
	return lang
}

// Close closes the browser and cleans up resources.
func (b *Browser) Close() {
	defer b.cancel()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := b.browser.Context(ctx).Close(); err != nil {
		terminateOwnedTree(b.launcher.PID())
		b.launcher.Kill()
	}
	b.release()
}

// ForceClose terminates only the browser launched by this instance, including
// its child processes. No CDP response is needed from a hung renderer/browser.
func (b *Browser) ForceClose() {
	b.cancel()
	terminateOwnedTree(b.launcher.PID())
	b.launcher.Kill()
	b.release()
}

// release returns once the browser no longer holds its profile: a closed
// browser exits asynchronously, and the next launch on a persistent profile
// must not meet it.
func (b *Browser) release() {
	if !b.persistentProfile {
		b.launcher.Cleanup()
		return
	}
	if pid, free := waitProfileReleased(b.profileDir, profileReleaseWait); !free {
		logrus.Warnf("[profile] browser closed but pid=%d still holds %s", pid, b.profileDir)
	}
}

// Alive reports whether the launched browser still answers on CDP. A browser
// that was killed outside this process (manual kill, crash, OOM, a stopped
// stage's leftover) still leaves a live launcher handle here, so the caller
// must not assume `b != nil` means the renderer works.
func (b *Browser) Alive() bool {
	if b == nil || b.browser == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := b.browser.Context(ctx).Version(); err != nil {
		return false
	}
	return true
}

func (b *Browser) Cookies(ctx context.Context) ([]byte, error) {
	values, err := b.browser.Context(ctx).GetCookies()
	if err != nil {
		return nil, err
	}
	return json.Marshal(values)
}

// NewPage creates a new page.
// 若启用 StealthJS 则注入 go-rod/stealth 补丁；否则返回普通页面（交给源码级指纹补丁）。
// 若配置了一致 UA 覆盖，则在返回前套用，补回 UA 版本保真度。
func (b *Browser) NewPage() *rod.Page {
	return b.NewPageContext(context.Background())
}

func (b *Browser) NewPageContext(ctx context.Context) *rod.Page {
	// Page event subscriptions must outlive the request that creates the tab.
	// Bound creation by cancelling this browser only if CDP stops responding.
	duration := 10 * time.Second
	if deadline, ok := ctx.Deadline(); ok {
		duration = time.Until(deadline)
	}
	var timedOut atomic.Bool
	timer := time.AfterFunc(duration, func() { timedOut.Store(true); b.cancel() })
	defer timer.Stop()
	defer func() {
		if v := recover(); v != nil {
			if timedOut.Load() {
				panic(context.DeadlineExceeded)
			}
			panic(v)
		}
	}()
	var page *rod.Page
	if b.stealthJS {
		page = stealth.MustPage(b.browser)
	} else {
		page = b.browser.MustPage()
	}

	if b.uaOverride != nil {
		if err := b.uaOverride.Call(page); err != nil {
			logrus.Warnf("apply UA override failed: %v", err)
		}
	}
	return page
}
