# 手机 UI 驱动消费者验收（2026-11-08）

消费者位于 `adapters/xhs-phone/consumer.js`，注册入口是 `service/phone_adapters.js`。
保留 App 正常导航、点击、滑动触发请求；数据来自被动 HTTP 响应观察，不使用 OCR 解析内容，不调用 App 内部数据服务方法。

## 实现

- 显式 serial、每设备租约、每条 ADB 命令的 fencing 和持久化执行记录；两台手机各有独立 Frida forward、剪贴板端口和 UI 控件缓存。
- 受信运行时 setup/cleanup 使用同一输入网关。HTTP 不接受任意 su、push、forward；cleanup 仅允许固定清理命令，失效 lease 始终被拒绝。
- 手机 App 登录/验证页面和响应失败归到设备的平台健康状态。在线 ADB 不代表 App 已登录。
- 所有已加载列表页保留；max_items 是整页后的停止目标，不裁掉该页候选。主页回调先保存列表，再读取详情并发送 profile_note 业务决策；anchor 在详情前停止，skip_ids 只跳过详情。
- 页边界保存真实请求 cursor/上下文和 seen IDs。新执行回到入口重放去重，不把不透明 cursor 注入 App。首屏必须对应实际首 cursor，不能把缓存主页的末页误当完整结果。
- 同次主页导航产生的用户资料和首屏 notes 均可被动保留，避免再次导航触发缓存末页。
- 连续翻页通过被动观察器的 response_ready 反馈停止触摸；不会把一次滑动误认为必定翻页，也不会在响应已到达后盲目连续滑动。同次动作已经触发的预加载页全部保存，使用最后一页实际游标继续，即使超过停止目标也不丢已读数据。
- 控件更新继续优先 UI 树。筛选弹层可能与底层快捷栏同时出现在树里；排序角色被限制在“最多点赞/评论/收藏”的菜单行范围，重复匹配仍拒绝。绑定只有在响应排序验证后更新。
- 手机和主机时钟不能直接比较：只读 observer clock RPC 测量 offset，观察时间映射到主机，同时保留原设备时间。正文发布时间不被更改。
- MIUI 对普通 shell 输入返回 INPUT_PERMISSION_REQUIRED 时，网关只对 `CRAWLER_ROOT_INPUT_SERIALS` 明确配置的设备、已经通过普通网关校验的数字 input tap/swipe/keyevent 使用相同 lease 的 root input。它仍是系统模拟触摸，没有 App 原生请求调用。

## 真机证据（私有，不提交原始响应）

| 设备 | 操作 | 结果与本机证据 |
| --- | --- | --- |
| OnePlus c7dee0b3 / XHS 9.51.0 | search.posts 最新 | 成功，20 条，`/tmp/phone-live-6c29sp/result.json` |
| OnePlus | post.detail | 成功，正确目标正文，`/tmp/phone-live-f4a1BZ/result.json` |
| OnePlus | profile.get | 成功，正确用户，`/tmp/phone-live-n8Qjpf/result.json` |
| OnePlus | profile.posts 首屏 | 成功，20 条，`/tmp/phone-live-cuYE5e/result.json` |
| OnePlus | post.comments | 成功，此目标实际 0 条，`/tmp/phone-live-Bvr8o3/result.json`；不等于多页评论验收 |
| Redmi 7e9c701e / XHS 9.51.0 | post.detail | 成功，`/tmp/phone-live-NV4gON/result.json` |
| Redmi | profile.get | 成功，`/tmp/phone-live-iDtkt2/result.json` |
| 两台同时执行 | 两个不同帖子详情 | 成功，最大同时 active=2、2 个 unit succeeded；`/tmp/phone-dual-nOSBxK/result.json`；两个设备均 ready，无 quarantine，无残留输入 |

以上操作读取了真实接口响应，记录的新鲜网络依据为 Cronet 回调（具体结果以各私有记录为准）。
Redmi 时钟慢约 1 秒导致早期 capture 超时，已修复并通过真机复测；不能将早期 timeout 当登录失败。
一次失败后的运行时清理不能确认，guardian 按设计保留；检查无输入子进程、命令表为空、forward 已清除，并确认旧 Frida 进程非本次所有后才显式恢复。记录在 `/tmp/phone-live-HJIq32/recovery.json`。没有杀死借用的旧 Frida 服务。

## 范围与后续实测

部署只注册配置明确列出的实际验证能力。发现手机不自动宣称全部能力已验证。
Redmi root input fallback 已通过正式服务 external lease 的 Back 与 swipe 验证；英文五种排序菜单已用 UI 树定位并完成 Latest 动作，但尚需 Chrome 依赖安装后的完整搜索响应与分页验证。place/search 和话题页面导航未被以上实测证明。完整评论回复数不足时必须保留 partial，不宣称完整。

