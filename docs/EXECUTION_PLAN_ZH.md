# 统一爬虫队列与多设备控制执行计划

日期：2026-11-07。状态：2026-11-07 已获准按阶段实施；执行细节随确认更新。本文记录已确认要求，并给出可执行的默认设计、实施顺序和验收门槛；不代表以下能力已经实现。

## 1. 目标与已确认决定

新建私有仓库 `cyrus-xc/the-ultimate-crawler-console`，承载爬虫后台服务。第一版部署在当前采集主机，支持多台 ADB 手机和两个独立 Web 实例；预留远程 worker 协议，不在首版实现跨主机部署。所有前台展示留在 xhs-analysis 的爬虫控制台。

| 项目 | 已确认要求 |
| --- | --- |
| 请求入口 | 统一队列 API，明确区分平台与操作，pipeline 全部爬虫调用逐步迁入 |
| 初始消费者 | 小红书 Web、小红书手机、抖音 Web；每台手机单独注册 |
| Web 资源 | 每个平台当前只有一个登录态，所以各自只有一个消费者和一把独占锁；两个平台可以并行 |
| 手机资源 | 每个 ADB serial 对应一个物理设备锁，隔离爬虫、其他手机工具与人工操作 |
| effort | `full` 使用全部可用设备；`half` 使用一半；`auto` 按队列拥挤情况尽量多用，同时保留 1–2 台可用设备 |
| 失败转移 | 调度器只知道设备及能力，不建账号模型、不推断账号与设备关联；设备失败后换可用设备继续 |
| 部分失败 | 多设备请求中一台失败，保留已完成数据，待其他设备空闲后接手其未完成部分；不能提前让整个请求失败 |
| 手机采集 | 停用主动 App 内部接口调用，以点击、输入、滑动触发正常 App 请求，保留被动响应读取能力 |
| 健康状态 | 按设备、平台显示登录需求、验证、断线等状态；不以账户身份建调度关联 |
| 串流与控制 | 控制台开启且用户明确开始串流后才开启；观看与接管分开，人工接管独占输入 |
| 界面 | 多设备卡片、手机屏幕占位与开始串流按钮；顶部显示队列及异常设备信息 |
| 活动工作台 | 移除发现与门店报告中的“手机采集”状态页，入口统一指向爬虫控制台 |
| 业务边界 | 爬虫服务负责采集、重试、分页、错误和采集覆盖；pipeline 保留样本、业务判定、报告与交付规则 |

后续的超时、表结构和模块布局为实施默认方案。2026-11-07 追加确认：auto 可用单设备；连续分页不拆分；允许 App 深链接导航；主页/搜索/评论/话题单页条数跟随 App，内部上下文由 App 生成并记录；所有小红书消费者以支持五种搜索排序为目标，逐台验证，不能静默换排序。

## 2. 当前代码事实与迁移约束

调查工作树为 `/home/cyrus/Development/xhs-analysis`，Git 解析实际根目录为 `/home/pcd/Development/xhs-analysis`。分支 `standalone-crawler_V3.0`，origin 为 `git@github.com:cyrus-xc/xhs-analysis.git`，调查 HEAD 为 `da57f493d6478cf608dd8a1ad90f7963d7df1c01`。当前存在大量已修改及未跟踪文件，包括新爬虫控制台和隐藏桌面实现；不能只复制 HEAD，也不能替用户提交所有工作树变更。

| 已存在实现 | 当前限制 | 迁移处理 |
| --- | --- | --- |
| `core/collect/provider.py`、`lanes.py` | 一个 Web 加一个 phone，进程内调度，以 creator 为处理单位 | 改为统一队列客户端，业务级 creator 策略继续留在 pipeline |
| `core/collect/native_phone.py` | 本地 `POST /v1/xhs/read` 是采集入口；桥后端当前主动调用 App 方法触发请求，共享 pacing 路径 | 保留本地读 API、接口响应读取、解析与证据校验；仅将底层请求触发替换为 UI 操作，并隔离设备 pacing |
| `/home/pcd/android-lab/scripts/native-note-api-server.cjs` | 桥接实现位于仓库外，只有进程内串行队列 | 纳入依赖清单并迁移必要源码；不搬整个实验目录 |
| `/home/pcd/android-lab/src/observe-note-http.js` | 存在响应观察能力，尚无已验证的通用手势关联契约 | 复用观察机制，新增关联、超时、去重与身份校验 |
| `core/android_worker.js` | 共用目录 `.worker.lock`，不同手机也互相阻塞 | 迁成统一的 serial 级租约，所有调用方纳入 |
| `app/server/orchestration/store.js` | 已有 serial 级 `device_leases`，尚非通用 ADB 准入 | 避免与新锁形成两个权威，切为新服务代理 |
| `HandyGadgets/parse_links/tasks.js` | 单个 active job，调用旧 worker 锁 | 保留私有任务与输出边界，设备动作改走统一租约 |
| `core/collect/crawler.py`、`browser_session.py` | XHS 已有 browser slot、tab 锁与复用 | 新服务外层每 Web 一请求；内部分页也不得越过独占要求 |
| `douyin/crawler/browser.py` | 独立 profile 锁，未接入 XHS 隐藏桌面 helper | 保留独立 session，接入同一隐藏 Wayland compositor |
| `tools/crawler-desktop*.sh`、`app/server/crawler-desktop.js` | XHS 隐藏 Sway、wayvnc、WS 控制已存在 | 复用并迁移后台所有权；增加按平台焦点隔离和只读观看 |
| `app/web/src/pages/CrawlerConsole.jsx` | 当前新控制台尚有未跟踪源码 | 在现有实现上扩展，不重建平行页面 |

