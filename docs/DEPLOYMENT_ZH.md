# 独立爬虫服务部署与恢复

更新：2026-11-08。本文描述当前代码和操作边界；服务能启动不等于所有平台已经通过真实采集验收。

## 两个仓库的职责

| 仓库 | 负责 | 不负责 |
| --- | --- | --- |
| `the-ultimate-crawler-console` | 持久化队列、调度、物理设备租约、平台消费者、浏览器/手机运行时、采集错误、断点、受控输入、屏幕源 | pipeline 业务筛选、基线政策、活动判断、最终报告、面向用户的前端 |
| `xhs-analysis` | 业务工作台、原证据/缓存读取、逐页业务决定、运行目录中的请求引用、爬虫控制台与鉴权代理 | queue 模式中的浏览器/ADB 重试、设备选择、旧原生 App 主动请求 |

新服务不写旧项目 canonical `data/`、`output/` 或 `casestudy/`。消费者复用现有登录态路径，不复制使用中的 Chromium profile；服务运行数据库和私有捕获写入自己的 `CRAWLER_RUNTIME_DIR`。API 不接受任意 pipeline 输出路径。

## 后端配置

systemd unit 使用 `EnvironmentFile` 读取私有 `.env`；直接运行 `npm start` **不会自行解析 `.env`**。凭证使用独立的权限为 0600 的文件，值至少 32 个字符，不写入源码、日志、命令行或文档。

| 配置 | 含义 |
| --- | --- |
| `CRAWLER_RUNTIME_DIR` | 后端私有 SQLite、状态、选择器和运行文件目录，使用绝对路径 |
| `CRAWLER_SERVICE_TOKEN_FILE` | 本地 API Bearer 凭证文件；pipeline 代理读取同一文件 |
| `CRAWLER_PORT` | loopback API，默认 `18323` |
| `CRAWLER_XHS_WEB_ENABLED` / `CRAWLER_DOUYIN_WEB_ENABLED` | 显式注册两个平台的 Web 消费者；值 `true` 或 `1` |
| `XHS_CRAWLER_BIN` | 从本仓库 `adapters/xhs-web/xiaohongshu-mcp/cmd/crawler` 构建的可执行文件；旧二进制不含分页和人工登录确认协议 |
| `XHS_BROWSER_PROFILE` / `COOKIES_PATH` / `XHS_BROWSER_CACHE` | 原 XHS 独立 profile、cookie 容器与浏览器缓存；可用绝对路径引用旧安装，但不导入旧项目代码 |
| `DOUYIN_BROWSER_PROFILE` | 与 XHS 不同的专用 Chromium profile；两者路径相同会拒绝注册 |
| `CRAWLER_BROWSER_EXECUTABLE` | Douyin Chromium 可执行文件；省略时从浏览器缓存解析 |
| `ENABLE_XHS_BROWSER_NETWORK` | XHS 免费浏览器采集开关；部署真实采集时设为 true，与两个付费 gate 无关 |
| `CRAWLER_ROOT_INPUT_SERIALS` | 可选、逗号分隔的明确 serial；只允许普通数字 input 遭 INJECT_EVENTS 拒绝后的受限模拟触摸，不允许安装绕过或 App 内部调用 |
| `CRAWLER_CHROME_MANIFEST_FILE` | 手机 Chrome 准备工具生成的私有 APK 摘要清单；只经固定 provisioning 接口安装，不复制账号数据 |
| `CRAWLER_PYTHON` | 安装 Playwright 和 requests 的 Python；匿名分享页同样使用它 |
| `CRAWLER_DESKTOP_DEPS` | 已安装 sway/wayvnc 的依赖根目录，含 `usr/bin`、`usr/lib` |
| `CRAWLER_DESKTOP_STATE_FILE` | 隐藏桌面的 `display.json`，通常为 `$CRAWLER_RUNTIME_DIR/desktop/display.json`；启动后端时读取 |
| `CRAWLER_WAYLAND_DISPLAY` / `XDG_RUNTIME_DIR` | 不使用状态文件时显式提供隐藏桌面 socket；消费者拒绝退回普通桌面 |
| `CRAWLER_DESKTOP_VNC_PORT` / `CRAWLER_VNC_PORT` | 前者供 desktop 脚本监听，后者供后端连接；两者必须相同，默认 `15910`，只监听 loopback |
| `CRAWLER_DEVICE_GATEWAY_ENABLED` | 启用手机输入网关和显式屏幕帧；未启用时不能注册手机消费者 |
| `CRAWLER_DEVICE_DISCOVERY_ENABLED` | 允许只读 `adb devices -l` 发现；仅发现不授予采集能力 |
| `CRAWLER_LEGACY_ANDROID_LOCK_DIR` | 必须是旧 `XHS_ANDROID_LOCK_DIR` 的绝对路径；兼容守护进程在此持有 `.worker.lock` |
| `ADB_PATH` | 主机 ADB 可执行文件，默认 `adb` |
| `CRAWLER_PHONE_ENABLED` / `CRAWLER_PHONE_CONFIG_FILE` | 显式启用及引用私有手机能力配置；只登记真实验证的操作 |