离线运行：`node --test test/phone-consumer.test.js test/device-gateway.test.js test/phone-runtime.test.js test/navigation.test.js test/locator.test.js`、`python -B -m unittest discover -s test -p 'test_ui_capture.py'`。这些测试覆盖整页保留、分页、平台健康、业务决策、真实 shape 差异、root input 数字限制、时钟差与同次主页双回包；使用 fake 设备和回包，付费 gates 关闭。

## 依赖部署

Redmi 未安装 Chrome，现有 Unicode 剪贴板桥因此明确返回 CLIPBOARD_REQUIRED。新增 `PhoneProvisioner` 与 `tools/provision-phone-chrome.js`：只有持 external lease 的管理员可从设备 Package Manager 给出的 Chrome APK 路径导出签名包，或从本地固定 manifest 校验 SHA-256 后安装；不复制 Chrome 登录态/账号数据，不接收 HTTP 任意路径/安装命令。安装能力的离线测试已通过，实际安装结果另记。

正式后台额外验收：Redmi profile.get 请求 `47353ef6-5fea-4339-834e-eb623c107244` succeeded，证据 `/tmp/phone-production-smoke-se86Lm/result.json`。

分页协议离线验收（2026-11-08）：手机消费者、capture、gateway、runtime、导航、自愈定位与 provisioning 共 57 个 Node 测试通过；被动观察器 16 个 Python 测试通过。包括响应到达时停止滑动、同次预加载页不丢失、真实末游标断点、排除其他目标回包。多页真机结果以追加记录为准，离线验证不替代真机。

正式服务多页搜索已通过：OnePlus 请求 `83a6a40c-95e0-491d-8d03-fa853ce74e10` succeeded，2 个独立真实接口页共 20 + 19 条，停止目标为 25 条但整页保留 39 条，checkpoint.pages_read=2。证据 `/tmp/phone-production-smoke-vW0khh/result.json`。

Chrome provisioning 真机：从 OnePlus 成功导出 4 个 APK 并生成 SHA-256 manifest；Redmi 安装明确失败 `INSTALL_FAILED_USER_RESTRICTED`。Developer options 的 Install via USB 开关未启用，普通 UI 点击后仍关闭，未观察到企业策略提示或确认弹窗；未绕过安装限制，未复制账号数据。Redmi 搜索能力尚未启用。

正式服务非零评论分页通过：OnePlus 请求 `9f523ac9-f0df-413d-b29e-ef3525afe6b6` succeeded，2 页 15 + 15 = 30 条独立主评论，保留实际 23 条子回复及声明 32 条的计数差异；未达到整个目标的 113 条，不声称完整。证据 `/tmp/phone-production-smoke-lpISZq/result.json`。

正式服务主页多页通过：OnePlus 请求 `2fd53f13-97e8-471e-bbae-3638f66acf48` succeeded，2 个真实页 20 + 10 = 30 条，checkpoint.pages_read=2，停止目标 25 不裁页。证据 `/tmp/phone-production-smoke-b6SaNa/result.json`。

独立 UI 身份辅助尚未真机验收：请求 `fec32b2e-5429-4297-a261-af30db151d1c` 在队列以 QUEUE_DEADLINE 结束，没有取得设备或执行手机操作。不能将正文采集成功等同该 helper 成功。OnePlus 已全部释放给网页登录验证。

UI 身份辅助补验收成功：仅开启已指定的 XHS ui_identity 能力后，请求 `201a95ba-5166-475d-8d74-be90f2d34ced` succeeded，未传入现成分享链接，实际 `source=android_known_post`，note 与 author 身份均确认并获得手机分享链接。该目标没有 POI，未虚构地点身份。证据 `/tmp/phone-production-smoke-NcLg0v/result.json`。此前 QUEUE_DEADLINE 是能力未注册，不是手机操作失败。

地点辅助搜索导航已复用 XhsNavigation/UiLocator，去除已失效的固定控件 ID；地点候选、分享及 POI 证据判定保持原语义。相关离线 22 个测试通过，覆盖设备 lease、剪贴板端口、歧义停止和导航失败释放。

地点搜索辅助真机尚未通过：请求 `a5befdb1-6c68-44f1-91bf-5a442e66f2fd` 已执行正常搜索输入，但返回 `VENUE_SEARCH_TAB_MISSING`（最终请求因无替代设备为 NO_AVAILABLE_DEVICE）。一次后续 UI 检查确认当前可见分类为“全部、用户、商品、图片、视频、问点点”，没有“地点”。不将成功输入视作地点采集成功，生产应移除该未验证能力。证据 `/tmp/phone-production-smoke-Mqha7f/result.json`。DY UI helper 未取得已观察 video 目标，保持未启用。检查后 OnePlus lease 已释放，无后台串流。