遵守 `AGENTS.md` 和现行 README。旧结构计划中的已退休工作区不恢复。`data/`、`output/`、`casestudy/` 不修改、不搬迁；pipeline 新产物仍只写自己的 run 目录。源码抽离不得顺带搬入凭证、会话、真实响应或运行数据库。

## 3. 服务边界与源码布局

调用链：pipeline stage / 业务 worker → Python 或 JS 队列客户端 → 爬虫后台 API → 持久化 scheduler → 设备 worker → 平台 adapter。控制台经现有 app 后端代理访问设备、队列、事件和串流；网页不直接持有后台服务凭证。

建议沿用当前 Node 服务、SQLite 和现有 Go/Python 采集子进程，避免迁仓同时改写所有平台运行时。依赖版本在实施时按本地锁文件和官方说明核对。

```text
the-ultimate-crawler-console/
  contracts/                 OpenAPI、JSON Schema、版本及脱敏契约样例
  service/api/               请求、设备、结果、事件、控制、串流端点
  service/queue/             scheduler、拆分、重试、断点、持久化
  service/devices/           registry、独占租约、健康状态、人工接管
  service/storage/           schema、事务、迁移、产物引用
  workers/local/             本地进程管理和远程 worker 协议边界
  adapters/xhs-web/           原 Go 爬虫及后台包装
  adapters/douyin-web/        原 Python Web 采集及后台包装
  adapters/xhs-phone/         UI 导航、被动捕获、关联与标准化
  android/                   ADB、clipboard、控制和串流基础能力
  desktop/                   隐藏 Wayland 与平台窗口管理
  clients/python/            pipeline 客户端
  clients/javascript/        console、gadgets 客户端
  tests/                     契约、调度、恢复、适配器、集成
  deploy/                    本地服务、运行目录和运维脚本
```

新服务拥有传输、采集数据格式、设备状态和采集错误；xhs-analysis 拥有业务规则、CaseStudy no-silent-drop、样本政策、证据交付与报告。抖音 ASR、TikHub、LLM、评分与业务输出不因目录名为 `douyin/` 就全部迁走。`core/note_links.py` 的链接真实性约束不能在抽离时被削弱；跨仓依赖通过版本化契约或共享小包承接，避免双份规则漂移。

运行状态和采集证据位于新服务自己的可配置 runtime 目录，默认 Git ignore。请求只携带业务引用，不允许调用者指定任意本机输出路径。pipeline 客户端把允许的结果写进当前 run；服务不直接改 pipeline 数据库或 run 文件。

## 4. 设备注册与统一隔离锁

### 4.1 资源与能力

Web ID 为 `web:xhs:default`、`web:douyin:default`。手机 ID 为稳定物理设备标识，ADB serial 是显式连接属性；首版使用 `android:<serial>`，不同 USB/TCP 别名不得将同一手机重复注册为可并行资源。

设备字段至少包含：`device_id`、`worker_id`、`kind`、`adb_serial`、`connection_state`、`platform_states`、`capabilities`、`lease_owner`、`lease_expires_at`、`last_seen_at`、`last_error`。平台状态可以报告 `login_required`，不存调度账号 ID 或跨设备账号关联。

把物理连接、平台健康、占用分别建模：在线手机可能小红书需要登录，也可能正被其他工具占用。手机上多个平台共享同一把物理输入锁；Web 两个平台是不同资源。ADB `offline`、`unauthorized`、应用未安装、观察器不可用都不能显示为可采集。

能力按平台和操作声明，包括支持的排序、字段、分页、时间过滤、评论、可否连续读取、断点兼容范围。未验证的手机搜索或抖音手机功能不得通过统一 API 被假装支持。

