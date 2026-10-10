# mailbox-sync：发现与提交契约

本模块是独立候选实现，**尚未替换 `background-push.mjs` 的旧同步器，也未部署**。

```js
import { discoverMessages } from './mailbox-sync.mjs'

const { messages, checkpoint, more } = await discoverMessages(account, accessToken, 20)
// 必须先持久化 outbox；推荐和账号 checkpoint 放在同一存储事务。
await storage.transaction(async tx => {
  for (const message of messages) {
    // 用 provider + account.id + message.id 唯一键，insert-if-absent。
    await insertOutboxIfAbsent(tx, account, message)
  }
  await saveAccount(tx, { ...account, ...checkpoint })
})
Object.assign(account, checkpoint) // 事务成功后才更新内存账号
// more 为 true：安排下一轮，不能按“本轮 messages 为空”停止续跑。
```

上面 `storage`、`insertOutboxIfAbsent`、`saveAccount` 是接入方伪代码，不是本模块提供的函数。

## 输入、返回与持久化

- `provider`: `gmail` / `microsoft`；accessToken 由调用者续期，本模块不处理 OAuth。
- 首次启用时由服务端持久化 `pushEnabledAt`（Unix 毫秒数或 ISO 时间字符串），必须记录实际启用时刻，不能每次扫描重设。
- 新账号没有 `newestId` 或旧成功时间时，缺失启用时间明确报错，不默认“现在”、不默认全量历史。
- 旧账号有 `newestId`：读取该邮件详情，以 Gmail `internalDate` / Graph `receivedDateTime` 建立包含式边界，排除锚点自身、保留同一毫秒的其他邮件。不依赖列表中的锚点位置或排序。
- 旧锚点详情 404：仅当存在有效 `lastSuccessfulSyncAt` 时以其恢复；否则抛出 `MAILBOX_LEGACY_ANCHOR_DELETED_REQUIRES_BOUNDARY`，即使有 `pushEnabledAt` 也不自行猜测。
- 返回消息保持现有字段 `id/from/subject/preview/messageId`，新增 `receivedAt`（毫秒）。结果不保证按收件时间排序。
- checkpoint 为可 JSON 序列化对象：`mailboxSync`（version 1 状态）、`newestId: ""`（迁移后关闭旧锚点），只有完整周期完成时才有新的 `lastSuccessfulSyncAt`。
- `mailboxSync` 保存 mode、boundary、excludeId、pendingIds、nextPageToken、pageLoaded、cycleStartedAt，以及 Gmail 的 historyId/scanHistoryId、Graph 的 deltaLink、尚未提交的 finalCursor。Graph 的 nextPageToken 保存完整 nextLink。不得只挑部分字段保存。
- 每次调用最多一个 list/history/delta 页请求，最多 `min(floor(budget),20)` 个详情请求，包含旧锚点详情。budget 必须是至少 1 的有限数字。Gmail 扫描启动额外有一个 profile 请求，不计作列表页或详情。
- 已缓存 pendingIds 先处理，本轮不再拿下一页；大页可跨多次调用排空。即使单页超过 20 个 ID，也不会丢弃尾部。
- 404 只对单封详情视为已删除并跳过；非过期游标的页面错误、其他详情错误、网络失败、无效 JSON/时间/游标都抛错，无 checkpoint 返回，不修改任何 account 字段（含嵌套状态）。

## Gmail

首次或恢复扫描：先用 `/profile` 记录 historyId，再分页 `/messages` 查询 INBOX。查询时间向前扩一秒，详情以毫秒边界精确过滤，防止秒精度截断遗漏。扫描完成进入 `/history`，以扫描之前的 historyId 补扫描期间并发到达的邮件。

稳定增量使用 `/history?historyTypes=messageAdded&labelId=INBOX`；只收集 `messagesAdded[].message.id`，忽略宽泛的 `messages` 和标签变化；同页 ID 去重。中间页不提前采用响应 historyId，最后一页的详情也排空后才推进 historyId。