手机配置包含 `python`、本地 Frida `binary`、其 `sha256`、可选 `contractPath`，以及 `devices` 数组。每台设备提供显式 `serial`、经验证的 `operations`、搜索 `sorts`；`douyin_poi: true` 是单独能力声明。`ui_capabilities` 可逐项列出 `{platform, operation}`，只允许 XHS `place.search` 和 XHS/Douyin `post.detail` 的 `ui_identity` 表示；仅登记实际验证的项，不必同时开启两平台辅助能力。不要因为 ADB 可见就复制另一台手机的能力声明。运行时、App 版本、二进制摘要和响应身份检查仍会执行。

后端不使用付费采集补救。部署 unit 明确设置 `ENABLE_TIKHUB_NETWORK=0`、`ENABLE_LLM_NETWORK=0`；测试也强制关闭这两个 gate。

## pipeline 配置与默认切换

在 `xhs-analysis` 的运行环境设置：

```dotenv
CRAWLER_COLLECTION_BACKEND=queue
CRAWLER_DEVICE_LOCK_MODE=queue
CRAWLER_SERVICE_URL=http://127.0.0.1:18323
CRAWLER_SERVICE_TOKEN_FILE=/absolute/private/crawler-token
```

部署环境 `CRAWLER_COLLECTION_BACKEND=queue` 使正常的新采集进入队列，也覆盖历史配置里的 legacy 选择；`cache_only` 保留离线读取语义。也可在单个配置中使用 `collection_backend=queue`。单独改设备锁模式不会自动完成业务采集切换，两个开关都要核对。

服务不可达、能力不支持或租约丢失都返回明确错误，**不能退回本地浏览器、ADB、旧手机桥或付费 API**。旧 native_phone 配置只作兼容路由，不能重新启用 App 内部主动请求。匿名 XHS 分享页和短链也是服务消费者：它们读取公开 HTTP 响应，不启动浏览器、不携带账号 cookie，允许在严格 `LOGIN_REQUIRED` 平台故障下执行；验证码、风控、设备故障与隔离不被绕过。

pipeline 的逐页/逐条业务回调继续在原 Python 进程执行。服务持有断点并等待 continue/stop；`detail_ready` 的 `capture_share=false` 不是停止。跨设备恢复重放入口并去重，不共享不兼容的游标。

## 部署顺序

1. 确认两个仓库实际 branch/remote 和待部署提交，保留现有未提交业务修改。安装新服务 Node/Python 依赖并构建新 Go crawler。部署时使用本仓库的 `deploy/systemd/*.service`。
2. 暂停新任务入口，检查并等待旧 pipeline 采集和手动控制结束。停止旧手机桥。只停止已经确认归属的旧 crawler/浏览器进程；不使用 `killall`，不复制活跃 profile。
3. 启动/检查 `pipeline-crawler-desktop.service`，确认其 `display.json` 对应当前 sway socket。两个平台共享隐藏桌面，但使用独立 profile、浏览器进程和设备锁。
4. 启动 `ultimate-crawler.service`。手机网关先获得兼容锁，成功后才允许输入；发现设备与注册消费者是两步。检查 `/health` 和鉴权后的 `/v1/devices`，不要仅以进程存在判断可采集。
5. 在原 console 配置 queue 默认值，重启其 API/前端服务。确认状态代理可达、设备和错误可见，打开控制台本身不启动手机画面。
6. 在控制台完成平台登录/验证。Web 接管会同时取得两个 Web 租约，防止隐藏桌面焦点输入与自动采集并行。点击“我已处理”后，XHS 验证当前页面真实登录态并保存 cookie；Douyin 校验登录态。成功才清除本平台故障并写恢复事件，不能清除 quarantine。
7. 分别执行少量真实搜索、主页、详情和评论验证，再验证两个 Web 并行、至少两台实体手机并行、断线续接及人工接管。记录每项实际结果；不能用模拟测试替代真实登录或双实体设备验收。

只读服务检查可使用：

```sh
systemctl --user is-active pipeline-crawler-desktop.service ultimate-crawler.service
curl --fail --silent http://127.0.0.1:18323/health
```

不要把凭证插入可被 shell history 或进程列表记录的 curl 参数。敏感鉴权检查应由现有控制台代理或读取私有凭证文件的诊断程序完成，并仅输出脱敏状态。