### 4.2 锁必须原子授予

scheduler 可读状态用于选择，但真正执行前必须在事务中原子 acquire；不能采用“读到 idle 就写 busy”。锁字段包含 owner 类型、owner ID、租约 ID、递增 fencing token、心跳与到期时间。crawler、Parse Links、POI、clipboard、人工控制和未来其他工作统一申请同一设备锁。

建议初始租约 30 秒、心跳 5 秒，配置化并以故障测试校准。租约过期后先确认旧子进程停止或隔离，再重新分配；fencing token 同时约束输入命令、回包提交和续租，避免旧 worker 恢复后继续操作设备。API 或 scheduler 重启期间 worker 在不能续租时停止发新输入。

同一消费者一次仅执行一个 work unit；请求可由多个消费者处理不同单元。设备空闲不等于无限速：保留设备自身的节流、冷却状态，但不让多个手机共用一个 pacing 文件。外部工作持锁时，crawler 排队，不绕锁直接调用 ADB。

## 5. effort 与公平调度

### 5.1 默认精确定义

`effort` 是单个请求的并发意愿，不是复制同一操作到多个设备，也不要求凑齐设备才开始。候选必须符合平台、操作能力、显式设备过滤、健康状态和调度准入。

设本轮该请求可新增使用的空闲候选为 F 台，已持有并仍执行的合格设备为 O 台，N = F + O，剩余可独立执行单元数为 W。计算目标总并发，再受公平调度限制；不会抢占别的请求正在执行的动作。

| effort | 默认目标 |
| --- | --- |
| full | `min(N, W)`，本请求没有额外预留 |
| half | N > 0 时 `min(W, max(1, ceil(N / 2)))`；奇数向上取整 |
| auto | N=1 时为 `min(W, 1)`，否则 `min(W, max(0, N - R))`；未达到目标只逐步扩容 |

auto 预留只计算本请求有能力使用的候选池，无关平台 Web 不能算作替小红书保留的可用资源。建议空闲且无竞争时 R=1；存在其他等待中的兼容请求或外部设备需求时 R=2；N≤2 时 R=1。**用户已确认 N=1 时 auto 允许使用最后一台兼容设备，避免无法运行**；N≥2 时遵守预留规则。单关键词/主页连续分页不拆分，失败后换设备重放去重。

预留是 auto 的分配规则，不保证其他 full 请求或外部工具永远不使用这些设备；若业务需要永久保留手机，应另配显式设备排除列表。当前规模下不引入隐式保留设备专用池。

每轮优先给等待最久且可执行的请求一个单元，再轮询分配剩余资源直至各请求达到目标；请求 aging 防止长等待饥饿。full 表示尽可能占满本轮未被其他请求分配的资源，不拥有绕过公平性的权利。每个可提交页/条目边界重新评估，不能在已经发出的动作中途收回设备。

### 5.2 可拆分与不可拆分

批量 UID、多个关键词、多个详情 ID 可并行拆分。单个关键词的连续游标页、单个主页时间线的连续页默认保持顺序，不得把尚未知晓的第二页游标凭空拆给另一台手机。抓到一页后，可将独立详情任务分配给其他消费者。

因此只有一个详情或只有一个串行分页链时，即使 full 也可能只用一台设备。API 返回 `parallelism_limit_reason`，避免 UI 把语义限制显示成 scheduler 故障。不同设备的个性化搜索结果不能被标记为同一稳定分页序列。

## 6. 统一 API 契约

### 6.1 请求样例

```json
{
  "schema_version": "crawler.request.v1",
  "idempotency_key": "run-revision-stage-operation-hash",
  "platform": "xiaohongshu",
  "operation": "profile.posts",
  "effort": "auto",
  "targets": [{"user_id": "example-uid"}],
  "params": {"max_items": 100, "published_after": "2026-10-01T00:00:00+08:00"},
  "limits": {"max_pages": 20, "execution_timeout_seconds": 600, "queue_timeout_seconds": 1800},
  "routing": {"kinds": ["web", "android"], "device_ids": []},
  "cache": {"mode": "prefer_fresh", "max_age_seconds": 3600},
  "context": {"pipeline": "CampaignWatch", "run_id": "example", "stage": "discover", "source_revision": "example"}
}
```

`platform` 首版枚举 `xiaohongshu`、`douyin`。schema 拒绝未知 operation/参数及无界分页；时间使用带时区 RFC3339。缓存策略、队列等待与执行期限各自独立。`idempotency_key` 按调用方作用域唯一，同 key 同 payload 返回同请求，不同 payload 返回 409；显式新观测必须使用新的观测 revision/key。

### 6.2 操作清单

