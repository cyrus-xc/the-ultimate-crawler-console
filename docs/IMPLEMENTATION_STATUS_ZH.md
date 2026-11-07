# 实施记录 2026-11-07

当前为基础实施阶段，不能用本记录宣称迁移已完成或真实设备可用。

已完成的基础代码：持久化请求、幂等提交、设备锁与 fencing、effort、公平分配、断点/结果事务、设备失败转移、暂停/取消、worker 输入守卫、跨设备游标隔离、Python 客户端和鉴权 API。新库运行目录与 pipeline 数据分离，API 不写旧项目运行目录。

已复制 XHS Web 当前工作树的 137 个源码/许可证文件，保留相邻 headless_browser 模块及原 Go module。尚未删除原目录、切换原运行时或启动新 Web consumer。Douyin 尚未抽离。

手机侧保留原 observe-note-http.js、runtime_redaction.py 和 response matching/transport/share evidence 函数，新增 UI-trigger capture 单元。每次动作新建有界观察会话。尚未连接真实手机、未替换旧桥进程；所有手机操作能力仍待现场验证，不能将离线测试成功写成真实采集成功。

用户已确认：auto 单设备可运行；连续分页保持单设备；允许深链接导航；单页条数随 App；内部参数观察记录；五种搜索排序以全部 XHS 消费者支持为目标，实际缺项须给出设备/版本证据。

验证：

- 新后台 `npm test`：25 项 Node 和 6 项 Python 离线测试 PASS。只使用 fake adapters；付费 gates 强制关闭。
- XHS 源码 `go test ./cmd/crawler ./crawler ./configs ./cookies ./browser`：PASS；未启用真实浏览器 opt-in fixture。
- 原 pipeline 和 console 未修改运行代码，本阶段尚未执行其全量回归。最终迁移验收仍须执行原计划全部命令。

下一阶段：接入 Web 常驻会话并验证平台隔离；手机 UI 导航与接口参数逐项实测；让旧手机工具参加同一租约；再迁 pipeline 和控制台。当前服务不应接管生产执行。
