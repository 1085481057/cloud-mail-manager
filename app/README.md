# 云邮管家 Scripting 客户端

此目录是可导入 Scripting App 的完整项目。项目名应保持为 `云邮管家`，否则后台通知点击动作需要同步修改。

部署前先完成仓库根目录 [README](../README.md) 中的 Cloudflare Worker、Google OAuth 和 Microsoft Entra 配置，然后复制 `deployment-config.example.ts` 为不提交的 `deployment-config.ts` 并编辑：

```ts
export const DEPLOYMENT = {
  workerOrigin: "https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev",
  relayClientSecret: "与 Worker RELAY_CLIENT_SECRET 一致",
  gmailEnabled: true,
  microsoftEnabled: true,
  imapEnabled: true,
} as const
```

只开启已经部署成功的 provider。配置后的文件含部署关联凭据，不应提交到公开 fork。

邮箱 OAuth token、IMAP 授权码、Remote Push Key 和后台推送所有者令牌保存在 iOS Keychain。为加快启动，最近邮件正文快照保存在 Scripting 普通 Storage；删除账号会清理对应账号缓存。