| 操作 | 输入与停止条件 | 结果要求 |
| --- | --- | --- |
| `search.posts` | 单个或多个关键词、排序、筛选；单页或连续多页；页数/条数/期限上限 | 卡片与详情分开，所有已加载候选可追踪 |
| `profile.get` | UID / 已验证主页引用 | 主页资料、缺失字段、采集时间 |
| `profile.posts` | UID、条数、起止时间、页上限 | 发布时间、置顶标志、观察时间及分页覆盖 |
| `post.detail` | 平台 post ID 与必要的已观察访问链接 | 正文、标签、作者、公开指标、真实来源 |
| `post.comments` | post ID、主评论/回复范围、条数和页上限 | 主评论与回复覆盖分别统计 |
| `place.search`、`place.posts` | 地点关键词或 POI ID | 仅通过对应 adapter 验证后启用 |

“发现活动帖子”不是服务里的业务判断：pipeline 用 `profile.posts` 等接口获得候选，再按活动规则判定。需要搜索→详情组合时可构造服务内部依赖单元，但不嵌入店铺确认或评分规则。

`max_items` 是停止发起下一页的条件。已返回整页中的超出项仍写入证据和 `loaded_candidates`，不能截断后永久丢掉。CaseStudy 必须取得完整已加载候选清单。主页时间截止只有在顺序可靠并处理置顶后才能作为结束证据；无可靠排序或时间缺失时继续到上限并报告覆盖不确定。

### 6.3 HTTP 与事件

| 端点 | 用途 |
| --- | --- |
| `POST /v1/requests` | 202 提交请求并返回 request_id |
| `GET /v1/requests/:id` | 状态、进度、实际设备分配、等待原因、错误摘要 |
| `GET /v1/requests/:id/results?cursor=...` | 稳定分页读取已提交结果；此 cursor 是服务结果游标 |
| `GET /v1/requests/:id/events?after=...` | 持久化事件重放及 SSE，支持断线续订 |
| `POST /v1/requests/:id/pause`、`resume`、`cancel` | 幂等状态转换，保留已提交数据 |
| `POST /v1/requests/:id/retry` | 只重试指定失败/未完成单元，新增 attempt，不清空历史 |
| `PATCH /v1/requests/:id/scheduling` | 调整 effort 和允许设备，不篡改原采集语义 |
| `GET /v1/devices`、`GET /v1/capabilities` | 设备、占用、平台健康与能力矩阵 |
| `GET /v1/queue`、`GET /v1/events` | 全局队列摘要与增量事件 |
| `POST /v1/devices/:id/control` | 请求人工接管，返回 pending 或控制租约 |
| `DELETE /v1/devices/:id/control/:lease` | 释放控制并由 scheduler 决定恢复 |
| `POST /v1/devices/:id/streams` | 显式创建有时限的观看会话 |
| `DELETE /v1/devices/:id/streams/:session` | 关闭观看会话 |

控制输入通过受鉴权 WebSocket 发送，每条命令验证控制租约和 fencing token。后台默认 loopback，仅信任 console 后端和受权本地 worker；远程访问预留认证接口，不裸露 ADB、VNC、任意 shell 或任意文件读取。

### 6.4 结果和错误

结果至少包含 `platform`、`operation`、`target`、`data`、`missing_fields`、`observed_at`、`device_id`、`adapter_version`、`schema_version`、`attempt_id`、`evidence_ref`、`coverage`。原始证据与标准化结果同时保存；跨设备重试不能将旧缓存的观察时间重写为现在。

`coverage` 包含 requested/loaded/unique/returned 数量、页数、已观察结束标志、停止原因、未读对象和部分结果原因。请求最终状态分 `succeeded`、`partial`、`failed`、`cancelled`；运行中包括 queued、running、waiting_resources、pausing、paused。部分完成不等于成功，也不把未知值写成 0。

统一错误字段：`code`、`scope`（device/platform/operation/item/service）、`device_id`、`platform`、`operation`、`retryable`、`action_required`、`message`、`evidence_ref`、`checkpoint_ref`。示例包括 DEVICE_DISCONNECTED、LOGIN_REQUIRED、VERIFICATION_REQUIRED、APP_UNHEALTHY、CAPTURE_UNAVAILABLE、CAPTURE_TIMEOUT、UNSUPPORTED_OPERATION、CONTENT_UNAVAILABLE、CURSOR_INVALID、NO_CAPABLE_DEVICE、NO_AVAILABLE_DEVICE、QUEUE_DEADLINE、SERVICE_UNAVAILABLE。