## 屏幕与控制

手机画面当前是**显式请求的 PNG 帧，最高 2 fps**，不是 H.264 视频；前端每帧完成后至少等待 500 ms。无 viewer 请求不启动截图，多个 viewer 共享同设备在途帧和短缓存。切换页面、隐藏页面或停止串流会释放 viewer；服务 TTL 作为断网兜底，最后 viewer 离开会中止在途截图。

画面仅用于观看/控制，不用 OCR 替代内容数据获取。手机采集仍以正常 UI 动作触发请求，并读取匹配的结构化响应。控制需要独立的物理设备租约；观看不自动授权输入。群控仅向已选择且已取得控制的设备逐台发送操作，失败不会转而操作别的手机。

Web 画面经控制台的带票据 WebSocket 代理连接 loopback WayVNC。原始服务 token 不交给浏览器。接管期间全部 Web 租约持续续租；丢失租约就停止输入。单次打开/定位/确认操作也受租约守卫约束，释放必须等待操作和子进程完成清理。

## 正常关闭、崩溃与兼容锁

正常关闭停止接受新任务，断开控制与画面，drain 桌面动作、scheduler、所有 adapter、输入网关。没有错误或不确定远端状态时，释放仍有效的外部租约，再释放 guardian 兼容屏障。原未完成队列任务保留断点，不因正常关机被误记为采集完成。

两台手机各自有物理租约，兼容 guardian 仍只持有旧工具的一个全局锁。它的用途是阻止旧工具绕过新调度器；它**不是两台手机共用的一把工作锁**。队列消费者和已迁移的其他工具可以分别持有不同手机的租约并行。

服务异常退出时，独立 guardian 保留 `.worker.lock`。强制取消、孤儿 `device_commands` 或隔离状态同样要求恢复；本机 ADB 子进程退出不能证明手机端输入已经停止。错误会以 `DEVICE_RECOVERY_REQUIRED`、`LEGACY_WORKER_BUSY` 或 `LEGACY_LOCK_REQUIRES_RECOVERY` 等形式暴露。

恢复必须由操作员/受信 supervisor 确认对应输入进程已停止或实体设备已隔离，再处理那一次命令、过期租约与该设备 quarantine。保持其他设备、队列结果和断点不变。**不要直接删除 guardian 锁文件，不要凭 PID 消失、超时或 USB 重连自动清除隔离**。当前没有“一键抹掉所有锁”的恢复接口；源码中的受信恢复方法不能当作浏览器端授权。

## 回滚

回滚也必须先 drain，不能在新服务尚有输入时把 `CRAWLER_DEVICE_LOCK_MODE` 改回 legacy。依次停止新任务、断开人工控制、关闭新后端并验证所有受控输入结束；存在恢复错误时先按上节处理。确认 guardian 已正常释放或完成受信恢复后，才可恢复原执行环境和旧服务。保留新 SQLite 及请求引用以便恢复，不重写旧 canonical 数据，不自动重放已经成功的任务，不回退 V2。

由于 legacy 后端仅保留历史兼容，恢复旧采集还需要与选定回滚提交匹配的旧运行时。不能通过把原 App 主动请求重新打开来绕过手机 UI 被动读取方案。

## 当前真实验收边界

2026-11-08 的 Web smoke 已验证：新 Go 会话与独立 Douyin Chromium 能在隐藏 Wayland 桌面同时启动；各自使用独立 profile。XHS 有 cookie 文件，但搜索返回 `CRAWLER_TIMEOUT`，只读页面检查出现登录提示、未见验证码提示。Douyin 原默认 profile 不存在，新独立 profile 的 `is_logged_in()` 为 false。随后使用已登录 OnePlus 的小红书 App，经正式设备租约、正常扫一扫相册与登录确认，已完成 XHS Web 登录，并由 `/desktop/resume` 验证和保存登录态。Douyin 通过私有二维码域名校验和正常 App 深链接已完成“登录抖音网页版”确认。最新被动诊断确认 Web 轮询从 `new` 到 `scanned`，随后 `check_qrconnect` 返回 HTTP 200、业务错误码 `2046`；同时实际网页显示“身份验证”，要求接收或发送短信验证。当前仍未登录，不能宣称采集已可用。两平台的已登录搜索/主页/详情/评论需分别验收，登录成功本身不能替代采集验证。

手机真机结果以当次最终验收记录为准。曾验证某台手机某操作不代表另一台或其他操作可用；设备数不足、登录未完成或操作未验证时，应保持对应能力未验收。上述限制不影响离线协议、调度、租约、输入隔离和业务兼容测试的结果，但二者必须分开报告。

## 手机辅助网页登录

