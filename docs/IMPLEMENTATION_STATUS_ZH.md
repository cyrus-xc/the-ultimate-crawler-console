# 实施记录 2026-11-07

当前为基础实施阶段，不能用本记录宣称迁移已完成或真实设备可用。

已完成的基础代码：持久化请求、幂等提交、设备锁与 fencing、effort、公平分配、断点/结果事务、设备失败转移、暂停/取消、worker 输入守卫、跨设备游标隔离、Python 客户端和鉴权 API。新库运行目录与 pipeline 数据分离，API 不写旧项目运行目录。

已复制 XHS Web 当前工作树的 137 个源码/许可证文件，保留相邻 headless_browser 模块及原 Go module。尚未删除原目录、切换原运行时或启动新 Web consumer。Douyin 已抽离响应记录、解析、guard、profile 锁和原网页内 fetch 脚本，新增有界分页 transport；尚未连接常驻 worker 或切换业务调用。

手机侧保留原 observe-note-http.js、runtime_redaction.py 和 response matching/transport/share evidence 函数，新增 UI-trigger capture 单元。每次动作新建有界观察会话。已在 OnePlus 小红书 9.51.0 完成一次 UI 搜索触发并被动读取 HTTP 200 / 20 条结果的验证；未替换旧桥进程，其他操作仍须逐项实测。

用户已确认：auto 单设备可运行；连续分页保持单设备；允许深链接导航；单页条数随 App；内部参数观察记录；五种搜索排序以全部 XHS 消费者支持为目标，实际缺项须给出设备/版本证据。

验证：

- 新后台 `npm test`：65 项 Node 和 23 项 Python 离线测试 PASS。只使用 fake adapters；付费 gates 强制关闭。
- XHS 源码 `go test ./cmd/crawler ./crawler ./configs ./cookies ./browser`：PASS；未启用真实浏览器 opt-in fixture。
- 原 pipeline 和 console 未修改运行代码，本阶段尚未执行其全量回归。最终迁移验收仍须执行原计划全部命令。

下一阶段：接入 Web 常驻会话并验证平台隔离；手机 UI 导航与接口参数逐项实测；让旧手机工具参加同一租约；再迁 pipeline 和控制台。当前服务不应接管生产执行。

后续进展：新增 UI 树控件自愈，按设备和 App 版本隔离，更新前验证页面后置条件；不使用 OCR 作为内容数据源。OnePlus 已真实通过搜索入口与 Unicode 输入导航。Chrome 剪贴板桥首次遇到地区搜索引擎提示，保留已有 Google 选项后通过。搜索结果页的查询文本控件与提交按钮不同，新增结构识别避免点击错误的“搜索”按钮。默认搜索的 UI→响应读取已通过一次实测；最新排序本轮捕获超时，尚未通过。五种排序的 UI 选项均曾在 OnePlus 菜单中观察到，但这不等于五种排序响应都已验证。

新增逐页业务决策协议和持久化 SSE；数据库 schema v3 增加稳定设备剪贴板端口和业务决策，包含 v1 状态保留迁移测试。后台生产调度、原 pipeline 接入、双手机并发实测与控制台串流仍待实施。

Q10 已确认并实现基础协议：Python wait_with_decisions 将按单元累计的结构化响应和当前断点传给本地回调，仅发送 continue/stop。worker 阻止未决状态与 stop 后的新输入；迟到决定不能授权不同断点。回调异常保留待决状态，便于恢复。新增分页结果、跨单元隔离、回调失败与过期断点测试。原 pipeline 业务回调尚未切换。

补充恢复验证：替换设备先恢复未决业务决定，stop 不启动替代设备操作；Douyin 分页收到 stop 后保留当前整页和游标，不再 fetch 下一页。默认搜索复测成功，实际返回 21 条；最新排序二次捕获仍超时。

排序修复实测：9.51.0 完整菜单将排序写入 filters.sort_type，快捷栏“最新”是 filter_hot；菜单重置不清快捷栏。新导航先清快捷筛选再重置菜单并选择完整排序，UI 树仍为首选。响应层仅对匹配做语义归一，保留原请求/响应；不接受额外的旧筛选。OnePlus 最新排序按完整流程复测通过（time_descending，默认其他筛选，HTTP 200，20 条，新鲜 Cronet 响应）。其余排序继续验证。

Q11 已确认：决策增加 phase/subject_id/capture_share，false 分享选择不等于停止；schema v4 保留 v3 未决状态。新增队列、HTTP、worker、Python 客户端及迁移测试。最多点赞排序完整流程实测通过；最多评论和最多收藏随后也通过相同流程，均为 HTTP 200、20 条、新鲜 Cronet 响应。

2026-11-08：OnePlus（c7dee0b3，小红书 9.51.0）五种搜索排序均通过同一 UI 驱动流程：综合、最新、最多点赞、最多评论、最多收藏。每次都校验真实请求的排序和无额外筛选，HTTP 200，20 条，新鲜 Cronet 响应。证据保留在本机私有 smoke 目录，未提交原始响应/截图。这不代表 Redmi、连续分页、主页、评论或正式队列消费者已经通过。

独立手机运行时已加入：runtime.js 校验 App 版本、APK 摘要、工具摘要和前台 PID；仅清理自身 forward/新启动服务，并检查 PID 创建时刻。capture.js/capture_cli.py 管理被动 observer 与 UI 触发，取消等待已发出的动作 drain，保留 Unicode 响应。新运行时已在 OnePlus 通过独立端到端搜索验证（time_descending、20 条、HTTP 200、新鲜 Cronet 响应），未调用旧 PhoneBackend 或主动 App API；实测仍持有旧工具全局兼容锁。新服务尚未注册正式消费者，多手机并发与分页仍待接入验证。