采集 adapter 分类实际错误，scheduler 决定转移和重试，客户端只呈现或做兼容类型映射；pipeline 不再解析日志猜测验证码/封禁/浏览器故障。服务不可达由统一客户端产生连接错误，不能要求宕机的服务返回自己的错误。业务层仍可报告样本不足、候选未读和交付阻塞。

## 7. 持久化与断点续接

### 7.1 数据模型

首版一个服务拥有 SQLite 事务库。建议表：requests、work_units、attempts、devices、device_capabilities、leases、checkpoints、result_items、evidence_objects、events、stream_sessions。事件与状态修改在同一事务提交；原始证据先写临时文件并原子落盘，再提交引用，启动恢复扫描孤立临时文件但不碰 pipeline 数据。

work unit 对应可独立恢复的目标或分页链。checkpoint 包含请求参数 hash、目标、完成 ID 集合、待详情 ID、原始 cursor、cursor 所属 device/adapter、页序号、最后观察边界、证据摘要和结束证明。不要把内存里“已抓到但未持久化”记为完成。

一次提交原子完成：结果写入 → checkpoint 前移 → 单元状态/事件更新。允许 at-least-once 读取，使用稳定业务键与 attempt 记录实现幂等提交；不承诺平台读取 exactly-once。去重键区分请求、操作、平台和对象；重复的实时观测保留历史，不能覆盖首次证据。

### 7.2 换设备如何继续

1. 当前设备异常，提交已经确认的数据，将其对应平台能力设为不可调度，并记录具体错误。物理断线影响整个设备；单平台登录需求不禁用其他平台能力。
2. 未提交单元回到待分配状态；有效的其他设备继续自身任务。
3. 若还有兼容健康设备但正在忙，进入 waiting_resources；尤其等待本请求其他设备完成后接手，不提前失败。
4. 同设备、同 adapter 且 cursor 有效时从原 cursor 接着读。跨设备或跨 Web/手机不盲用 cursor。
5. 不能移植 cursor 时，从入口重新导航，按已经提交的对象 ID 去重，继续发现未完成内容；记录 `resume_mode=replay_deduplicate`、重放页数和结果序列变化。重放同样受页数、耗时等预算约束。
6. 单条详情失败只转移该条；未完成分页链重放不会重跑已完成详情。不同设备能见内容不同，已看到但未读的对象必须保留，不能因另一设备找不到就删除。
7. 没有任何兼容健康设备时返回明确的设备不可用错误；已有结果则结束为 partial，无结果则 failed，同时保留可恢复断点。忙碌、人工占用、auto 预留不足不是“没有设备”，等待至队列期限或用户取消。

建议每个单元每台设备自动尝试不超过 2 次，并有总执行期限；登录/验证错误立即退出该设备本轮尝试，不反复戳同一异常页面。健康恢复需要重新检测或操作者完成登录后检查，不自动清除异常。重试在其他设备进行，不建立账号关联。

取消和暂停都先停止派发新动作。已经返回且合法的数据可以在终止屏障前提交；终止后到达的旧结果记录为迟到，不改变最终状态。服务重启重新对账租约、worker 和 attempts；pipeline 重启复用原 idempotency key 查询原请求。

## 8. 手机采集与健康检查

每台设备有自己的 UI 状态机、响应观察会话、超时、缓存命名空间和节流。步骤为：取得租约 → 确认 ADB/应用/观察器 → 建立此次动作关联窗口 → 点击或滑动 → 接收响应 → 校验平台、接口类型、目标身份、请求参数和时间 → 标准化并提交 → 更新 UI 状态。

用户已允许复用 App 深链接打开指定帖子/主页作为正常导航；不把未验证的主页深链接声称为已支持。允许读取 App 自身正常请求的返回，不主动 invoke App 内部服务、不重放签名请求、不通过隐藏 native API 补缺。旧的 App 内部方法主动触发路径从新配置和默认运行路由移除；不作为“兜底”。本地爬虫 HTTP API（包括兼容 `/v1/xhs/read`）仍可保留：它接收采集指令，由 UI 动作触发平台请求，然后读取真实接口响应。观察器自身不得触发业务请求。

必须处理：无请求的 App 本地缓存页面、多次重复回包、后台预取、异步延迟、错误目标、空列表、滑动未触发、UI 变化和观察器崩溃。只有屏幕卡片但无完整响应时不能冒充详情数据；超时应给出 CAPTURE_TIMEOUT 或明确的部分覆盖。

低频健康检测复用设备已有状态，后台不持续录屏、不抢其他工作前台。会改变前台的健康探测也需锁。记录所需平台登录、验证页面、应用崩溃、权限和网络状态。每个声明支持的操作要经过脱敏回放与真实设备验证；手机 App 版本变化使 UI/观察器失效时禁用该能力并显示原因。

