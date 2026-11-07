package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/browser"
	"github.com/xpzouying/xiaohongshu-mcp/configs"
	"github.com/xpzouying/xiaohongshu-mcp/cookies"
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
)

func main() {
	// A server without a display (the HPC) logs in headless: the QR code is
	// written to -qr-out whenever it changes and the person scans that image
	// with the XHS app. The session is the same as a visible login.
	headless := flag.Bool("headless", false, "run without a window and write the login QR code to -qr-out")
	qrOut := flag.String("qr-out", "", "PNG path for the login QR code (headless); a page screenshot goes beside it")
	check := flag.String("check", "", "do not log in: open the saved session headless on this URL (e.g. a profile), print whether it is logged in and what page XHS served, and write a screenshot to -qr-out")
	flag.Parse()
	if *check != "" {
		os.Exit(checkSession(*check, *qrOut))
	}
	if *headless && *qrOut == "" {
		logrus.Fatal("-headless needs -qr-out so the QR code can be scanned")
	}
	os.Exit(login(*headless, *qrOut))
}

// Exit codes of a login. Only exitSaved means a new session was written; the
// callers (tools/crawler_setup.py) record a login only then.
const (
	exitSaved    = 0
	exitNotSaved = 3
	exitOverseas = 4
)

// saveLogin keeps the session that just passed WaitForLogin only when
// LoginAction.UsableSession found nothing wrong. An overseas (non-+86) account
// would otherwise be saved and surface later as CRAWLER_RELOGIN_REQUIRED.
func saveLogin(unusable error, save func() error) int {
	if unusable != nil {
		logrus.Errorf("会话不可用，未保存: %v", unusable)
		if errors.Is(unusable, xiaohongshu.ErrOverseasLogin) {
			return exitOverseas
		}
		return exitNotSaved
	}
	if err := save(); err != nil {
		logrus.Errorf("保存登录失败: %v", err)
		return exitNotSaved
	}
	return exitSaved
}

