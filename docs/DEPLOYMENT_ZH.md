# 独立爬虫服务部署与恢复

更新：2026-11-08。本文描述当前代码和操作边界；服务能启动不等于所有平台已经通过真实采集验收。

## 两个仓库的职责

| 仓库 | 负责 | 不负责 |
| --- | --- | --- |
| `the-ultimate-crawler-console` | 持久化队列、调度、物理设备租约、平台消费者、浏览器/手机运行时、采集错误、断点、受控输入、屏幕源 | pipeline 业务筛选、基线政策、活动判断、最终报告、面向用户的前端 |
| `xhs-analysis` | 业务工作台、原证据/缓存读取、逐页业务决定、运行目录中的请求引用、爬虫控制台与鉴权代理 | queue 模式中的浏览器/ADB 重试、设备选择、旧原生 App 主动请求 |

新服务不写旧项目 canonical `data/`、`output/` 或 `casestudy/`。消费者使用本服务目录中的登录态。迁移时先停止浏览器，校验后移动profile；服务运行数据库和私有捕获写入自己的 `CRAWLER_RUNTIME_DIR`。API 不接受任意 pipeline 输出路径。

## 后端配置

systemd unit 使用 `EnvironmentFile` 读取私有 `.env`；直接运行 `npm start` **不会自行解析 `.env`**。凭证使用独立的权限为 0600 的文件，值至少 32 个字符，不写入源码、日志、命令行或文档。

| 配置 | 含义 |
| --- | --- |
| `CRAWLER_RUNTIME_DIR` | 后端私有 SQLite、状态、选择器和运行文件目录，使用绝对路径 |
| `CRAWLER_SERVICE_TOKEN_FILE` | 本地 API Bearer 凭证文件；pipeline 代理读取同一文件 |
| `CRAWLER_PORT` | loopback API，默认 `18323` |
| `CRAWLER_XHS_WEB_ENABLED` / `CRAWLER_DOUYIN_WEB_ENABLED` | 显式注册两个平台的 Web 消费者；值 `true` 或 `1` |
| `XHS_CRAWLER_BIN` | 从本仓库 `adapters/xhs-web/xiaohongshu-mcp/cmd/crawler` 构建的可执行文件；旧二进制不含分页和人工登录确认协议 |
| `XHS_BROWSER_PROFILE` / `COOKIES_PATH` / `XHS_BROWSER_CACHE` | 本服务的 XHS 独立 profile、cookie 容器与浏览器缓存；不依赖 pipeline 运行目录 |
| `DOUYIN_BROWSER_PROFILE` | 与 XHS 不同的专用 Chromium profile；两者路径相同会拒绝注册 |
| `CRAWLER_BROWSER_EXECUTABLE` | Douyin Chromium 可执行文件；省略时从浏览器缓存解析 |
| `ENABLE_XHS_BROWSER_NETWORK` | XHS 免费浏览器采集开关；部署真实采集时设为 true，与两个付费 gate 无关 |
| `CRAWLER_ROOT_INPUT_SERIALS` | 可选、逗号分隔的明确 serial；只允许普通数字 input 遭 INJECT_EVENTS 拒绝后的受限模拟触摸，不允许安装绕过或 App 内部调用 |
| `CRAWLER_CHROME_MANIFEST_FILE` | 手机 Chrome 准备工具生成的私有 APK 摘要清单；只经固定 provisioning 接口安装，不复制账号数据 |
| `CRAWLER_PYTHON` | 本服务自己的 Python 环境，安装全部 adapters requirements；匿名分享页同样使用它 |
| `CRAWLER_DESKTOP_DEPS` | 已安装 sway/wayvnc 的依赖根目录，含 `usr/bin`、`usr/lib` |
| `CRAWLER_DESKTOP_STATE_FILE` | 隐藏桌面的 `display.json`，通常为 `$CRAWLER_RUNTIME_DIR/desktop/display.json`；启动后端时读取 |
| `CRAWLER_WAYLAND_DISPLAY` / `XDG_RUNTIME_DIR` | 不使用状态文件时显式提供隐藏桌面 socket；消费者拒绝退回普通桌面 |
| `CRAWLER_DESKTOP_VNC_PORT` / `CRAWLER_VNC_PORT` | 前者供 desktop 脚本监听，后者供后端连接；两者必须相同，默认 `15910`，只监听 loopback |
| `CRAWLER_DEVICE_GATEWAY_ENABLED` | 启用手机输入网关和显式屏幕帧；未启用时不能注册手机消费者 |
| `CRAWLER_DEVICE_DISCOVERY_ENABLED` | 允许只读 `adb devices -l` 发现；仅发现不授予采集能力 |
| `CRAWLER_LEGACY_ANDROID_LOCK_DIR` | 必须是旧 `XHS_ANDROID_LOCK_DIR` 的绝对路径；服务在此持有系统锁，并将当前 PID 写入 `.worker.lock` |
| `ADB_PATH` | 主机 ADB 可执行文件，默认 `adb` |
| `CRAWLER_PHONE_ENABLED` / `CRAWLER_PHONE_CONFIG_FILE` | 显式启用及引用私有手机能力配置；只登记真实验证的操作 |