## 9. Web 并行与隐藏桌面

XHS 和 Douyin 使用各自的 Chromium profile、进程、窗口标识、锁与健康状态，连接现有隐藏 Wayland compositor。任一平台登录或崩溃不得关闭另一平台窗口。后台启动可恢复两个浏览器会话；无隐藏桌面时报告基础设施错误，不弹到用户桌面作为隐式降级。

服务层每个平台 Web 只允许一个请求单元。原 XHS 多 tab 能力先收敛为该单元内部顺序读取，防止一个 Web 实例被算成多台设备。未来增加登录态需要显式新增资源实例，当前不实现。

窗口共享 compositor 不代表共享输入控制：后台 Web 自动操作优先使用各自浏览器上下文。人工桌面输入涉及全局焦点时，额外取得桌面控制互斥并安全暂停可能被焦点影响的自动操作；界面清楚显示暂停范围。必须测试在 XHS 窗口输入不会误发给 Douyin。

## 10. 串流与控制台

手机卡片默认显示手机屏幕轮廓、设备名、serial、平台状态及中央“开始串流”按钮；未开始串流时无编码进程、无视频连接。查看列表只取状态，不能隐式启动屏幕采集。

串流实现先验证现有主机工具能力，采用单设备视频源、多观看者复用；具体编码/浏览器传输选型通过阶段原型确定。每个观看会话绑定已鉴权控制台连接，页面卸载、关闭串流、连接失活或会话超时后回收；无观看者即停止采集进程。控制台页面隐藏时默认暂停串流。后台采集任务不依赖控制台存活。

观看者无输入权限。点击“接管控制”后，scheduler 停止给该设备发新动作，当前动作到安全检查点并停止后授予人工锁。超时不能直接宣称接管成功；需先终止并确认自动 worker 停止。人工断线释放租约，重新检查 UI/平台健康后从断点恢复。

输入包含点击、拖动、滚轮映射滑动、键盘输入、返回/主页；正确处理画面缩放、旋转、坐标边界和 Unicode。每次输入校验当前租约。群控为显式多选设备后分别申请人工锁，只对已授权设备执行，并逐设备显示成功/失败；不绕过 busy 状态、不静默部分接管。

控制台顶部替换原标题区域，显示排队/运行/等待/失败数量、设备使用情况和异常设备列表。异常注明设备、平台、原因、发生时间和处理入口。请求详情显示 effort、实际并发、预留/公平等待原因、每个单元进度、转移历史和覆盖情况。

发现与门店报告删除“手机采集”状态页及重复状态轮询；保留业务执行进度和到爬虫控制台的链接。旧路由重定向到统一控制台，不能造成历史链接白屏。现有三语言文案同步更新。

## 11. 分阶段执行与交付门槛

### 阶段 0：清点当前工作树与冻结迁移清单

核对分支、remote、现有未提交改动；登记待迁移文件及实际工作树 hash，包括 android-lab 外部依赖。逐一列出直接启动浏览器、直接 ADB、native API、fallback、采集错误判断的调用点。冻结现有业务输出契约、可脱敏 fixtures 和当前能力矩阵。只记录凭证路径，不读取或复制秘密值。

交付：源码迁移 manifest、调用点矩阵、业务/采集所有权表、已知限制与待验证操作表。门槛：所有活跃 pipeline、gadgets、后台 worker 和 CLI 都有归属；当前未提交改动没有丢失。

### 阶段 1：新仓库与契约骨架

使用现有 GitHub 凭证验证账号与仓库名，创建上述私有仓库；不打印 token。建立 API/schema、Python/JS 客户端骨架、数据库迁移、health/version 端点和离线 CI。定义请求、设备、结果、错误、事件、断点和租约格式；支持提交/查询/取消的 fake worker。

交付：可本地启动的后台与版本化契约。门槛：同 key 幂等、参数验证、权限边界、数据库重启恢复通过。尚不接真实平台采集。

### 阶段 2：持久化 scheduler 与设备锁

实现 work unit 拆分、原子租约、心跳、fencing、公平调度、effort、等待期限、事件流和错误分类。使用三类 fake consumers 验证多设备、部分失败与恢复。提供外部工作租约接口及本地输入网关；先接入 Parse Links/POI 的租约适配，避免新旧服务并存争用手机。

交付：带故障注入测试的队列。门槛：同手机并发输入为零、两台手机能并行、两个 Web 能并行；旧 worker 不能越过租约继续动作；所有直接手机操作者接入后才允许新 scheduler 生产执行。

### 阶段 3：Web 后端抽离