`tools/phone_web_login.js --platform xiaohongshu|douyin --serial <显式序列号>` 通过正式服务获取 Web 和手机的外部租约并续租。配置 `CRAWLER_SERVICE_TOKEN_FILE`、`CRAWLER_RUNTIME_DIR`、`CRAWLER_PYTHON`（该 Python 需安装 cv2/numpy）；服务默认 loopback 18323。脚本不调用裸 ADB。

二维码由对应已持有租约的 Web 会话导出，私有运行目录保存 PNG，网关在固定图库目录生成独立随机文件名导入。手机优先使用 UI 树导航扫一扫、相册和确认按钮。无文件名的图库中，只用单帧截图与刚导入二维码做像素匹配后选择对应 UI 控件；不记录二维码载荷，不用 OCR 获取内容。抖音动态扫一扫页可能拒绝生成 UI 树，此时只用已实测的 OnePlus 相册图标模板匹配单帧，匹配不到即停止；它不是跨设备通用坐标。遇验证码或不明页面停止。退出清理手机临时二维码并释放两端租约，Web 成功需通过服务端真实登录检测。

2026-11-08 OnePlus XHS 此完整路线已真机通过。图库同名缩略图缓存曾导致抖音读到旧二维码，因此网关已改每次使用独立随机文件名，并在清理时通知媒体扫描器；脚本仍逐图验证本次二维码像素，拒绝旧图和私人照片。手机 UI 更新或其他设备必须重新验证，不能推断已支持。

抖音登录脚本另提供 `--direct-qr`：仅从已验证“扫码登录 + 验证码登录”弹窗内导出的二维码，在私有进程内解码、核对 HTTPS 抖音短链域名及参数后，通过设备网关的普通 `ACTION_VIEW` 指定抖音 App 导航；不得输出解码载荷，不能接受任意外部二维码。它不调用 App 内部方法。该路径的成功仍以真实确认页面和服务端 `resume` 为准，未验收时不能当作已登录。

最终抖音有界实测：二维码已通过 DOM 登录弹窗检查，正常 `ACTION_VIEW` 和手机确认成功将网页推进到平台的短信身份验证。证据为私有 `runtime/douyin-login-transport.json` 与 `runtime/douyin-auth-state.png`；诊断只存登录端点路径（不含查询参数）、HTTP 状态、白名单业务码及状态，不存二维码载荷、凭证或原始响应。错误码 `2046` 与短信验证页面在本次同时被观察到，不据此臆测其他场景的错误含义。

用户已完成短信验证，控制台确认登录并正常结束接管。随后精确重启抖音 worker，认证保持有效，验证墙识别与保留当前页面的聚焦行为已经加载。未自动接收、发送短信或绕过身份验证。Vimium C 插件曾拦截用户数字输入，暂停插件后恢复；没有为此更改 RFB 键盘协议。

针对这次诊断与修复，`python -B -m unittest discover -s test -p 'test_login_diagnostics.py'`（4 项）、`python -B -m unittest discover -s test -p 'test_douyin_web_worker.py'`（5 项）及定向 `git diff --check` 均 PASS。上述为登录诊断阶段记录；用户完成验证后的验收如下。


## 登录完成后的真实端到端验收（2026-11-08）

- 后台真实认证通过，精确重启抖音 worker 后仍认证通过；无须重启 XHS 或手机消费者。
- 正式队列搜索曾返回 16 条（`douyin-search-endpoint-fixed.json`），详情 1 条、评论 5 条、主页 21 帖及 1 条用户资料成功。最新另一次搜索响应为 HTTP 成功、status_code=0、has_more=0、data=[]，独立保存并物化为 0 条，不以旧的 16 条覆盖。
- 实际 `DouyinQueueCollector` → `douyin.materialize` 重放确认四类结果数量一致；关键词、帖子/作者归属、评论关联和请求游标均正确，原始响应及采集时间未改变。原始证据仅保存在私有 `runtime/deployment-smoke/`。
- 修复搜索响应 endpoint 误判，增加受限的结构化 `request_params`；pipeline 优先使用这些参数，兼容旧录制 URL，不伪造已观察链接。请求游标与下一页游标分开保存。
- 主页按已验证请求的列表 owner 归属，允许合法共创帖保留不同原作者；错误的用户资料身份仍拒绝。搜索等待响应最长 10 秒，并在等待中检查操作权限，避免冷启动固定等待 2 秒的误报。
- 后台全量 Python 50 项 PASS；Node 未修改，前次全量 155 项 PASS。主项目相关回归：Douyin 79、DouyinKolPerformance 71、DouyinCaseStudy 36、CampaignWatch 279，均 PASS。

此为小量、单页实测，不推断所有排序、搜索条件或多页场景均完成真机验收；其他设备能力限制仍见手机验收记录。
