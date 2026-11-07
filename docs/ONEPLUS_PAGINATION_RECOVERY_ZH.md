# OnePlus GM1910 分页故障排查与恢复

## 已证实的原因

设备 `android:c7dee0b3`，错误 `PHONE_PAGE_RESPONSE_UNOBSERVED`。历史请求 `e6ddf8f8-b54b-41c9-8d05-e8ef9982f409` 是手动业务回调的 `profile.posts`：首屏20条、3篇详情成功，随后翻页失败。队列自动切换Web后该请求成功。

原实现通过深链接打开详情后只执行一次 Back，没有确认返回作者主页。原版本工作树 `7a5110f` 真机重放同一目标、同一跳过列表，复现完全相同路径：

- 首屏20条正常接口数据。
- 3篇详情均成功。
- 每次 Back 的 UI 树实际为“首页 / 发现”，不是作者主页。
- nextPage 在首页滑动12次后，抛出原错误。

因此这次错误不是“已证实封号”或“已证实游标失效”，而是后续滑动的页面错误。私有证据 `/tmp/oneplus-pagination-0d5p7c/{result,navigation,summary}.json`，不提交原始数据。

另有两个已复现问题：

1. 同一主页再次打开时，资料接口仍返回，但帖子列表没有新回包，现象符合App内存缓存复用。保持同一目标、重新导航和列表内下拉均没有目标回包；仅重启App、不清数据后再次进入，首屏20条立即出现。私有证据 `/tmp/oneplus-pagination-kOyoLf/` 与 `/tmp/oneplus-pagination-52UOXO/`。不能通过放宽游标校验假装取得第一页。
2. 离线回放证明：资料导航同时预加载两页时，旧 observer 只保留第一页。新增回归在旧实现失败，补丁保留同用户连续游标链。

## 隔离与安全

诊断期间使用生产设备租约、心跳、ADB执行网关和持久化命令 fencing；诊断预留在同一SQLite事务内完成，设备对scheduler始终保持 unavailable。没有清除登录态、App数据，没有直接调用App内部数据接口，没有启动视频串流。UI树只用于导航校验；数据仍由真实接口响应读取。

## 修复与验收

- 手动详情后不再盲目 Back。下一页 observer ready 后按目标 UID 恢复作者主页，UI 树确认页面类型，接口响应确认用户和游标。
- 保留预加载连续后续页；重放和非连续观察保留证据及候选，但不增加进度页数，也不驱动日期/锚点早停；连续链拒绝循环游标。
- 首屏零响应允许整次请求最多一次普通 App 重启，重新取得 PID；未知页面、登录和验证错误不走此恢复。
- 严格识别 OnePlus 电池管理器的“小红书异常”更新建议，只点击唯一“取消”，不更新 App，不泛化处理未知弹窗。
- 捕获失败返回有界、去敏的路径/字段名/匹配结果诊断，不记录查询值或凭证。

### 原故障真机对照

旧版同目标重放：20条首屏 + 3篇详情后在首页滑动失败（见上方证据）。修复版在同样冷启动前提下通过：私有证据 `/tmp/oneplus-pagination-y8ssjp/`，20条首屏 + 3篇详情 + 9条第二页，共29个不同帖子。两个实际 `/api/sns/v4/note/user/posted` 请求游标分别为空、严格等于上一页末游标；页面恢复 UI 树为“粉丝 / 笔记”。测试没有主动调用App内部数据方法。

### 重复采集与离线测试

不提前重启App、使用正式45秒capture超时的重复采集通过：`/tmp/oneplus-pagination-BXWrfk/`。首屏零响应后由消费者自动执行一次普通App重启，随后读取20 + 9条连续页、29个不同帖子和3篇详情。两页真实游标关系再次核验通过。

`PYTHON=/home/pcd/Development/xhs-analysis/.venv/bin/python npm test`：Node174项PASS，Python54项PASS；`git diff --check` PASS。首次使用不存在的仓库`.venv`导致测试启动失败；默认Python及observer专用Python缺少cv2，切换到现有完整开发环境后全量通过，没有跳过测试。

部署前确认全部租约和设备命令为0，重启`ultimate-crawler.service`，再通过本地supervisor恢复OnePlus（ready、无quarantine、无fault）。正式队列请求 `5f82e1c4-0c61-4881-b2ab-c4d3aa943769` 验收成功（`succeeded`）：20 + 9条、29个不同帖子、3篇详情；两页请求游标严格连续，无unit错误。私有证据 `/tmp/oneplus-production-2yesBv/result.json`。完成后再次确认 `health=ready`、`owner=null`、`quarantined=0`、`faults={}`、设备命令数0，已恢复正常调度。控制台仅在health异常/quarantine/fault时展示设备错误，历史错误事件保留供审计，不再形成当前告警。

### 验证边界

本次真机覆盖同一原失败目标的两页和三次详情读取，以及缓存首屏恢复。没有声称所有排序、无限页数或其他App版本均已验证。连续链对循环游标保守处理；预取终页若返回重复非空游标，可能需要额外一次正常翻页确认。