迁移 XHS Go 采集运行时、Douyin Web 采集模块和隐藏桌面后台，独立 browser profile 路径以配置引用现有会话。依次接入 search/profile/detail/comments 等已支持能力、统一错误和 checkpoint。旧进程必须释放锁才启动新 consumer；不复制正在使用的 profile。

交付：两个独立 Web consumers 与后台窗口管理。门槛：脱敏 fixture 数据/时间/缺失语义一致；双平台并行和单平台故障隔离通过；真实登录与采集 smoke 单独记录。禁止以 mock 通过代替实测。

### 阶段 4：手机 UI 驱动与被动采集

从 android-lab 抽取必要观察器，加入设备注册、显式 serial、每设备状态机和捕获关联；先打通单手机详情，再主页分页、搜索、评论与地点能力。每完成一个操作才在 capability registry 标为可用。禁用主动 native 请求路径并建立防回归检测。

接入至少两台授权手机验证不同目标并行、同手机跨工具排他、手机断线后另一手机续接、Web/手机跨后端恢复。现场不足两台手机时阶段保持未验收，不能用模拟器结果声称多实体设备已验证。

交付：多手机消费者、平台健康状态、实际捕获证据及限制清单。门槛：每个声明能力有真实 UI→响应→正确目标的证据；主动 App 调用次数为零；续接不丢已加载候选。

### 阶段 5：统一客户端与 pipeline 迁移

先替换 `core/collect/provider.py` 入口和共用采集 facade，再清理绕过入口的直接调用。采用显式 `collection_backend=queue` 迁移开关，旧配置经兼容层解释为 routing 参数；不因服务不可达就偷偷回落到旧爬虫。历史 native_phone 仅保留配置读取兼容，新执行映射为 UI 手机能力，不恢复主动 native 调用。

| 迁移批次 | 调用范围 | 验收重点 |
| --- | --- | --- |
| A | Keyword 搜索/主页；KolPerformance 主页、详情、评论 | 连续分页、样本政策和成熟时间不变 |
| B | CaseStudy、entity_discovery、venue_visits、recall | 所有已加载候选保留；未读原因、owner links 和 dropped list 不丢 |
| C | CampaignWatch 两平台发现及周期 worker | 重启复用 request，已确认活动不重复发现；业务时间窗不变 |
| D | MerchantReport baseline、collect 与观测 | 首次观察时钟、固定基线、revision 和报告截止不变 |
| E | DouyinKolPerformance、DouyinCaseStudy | 抖音字段与业务策略保留；ASR/LLM 仍归原流程 |
| F | CLI、gadgets、后台补采与缓存查询 | 直接 ADB/浏览器路径无遗漏；缓存离线读取不触发采集 |

每批将爬虫重试、fallback、设备错误字符串判断移到服务；pipeline 保留业务错误。客户端在 run 内保存 request_id、checkpoint/result 引用和源 revision。旧证据缓存保持只读兼容，不能重写 canonical 数据。服务请求上下文不得成为任意 run 写入授权。

交付：每批调用点清单、parity 差异与测试结果。门槛：完成清单中的调用都进入队列；任何有意语义差异单独记录版本，不能混入搬迁。

### 阶段 6：控制台多设备与串流

扩展现有 CrawlerConsole 和 phone 组件，连接 queue/device 事件、占位屏幕、显式串流、观看/接管、键鼠和群控。app 后端仅做代理与权限层，删除其对单一手机桥的生命周期所有权。实现手机与两个 Web 的明确定位和错误呈现。

交付：可操作的统一控制台。门槛：打开页面不串流；点击后才有视频进程；关闭/断网回收；人工与爬虫无同时输入；不同平台窗口无串输入。通过后移除活动发现与门店报告的旧手机状态页。

### 阶段 7：切换默认入口并清理旧实现

全量回归通过后将新任务默认改为 queue。先 drain 旧执行器，保存运行中请求与状态，再启动新消费者；禁止两个服务同时控制同一资源。按 manifest 删除不再使用的爬虫源码、启动脚本和直接调用，仅留下必要历史配置/结果读取适配。核对 README、部署说明、环境变量样例和故障恢复文档。

分别验证两个仓库的实际 remote、分支、测试和变更范围后提交并推送；xhs-analysis 保持 V3 目标，保留 V2。新仓库仅提交白名单源码和脱敏测试；不要将当前全部工作树变更一起提交。生产服务器/HPC 部署另列交付，不视为本机迁仓自动完成。

交付：可启动的新后台、全部业务客户端、统一控制台、迁移记录和回滚操作。门槛：所有回归及实际设备验收完成，直接采集入口无残留或有明确只读历史用途。

## 12. 测试与验收矩阵

### 12.1 新服务必须覆盖的故障