手机配置包含 `python`、本地 Frida `binary`、其 `sha256`、可选 `contractPath`，以及 `devices` 数组。每台设备可用 `contractPath` 指定其当前 App 版本契约（省略时使用公共契约），并提供显式 `serial`、经验证的 `operations`、搜索 `sorts`；`douyin_poi: true` 是单独能力声明。`ui_capabilities` 可逐项列出 `{platform, operation}`，只允许 XHS `place.search` 和 XHS/Douyin `post.detail` 的 `ui_identity` 表示；仅登记实际验证的项，不必同时开启两平台辅助能力。不要因为 ADB 可见就复制另一台手机的能力声明。运行时、App 版本、二进制摘要和响应身份检查仍会执行。

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

手机画面使用 scrcpy 3.3.3 手机端编码的 H.264 视频，最高 30 fps、4 Mbps，保留原始屏幕分辨率。浏览器通过 WebCodecs 解码，不落盘录屏。首次部署运行 `node tools/install-display-encoder.cjs`，下载官方固定版本并校验 SHA-256；默认保存到 `runtime/scrcpy-server-v3.3.3`，也可通过 `CRAWLER_SCRCPY_SERVER` 指定路径。运行期间不自动下载依赖，缺包返回 `DISPLAY_ENCODER_MISSING`。

点击开始才启动编码器；同设备多个 viewer 共享编码器，后加入者等待关键帧。视频走既有本机鉴权代理，服务凭据不发送到浏览器。停止、隐藏页面或离开控制台会关闭流；每 5 秒的 viewer 心跳及 20 秒 TTL 处理断网。最后 viewer 离开会关闭视频 socket、结束该次编码进程并删除其独有 ADB forward 和临时包，慢客户端不会拖住其他 viewer。控制、键盘和群控仍使用独立设备租约。

浏览器须支持 H.264 WebCodecs，并通过 localhost 或安全上下文访问。受 Android 保护的页面仍可能黑屏。更换前后端协议需要一起切换爬虫服务、控制台 API 和前端；停止现有串流后再更新，不能只热更新其中一端。

画面仅用于观看/控制，不用 OCR 替代内容数据获取。手机采集仍以正常 UI 动作触发请求，并读取匹配的结构化响应。控制需要独立的物理设备租约；观看不自动授权输入。群控仅向已选择且已取得控制的设备逐台发送操作，失败不会转而操作别的手机。

Web 画面经控制台的带票据 WebSocket 代理连接 loopback WayVNC。原始服务 token 不交给浏览器。接管期间全部 Web 租约持续续租；丢失租约就停止输入。单次打开/定位/确认操作也受租约守卫约束，释放必须等待操作和子进程完成清理。

## 开机启动与队列重新分配

运行 `systemctl --user enable ultimate-crawler.service` 和 `loginctl enable-linger "$USER"` 后，服务会在开机时由 systemd 启动。可用 `systemctl --user is-active ultimate-crawler.service` 查看运行状态。服务异常退出后，systemd 等待 5 秒再启动，每分钟最多尝试 3 次。

服务持有 Linux 内核排他锁，并在 `.worker.lock` 写入当前 PID。进程退出时内核释放锁。下次启动取得所有权后会覆盖遗留的 PID 文件。运行中的服务独占队列和手机池，每部手机仍可由队列独立分配。

启动和退出时在同一笔 SQLite 事务中释放租约、清除命令占用、结束中断的执行，并将未完成的任务从原断点交回队列。已经完成的结果、暂停或取消的请求和既有设备隔离都会保留。如果关机前还留有未确认结束的手机命令，只有对应手机进入隔离，其他设备继续接单。