func login(headless bool, qrOut string) int {
	// 登录与后续运行共用同一个 seed：首次登录生成并写入会话文件，之后一直复用。
	store := cookies.NewLoadCookie(cookies.GetCookiesFilePath())

	b := browser.NewBrowser(headless,
		browser.WithFingerprintSeed(configs.ResolveFingerprintSeed(store)),
		browser.WithProxy(configs.ProxyFromEnv()),
	)
	defer b.Close()

	page := b.NewPage()
	defer page.Close()

	action := xiaohongshu.NewLogin(page)

	// 只导航一次，保留用户正在处理的扫码或手机验证页面。
	for attempt := 0; attempt < 3; attempt++ {
		if err := page.Navigate("https://www.xiaohongshu.com/explore"); err == nil {
			break
		}
		time.Sleep(2 * time.Second)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	if qrOut != "" {
		logrus.Infof("无头登录：二维码写入 %s，请用小红书 App 扫码（15分钟）", qrOut)
		go exportQRCode(ctx, page, qrOut)
	} else {
		logrus.Info("等待用户在可见窗口中完成登录和验证（15分钟）")
	}
	if !action.WaitForLogin(ctx) {
		logrus.Error("登录未完成")
		return exitNotSaved
	}
	if code := saveLogin(action.UsableSession(ctx), func() error { return saveCookies(page) }); code != exitSaved {
		return code
	}
	logrus.Info("登录成功，已保存会话")
	recordAccount(page, action)
	time.Sleep(2 * time.Second)
	return exitSaved
}

// checkSession opens the saved session (NewBrowser loads cookies.json) without a
// window on target and reports what XHS served: logged in or not, the final
// path, the title and which platform notice is on the page. It reads no data
// and prints no cookie; exit 0 = logged in and not blocked, 3 = not.
func checkSession(target, shot string) int {
	store := cookies.NewLoadCookie(cookies.GetCookiesFilePath())
	b := browser.NewBrowser(true,
		browser.WithFingerprintSeed(configs.ResolveFingerprintSeed(store)),
		browser.WithProxy(configs.ProxyFromEnv()),
	)
	defer b.Close()
	page := b.NewPage()
	defer page.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := page.Context(ctx).Navigate(target); err != nil {
		logrus.Errorf("打开失败: %v", err)
		return 3
	}
	_ = page.Context(ctx).WaitLoad()
	time.Sleep(4 * time.Second)
	// Judge the page that was asked for: CheckLoginStatus would navigate to
	// xiaohongshu.com/explore first and report on that instead.
	loggedIn, _ := xiaohongshu.NewLogin(page).AuthenticatedHere(ctx)
	result, err := page.Context(ctx).Eval(`() => [location.pathname, document.title, (document.body && document.body.innerText) || '', location.host]`)
	path, title, body, host := "", "", "", ""
	if err == nil {
		if v := result.Value.Arr(); len(v) == 4 {
			path, title, body, host = v[0].Str(), v[1].Str(), v[2].Str(), v[3].Str()
		}
	}
	notices := []string{}
	for _, phrase := range []string{"电脑设备登录超限", "安全限制", "访问频繁", "操作频繁", "请先登录", "登录后查看", "扫码登录", "账号异常", "违规"} {
		if strings.Contains(body, phrase) {
			notices = append(notices, phrase)
		}
	}
	out, _ := json.Marshal(map[string]any{"logged_in": loggedIn, "host": host, "path": path, "title": title, "notices": notices})
	os.Stdout.Write(append(out, '\n'))
	if shot != "" {
		if png, err := page.Context(ctx).Screenshot(false, nil); err == nil {
			_ = writeAtomic(shot, png)
		}
	}
	if loggedIn && len(notices) == 0 && !strings.Contains(path, "login") {
		return 0
	}
	return 3
}

// exportQRCode writes the login QR element to path whenever it changes (the
// site refreshes it), plus a full-page screenshot beside it so a verification
// step after the scan is visible too. Files are replaced atomically; nothing
// else about the session is written.
func exportQRCode(ctx context.Context, page *rod.Page, path string) {
	pagePath := strings.TrimSuffix(path, filepath.Ext(path)) + "-page.png"
	var last []byte
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		if el, err := page.Context(ctx).Timeout(2 * time.Second).Element(".login-container .qrcode-img"); err == nil {
			if png, err := el.Screenshot(proto.PageCaptureScreenshotFormatPng, 0); err == nil && !bytes.Equal(png, last) {
				if writeAtomic(path, png) == nil {
					last = png
					logrus.Infof("二维码已更新: %s", path)
				}
			}
		}
		if shot, err := page.Context(ctx).Screenshot(false, nil); err == nil {
			_ = writeAtomic(pagePath, shot)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func writeAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func saveCookies(page *rod.Page) error {
	cks, err := page.Browser().GetCookies()
	if err != nil {
		return err
	}

	data, err := json.Marshal(cks)
	if err != nil {
		return err
	}

	cookieLoader := cookies.NewLoadCookie(cookies.GetCookiesFilePath())
	return cookieLoader.SaveCookies(data)
}

// recordAccount saves which account just logged in (user id and nickname only,
// never a cookie) beside the cookie file. The crawler compares it with the
// previous login and stops instead of collecting with a different account
// (owner decision 2026-10-07). An unreadable user is recorded as unknown.
func recordAccount(page *rod.Page, action *xiaohongshu.LoginAction) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	// Reuse the page whose account state just passed WaitForLogin. Navigating
	// again can replace the verified state with an unhydrated/guest snapshot.
	record := map[string]any{"user_id": "", "nickname": "", "saved_at": float64(time.Now().UnixNano()) / 1e9}
	if user, err := action.CurrentUser(ctx); err == nil {
		record["user_id"], record["nickname"] = user.UserID, user.Nickname
	} else {
		logrus.Warnf("登录账号未识别: %v", err)
	}
	data, err := json.Marshal(record)
	if err != nil {
		return
	}
	path := filepath.Join(filepath.Dir(cookies.GetCookiesFilePath()), "login-account.json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err == nil {
		_ = os.Rename(tmp, path)
	}
}