| 场景 | 必须观察到的结果 |
| --- | --- |
| 0/1/2/3/5 台兼容设备，各 effort | 取整和预留明确；无超额租约；auto 单设备可以运行 |
| 单关键词串行分页 + full | 不制造无效并发，不重复提交同一页 |
| 两请求竞争、外部工具占用 | 公平轮询、不饥饿、busy 等待不报无设备 |
| A/B 同时执行，A 失败 B 忙 | B 先完成自己的单元再续接 A，已完成结果不重跑 |
| 所有兼容设备异常 | partial/failed 带错误和可重试断点，无永久无理由 pending |
| 手机断线、ADB unauthorized、应用登出 | 正确设备/平台状态；不推断账号关联 |
| 同设备恢复、跨设备游标不兼容 | 前者接 cursor，后者入口重放并去重；覆盖差异显式 |
| 写证据后崩溃、提交事务前后崩溃 | 无误标完成、无引用损坏、可重放 |
| worker 假死、lease 过期后恢复 | fencing 拒绝旧输入和旧结果；新 worker 启动前旧进程已隔离 |
| 两种请求 key 冲突、pipeline 重启 | 同 payload 不重复执行；不同 payload 返回冲突 |
| App 缓存不发包、预取错对象 | 不伪造数据、不误关联，不把卡片当正文 |
| 暂停/取消和迟到回包竞争 | 状态不被复活，已提交证据保留 |
| 手动接管、控制断线、双观看者 | 自动停止后才授予控制；最后观看者退出才停视频源 |
| XHS 与 Douyin 同桌面并行 | 独立会话、锁和故障；焦点输入受桌面互斥保护 |
| CaseStudy 已加载超过 max_items | 所有候选可追踪，最终未确认列表无静默丢失 |

所有容量测试在测试内显式固定机器上限，不依赖操作者 `.env`。离线测试使用 fake ADB、fake 浏览器和脱敏回包，强制关闭付费网络 gates；新服务 subprocess 测试也必须继承 gates 关闭约束。不得为验证迁移打开 TikHub 或 LLM gate。

### 12.2 xhs-analysis 最终回归命令

```bash
python -B -m unittest discover -s pipeline/Keyword/test -t .
python -B -m unittest discover -s pipeline/CaseStudy/test -t .
python -B -m unittest discover -s pipeline/KolPerformance/test -t .
python -B -m unittest discover -s pipeline/MerchantReport/test -t .
python -B -m unittest discover -s pipeline/DouyinKolPerformance/test -t .
python -B -m unittest discover -s pipeline/DouyinCaseStudy/test -t .
python -B -m unittest discover -s pipeline/CampaignWatch/test -t .
python -B -m unittest discover -s HandyGadgets/kol_real_data_extraction/test -t .
python -B -m pytest douyin/tests -q -p no:cacheprovider
npm --prefix app test
npm --prefix app/web run build
```

执行前再次枚举 `pipeline/*/test/`，存在的新 suite 必须加入。依赖不足时按项目开发依赖安装；验收记录逐条写实际命令、PASS/FAIL、跳过项及原因。新仓库阶段 1 建立明确的 `npm test` / adapter 测试脚本并纳入自己的 CI，包含迁移后的 Go、Python 平台测试；不得只跑 xhs-analysis 客户端测试。

真实验收另外记录设备型号、App/adapter 版本、操作、目标校验、已脱敏证据、断点接手过程和局限。原生主动路径不再用于任何 smoke；涉及真实设备的命令始终指定 serial、取得租约。

## 13. 切换、回滚与完成定义

每阶段先保持已完成业务数据可读。回滚服务版本前停止派发、drain/终止 worker、保存数据库与版本化 checkpoint，确认 schema 可向后读；不支持降级时恢复对应备份到新运行目录，不覆盖现存数据。回滚 UI 不改变请求状态，回滚客户端不删除结果。

旧手机主动 API 不能作为回滚目的地。手机 UI 路线失败时关闭该能力，由队列使用其他健康设备或返回 partial/failed；不能为了恢复可用率重新启用用户明确要求下线的采集方式。

完成条件：三类消费者按真实能力消费统一队列；多手机隔离锁覆盖全部设备操作者；断点在崩溃和换设备后可恢复；pipeline 采集错误与重试归一；控制台串流/接管满足显式启用与互斥；旧手机状态页撤除；两仓源码和部署文档可复现；全部测试和真实验收有记录。首版不把跨主机 worker、抖音手机、永久保留设备池或账号关联模型计入已实现能力。

2026-11-07 用户已授权继续执行以上阶段，要求尽量保持现有接口读取实现，遇到执行细节立即询问。后续完成状态以实施记录与实际验证为准。
