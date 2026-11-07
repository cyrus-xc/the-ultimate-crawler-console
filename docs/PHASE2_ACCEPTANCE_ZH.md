# 第二阶段：持久化调度与设备隔离验收

日期：2026-11-08。范围：本地后台调度、租约与输入隔离，以及模拟消费者故障验收。本文不是生产启用记录。

## 已实现

- `service/scheduler.js` 持续轮询持久化队列，支持启动、单轮调度和关闭。SQLite 保存调度顺序；重启不会重置公平顺序或把过期设备当成安全空闲。
- `service/worker.js` 只向已注册 adapter 的设备领取任务。默认空 adapter registry 不领取任务，也不会因为 adapter 尚未接入而把历史设备标记为故障。
- 请求按持久化 dispatch 顺序轮转，继续使用既有 effort 和兼容能力筛选。独立设备可并行，每个设备一次只执行一个 work unit。
- 外部工具与 worker 共享设备租约。`assertLease` 校验 token、generation、期限及可选 owner/外部租约限定；每次输入、提交与续租均受 fencing 约束。
- `setPresence` 只在 ready/disconnected 间更新连接状态，不清除其他故障、平台暂停或 quarantine，也不因设备断线提前释放租约。
- `device_commands` 中仍有活动输入时，正常 acquire/release、worker finish 和 supervisor recovery 均被拒绝。结果与终态提交在事务内回滚，不能在输入未停止时提前释放设备。
- 正常关闭先中止 adapter 并等待输入结束；已停止的未完成任务回到队列，保留 checkpoint，不把设备错误标为故障。
- 执行超时触发 abort。adapter 未在停止期限内结束时，设备进入 quarantine，保留租约直到过期处理；迟到的本地 input/commit 被拒绝。设备不会自动重新分配。
- 失败转移保留已提交结果。换设备恢复时采用 replay/deduplicate，不能直接沿用另一设备的 opaque cursor；已有证据与观察时间不被重写。

## 11 项新增模拟验收

测试位于 `test/scheduler.test.js`，均使用临时 SQLite 与 fake adapter，不启动浏览器、不访问平台、不操作手机。

| 验收 | 通过条件 |
| --- | --- |
| 空消费者启动 | 持久化设备和请求保留，无执行 attempt、无故障标记 |
| 三类消费者并行 | fake XHS Web、XHS phone、Douyin Web 同时执行且各自独占；运行中新请求继续调度 |
| 外部锁与 fencing | 外部租约阻止 crawler 领取；续租有效，错误 owner 和旧 generation/token 被拒绝 |
| 连接状态变化 | 断线保留租约；重连不清除 quarantine、平台故障或 unavailable |
| 重启公平与过期隔离 | dispatch 顺序跨 SQLite 重开保留；过期租约不可提交，设备必须经停止确认后恢复 |
| 断线失败转移 | 已提交结果不丢失；健康消费者接手续作，跨设备 cursor 丢弃、已见 ID 保留 |
| 不响应停止 | close 在停止期限后返回，设备仍隔离；迟到 input/commit 不获准执行 |
| 正常关闭 | adapter 确认结束后释放租约，任务回队列，设备不被标坏 |
| 执行期限 | deadline 中止 fake adapter，确认结束后才释放并记录终态错误 |
| 活动输入保护 | device_commands 阻止 acquire/release/recover/finish；失败提交不留下部分事务写入 |
| 长任务心跳 | 操作超过初始租约时持续续租，正常完成且无误隔离 |

## 验证结果与边界

主任务在同步后的实际新仓库执行 `npm test`：**PASS，101 项 Node 测试、23 项 Python 测试**。测试入口保持 `ENABLE_TIKHUB_NETWORK=0`、`ENABLE_LLM_NETWORK=0`。

这些结果证明本次模拟场景中的协议与状态行为，不证明真实设备断线、Frida/ADB 输入停止、浏览器恢复或生产吞吐。当前没有自动启用真实消费者；仅注册或发现设备不代表其平台能力已验证。

输入 guardian、网关进程或 worker 崩溃后，数据库中的活动命令及 quarantine 必须保留。主机进程消失不等于手机/远端输入进程已经停止。需要 supervisor/操作员确认对应输入进程已停止或设备已隔离，再显式清理对应 command、处理过期租约并恢复设备。不得以超时、重启、PID 消失或重新发现设备为理由自动回收并继续输入。

## 后续阶段

1. 将真实平台 adapter 接入同一租约与命令生命周期，确保所有输入都经过 fencing，且 resolve/reject 前完成子进程和输入 writer 的停止。
2. 对每台手机、两个 Web 消费者逐项验证支持能力，验证后才登记能力；未验证排序/分页不得静默替代。
3. 接入 pipeline 队列客户端与业务回调断点，保留现有原始响应、证据、缓存时钟和业务选择规则。
4. 接入控制台设备、异常、队列与显式观看/接管流程；完成真机断线、人工接管、重启及生产切换验收后再启用真实消费者。

额外验收：HTTP 断连、独立 guardian 在服务 SIGKILL 后保留屏障、正常关闭释放屏障、强制取消或孤儿命令后关闭保留屏障均通过。原项目 AndroidWorker/AndroidAdb 经真实 HTTP 网关接入 fake ADB 的跨仓库测试通过：两手机并行、单手机独占、旧客户端被屏障阻止。没有真实手机操作。