## 手机隔离与连接恢复

每部隔离手机在 5 秒后首次运行「修复连接」。失败后从本次尝试结束起等待 10 秒、20 秒、40 秒，依次翻倍。间隔达到 24 小时后，每 24 小时继续重试，直至恢复。重启服务会接续已记录的重试计划。一次新的隔离从 5 秒重新计时。

手动点击「修复连接」可以立即尝试。手动和自动恢复共用该手机的修复租约，同时触发时共用一次执行。遇到已登记的离线传输时，服务只重连指定手机。ADB 在线、输入进程已停止、转发已清空，且隔离记录与租约仍然有效时，才将手机恢复为可分配。平台登录或验证故障继续按平台处理。

控制台的「手机连接」会在故障手机卡片上显示本轮原因、最近 50 条事件和下次尝试的日期时间。每次重试记录触发方式和结果。恢复正常后卡片清空本轮记录。未被隔离的离线传输继续使用原有的 60 秒重连间隔。

小红书启动连续三次未就绪时，手机采集在原租约内对小红书执行一次 Android `force-stop` 并重新启动。重新启动后仍未就绪时返回 `APP_NOT_READY`。已持有作品列表或帖子页面的发现会话只校验前台进程，保持当前页面供详情和评论读取。

小红书采集组件在发出界面动作前断开时，主页采集可以清理本次拥有的组件并重试一次。清理先等待正常退出。只有明确属于本次运行的同一个进程持续未退，才在原设备租约内停止该采集组件。详情和评论会话遇到连接错误时会停止本次读取。

## 回滚

回滚也必须先 drain，不能在新服务尚有输入时把 `CRAWLER_DEVICE_LOCK_MODE` 改回 legacy。依次停止新任务、断开人工控制、关闭新后端并验证所有受控输入结束；存在恢复错误时先按上节处理。确认服务锁已释放、手机输入已结束后，才可恢复原执行环境和旧服务。保留新 SQLite 及请求引用以便恢复，不重写旧 canonical 数据，不自动重放已经成功的任务，不回退 V2。

由于 legacy 后端仅保留历史兼容，恢复旧采集还需要与选定回滚提交匹配的旧运行时。不能通过把原 App 主动请求重新打开来绕过手机 UI 被动读取方案。

## 当前真实验收边界

2026-11-08，XHS 与 Douyin 独立 Chromium 在同一隐藏 Wayland 桌面运行，使用不同 profile。XHS 通过已登录 OnePlus 的 App 完成正常扫码确认；Douyin 正常手机确认后遇到平台短信身份验证，由用户完成。两端随后均通过后台登录检查。抖音 worker 精确重启后保持认证，搜索、详情、评论和主页真实响应以及 pipeline 物化结果均已核对通过，具体数量与空结果边界见本文最后一节。登录诊断阶段曾观察到 `new` → `scanned` → `2046` 与短信验证弹窗，不能把该历史状态当作当前仍未登录。

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

### V4 手机执行器退役

Pipeline 的 Android / clipboard / link recovery 模块现为 API 客户端；手机桥的
启动/停止和 ADB 子进程只属于本服务。Parse Links 任务记录仍归 Pipeline，
`POST /v1/device-utilities` 接收已取得的设备租约、显式 serial、操作名和参数，
同租约只允许一个 utility；释放、断连或租约失效会取消并排空操作。
匿名链接展开/校验经 `/v1/link-utilities` 执行，未授权浏览器 Origin 不可直连。

XHS 地点页旧 UI 采集迁至 `adapters/android-ui/poi_page_harvest.js`，通过正式队列
`place.posts` + `native_request.kind=location_page` 调用，保留 seed、时间边界、
候选/跳过事件和逐条持久化。仅在实际验证设备后配置
`ui_capabilities: [{"platform":"xiaohongshu","operation":"place.posts"}]`；
该能力与原生 topic feed 分开匹配，不因 ADB 在线而自动声称支持。
Douyin 地点采集通过 `locator.known_ids`（最多10,000个真实帖子ID）恢复跨请求进度。

登录 QR 的重发只读取 `/v1/desktop/qr-current` 缓存：缓存由持有 Web 租约的
`/v1/desktop/qr` 操作生成，同一图片重复读取不会延长10分钟窗口。Pipeline
不再读取浏览器或 QR 运行时文件；服务重启后无缓存时明确返回未获取 QR。
