# 云邮管家

云邮管家是运行在 iPhone/iPad [Scripting](https://scripting.fun/) App 中的自托管统一邮箱客户端，支持 Gmail、Microsoft 365、QQ、网易邮箱和 Cloud Mail。每位使用者部署自己的 Cloudflare Worker 与 KV；仓库不提供公共中转服务，也不包含作者的 Worker、OAuth、邮箱或推送凭据。

> 当前为自托管测试版。请先阅读“安全边界”和“已知限制”，再向 Worker 提交邮箱授权。

## 功能

- Gmail 和 Microsoft 365 官方 OAuth 登录、收件箱同步、已读与删除
- QQ、网易 163/126、Yeah 授权码 IMAP 接入
- Cloud Mail 多邮箱统一收件箱
- HTML 邮件、附件、验证码识别、正文翻译和左滑删除
- Scripting Remote Push 后台新邮件通知
- OAuth token、IMAP 授权码、Remote Push Key 和后台管理令牌保存于 iOS Keychain
- 后台推送所需 refresh token 与 Push Key 使用 AES-256-GCM 加密后存入部署者自己的 Cloudflare KV

## 仓库结构

```text
app/       云邮管家 Scripting 项目
worker/    Cloudflare Worker、OAuth relay、IMAP gateway 和后台推送
```

## 准备工作

需要：

1. iPhone 或 iPad 安装 Scripting。
2. Cloudflare 账号。
3. Node.js 20+ 和 npm，用于推荐的 Wrangler 部署方式。
4. Gmail 功能需要 Google Cloud OAuth Web Client。
5. Microsoft 365 功能需要 Microsoft Entra 应用。
6. 后台通知需要在 Scripting Remote Push 中创建 send-only Subscription Key。

只启用需要的邮箱类型即可。例如只使用 Microsoft 365 时，可以不配置 Google secrets。

## 1. 部署 Worker

```sh
git clone REPOSITORY_URL
cd cloud-mail-manager/worker
npm install
cp wrangler.example.toml wrangler.toml
```

编辑 `wrangler.toml`：

- `name`：自己的 Worker 名称。
- `PUBLIC_ORIGIN`：部署后的完整 HTTPS origin，不能带路径。
- `MAIL_PUSH_STORE.id`：下一步创建的 KV namespace ID。

创建专用 KV：

```sh
npx wrangler kv namespace create MAIL_PUSH_STORE
```

把命令返回的 ID 写入 `wrangler.toml`。开发和生产环境不得共用同一 KV。

设置部署级秘密：

```sh
openssl rand -hex 32 | npx wrangler secret put RELAY_CLIENT_SECRET
openssl rand -hex 32 | npx wrangler secret put MAIL_PUSH_ADMIN_TOKEN
openssl rand -base64 32 | npx wrangler secret put MAIL_PUSH_ENCRYPTION_KEY
```

保存好生成的 `RELAY_CLIENT_SECRET` 和 `MAIL_PUSH_ADMIN_TOKEN`。前者需要写入本机客户端配置，后者只在 App 的 Keychain 设置中输入；`MAIL_PUSH_ENCRYPTION_KEY` 不进入客户端，但必须安全备份。

按需设置 OAuth secrets：

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put MICROSOFT_CLIENT_ID
# 仅 confidential Microsoft client 需要：
npx wrangler secret put MICROSOFT_CLIENT_SECRET
```

部署并验证：

```sh
npx wrangler deploy
curl https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/health
```

健康检查应返回 `ok`。`wrangler.example.toml` 已配置每分钟 Cron；Cloudflare 免费套餐的配额和 Cron 可用性以 Cloudflare 当前规则为准。

## 2. 配置 Google OAuth

1. 在 Google Cloud Console 创建项目并启用 Gmail API。
2. 配置 OAuth consent screen。
3. 创建 Web application OAuth client。
4. 添加精确回调：

```text
https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/oauth/google/callback
```

5. 将 Client ID 和 Client Secret 分别写入 Worker 的 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`。

请求范围固定为 Gmail 读取与修改。处于 Testing 状态的 Google 应用需要把自己的 Google 账号加入 Test users，refresh token 也可能受测试模式有效期限制。

## 3. 配置 Microsoft 365

1. 在 Microsoft Entra admin center 创建 App registration。
2. 选择支持个人 Microsoft 账号及组织账号的类型。
3. 添加 Web redirect URI：

```text
https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/oauth/microsoft/callback
```

4. 添加 delegated permissions：`User.Read`、`Mail.ReadWrite` 和 `offline_access`。
5. 将 Application (client) ID 写入 Worker 的 `MICROSOFT_CLIENT_ID`。
6. confidential client 才创建 secret 并写入 `MICROSOFT_CLIENT_SECRET`；否则不要设置。

## 4. 配置 Scripting 客户端

先从示例创建本地配置，再将 `app/` 整个目录导入 Scripting。项目名保持为 `云邮管家`，否则通知点击动作需要同步修改。

```sh
cp app/deployment-config.example.ts app/deployment-config.ts
```

编辑 `app/deployment-config.ts`：

```ts
export const DEPLOYMENT = {
  workerOrigin: "https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev",
  relayClientSecret: "与 Worker RELAY_CLIENT_SECRET 完全一致",
  gmailEnabled: true,
  microsoftEnabled: true,
  imapEnabled: true,
} as const
```

只开启已经完成 Worker 和 OAuth 配置的 provider。不要把改过的配置提交到公开 fork，也不要把 `RELAY_CLIENT_SECRET` 发给其他人。

运行云邮管家，在“邮箱账号”中添加邮箱。QQ/网易必须使用邮箱官网生成的 IMAP 客户端授权码，不能填写网页登录密码。

## 5. 开启后台推送

1. 在 Scripting 的 Remote Push 工具中创建 send-only Subscription Key。
2. 在云邮管家的 Remote Push 设置中绑定该 Key。
3. 打开“邮箱账号 → 邮件推送”。
4. 在“所有者令牌”中输入部署时生成的 `MAIL_PUSH_ADMIN_TOKEN`。
5. 点击“开启”。

首次开启只建立当前收件箱基线，不推送历史邮件。Worker 每分钟检查 Gmail/Microsoft 365；关闭功能会删除 KV 中的加密所有者配置。QQ/网易当前不参与关闭 App 后的后台推送。

## 更新

```sh
git pull
cd worker
npm install
npx wrangler deploy
```

更新客户端前备份本机配置。不要用仓库中的占位配置覆盖已经填写的 `deployment-config.ts`。

## 安全边界

- 每个 Worker 部署只服务一个所有者，不是公共多用户服务。
- Worker OAuth callback 不持久化 token；启用后台推送后，Gmail/Microsoft refresh token 与 Remote Push Key 会加密存入自己的 KV。
- OAuth token、IMAP 授权码和管理令牌保存在 iOS Keychain。
- 最近邮件快照包含发件人、主题、正文和附件元数据，保存在 Scripting 普通 Storage 中以加速启动；删除账号会清理对应缓存。
- `RELAY_CLIENT_SECRET` 会存在于本机脚本中，只能作为私有部署关联与基础滥用门槛，不能替代真正的用户身份系统。不要把配置后的客户端公开发布。
- 建议在 Cloudflare 为 Worker 增加 Rate Limiting/WAF 规则，并限制不需要的 provider。
- 仓库不收集遥测，不提供作者控制的邮件中转服务。

## 推送可靠性

当前每分钟 Cron + KV 是尽力而为的至少一次通知：极端情况下可能重复，短时间超过 10 封时最多补推最新 5 封。成功通知 ID 会短期去重，账号失败会指数退避。要求更强保证时，应升级为 Gmail History、Microsoft Graph delta/webhook，以及 Durable Object 或 D1 outbox + Queue。

## 故障排查

- `redirect_uri_mismatch`：OAuth 后台回调地址与 `PUBLIC_ORIGIN` 不一致。
- `401 Unauthorized`：客户端 relay 或后台所有者令牌与 Worker secret 不一致。
- `invalid_grant`：授权已撤销或 refresh token 失效，删除账号后重新授权。
- 没有后台通知：检查 Cron、KV binding、Remote Push Key、Worker secrets 和账号页推送状态。
- Google 登录可用但后台检查失败：确认 Worker 同时配置了 Google Client ID/Secret。

## 许可证

MIT。详见 [LICENSE](LICENSE)。第三方服务及 Scripting App 受各自条款约束。