history 404、明确为失效分页 token 的 400 可恢复；不把所有 400 当游标过期。失败请求已消耗本轮页数，返回重扫状态，下一次调用才开始扫描。

## Microsoft

分页 `/me/mailFolders/inbox/messages/delta?$select=id&$top=100`；按 ID 请求详情以统一预算。忽略 `@removed` 项，最终 deltaLink 仅在详情排空后成为正式游标。初始 delta 不加时间 `$filter`，避免 Graph 过滤 delta 的数量限制；本地详情过滤历史意味着大收件箱首次同步可能很慢。

对读取的以及服务端返回的 nextLink/deltaLink 校验 HTTPS origin 必须为 `https://graph.microsoft.com`，拒绝凭据、片段和相对 URL；所有 fetch 设置 `redirect: "error"`。不改写 opaque token。

410 / 已知无效同步状态错误码进入重扫，不把鉴权、限流、普通 400/404 当作重置理由。

## 恢复语义

正式增量游标过期：以 `max(原始边界,lastSuccessfulSyncAt)` 重扫；没有成功时间则明确报错。尚未完成过初始扫描的临时分页 token 失效，可从已保存的启用/迁移边界重新开始。

成功时间使用扫描周期**开始时间**，不使用末页完成时刻；部分页不能推进成功时间。这样长批次中断恢复保留时间重叠。重复发现是允许的，必须由 account 维度的稳定 ID outbox 去重。

## 测试

在 worker 目录执行：

```sh
node test-mailbox-sync.cjs
```

仅 `require('fs')` 读取源码，`new Function` 在剥除 export 后注入假的 fetch 和时钟。无 npm、无真实网络、不会修改 Worker 账号或生产数据。模拟覆盖分页续跑、137 封积压、详情预算、初始化历史过滤、同时间边界、锚点删除、过期恢复、错误批次回滚、来源校验、并发到达补偿等。

## 尚未完成 / 不能保证的边界

1. **没有接入后台调用、持久化 outbox 事务、more 调度或配置迁移**。调用方须保留 mailboxSync，服务端准确填写 pushEnabledAt，串行执行同一账号发现及提交，避免旧 checkpoint 覆盖新状态。现有 background-push 仍走旧逻辑。
2. **没有真实 Gmail/Graph 集成测试或部署**。分页 token 的具体错误文案/错误码仍需线上验证；未识别的错误安全失败，不静默重放。
3. **不是 exactly-once**。扫描与 history 交叠、Graph 更新、跨页重复、恢复重扫以及 outbox 插入后进程中断可重复发现；必须稳定 ID 去重，保留足够长的去重记录。不能按主题和发件人去重。
4. **过期 token + 迟到/回填旧收件时间**：只凭 lastSuccessfulSyncAt 时间重扫，无法恢复收件时间早于该时间但后发生导入/移动的邮件。仍有效的 Gmail history 可发现边界后的回填邮件；要恢复全部过期事件需更长重叠扫描窗口/长期 ID 账本等设计，当前未做。
5. **收件箱范围**：Gmail 仅 messagesAdded，不覆盖 labelsAdded 导致的旧邮件移入 INBOX；Graph delta 会有更新/移动，详情可能读到已经移出收件箱的邮件。本实现不额外查询现有文件夹或严格区分“新到达”和“旧消息更新”。
6. **详情 404 按需求跳过**，无法通知获取详情前已经删除或移走且旧 ID 失效的邮件；Graph 尚未启用 ImmutableId，移动可能改变 ID。
7. **大邮箱成本/延迟**：Graph 初始全收件箱扫描每 20 个详情分批；页条目数量并无客户端截断，pendingIds 大小取决于服务端页。未加总内存上限、请求超时、限流退避和公平调度。Gmail 首次 messages.list 也不是严格快照；history 起点减少并发遗漏但无法替代服务端快照保证。
8. **时钟与邮件时间可信度**：成功时间使用 Worker 时钟，未做 provider 时钟偏差校正；启用/迁移边界按服务端收件时间定义，不以用户可伪造的 Date 邮件头作为依据。
