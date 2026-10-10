# 云邮管家 (Cloud Mail Manager)

云邮管家是运行在 iPhone/iPad [Scripting](https://scripting.fun/) App 中的自托管统一邮箱客户端，支持 Gmail、Microsoft 365、QQ 邮箱、网易 163/126/Yeah 以及自建 Cloud Mail。

每位使用者拥有并部署自己的 Cloudflare Worker；项目具备严格的隐私边界，不包含任何中心化数据收集，所有凭据均保存在本地 iOS Keychain 或部署者自己的加密存储中。

---

## ✨ 核心特性

- **多协议全覆盖**：
  - Gmail & Microsoft 365：官方 OAuth 2.0 授权、增量同步、已读/删除。
  - QQ 邮箱 & 网易 163/126/Yeah：客户端授权码 IMAP 极速直连。
  - Cloud Mail：自建多账号收件箱统一聚合。
- **极致 iOS 原生体验**：
  - SwiftUI 风格精美界面，深色模式自适应，支持自选方案图标。
  - 完整 HTML 邮件渲染、附件预览、一键退订、验证码高亮气泡。
  - 原生滑动操作：标记已读/未读、批量管理、移入垃圾箱。
- **毫秒级实时推送 (Scripting Remote Push)**：
  - 支持后台常驻推送，无需在后台保持 App 运行。
  - 智能跨账号指纹去重，消除重复通知与幽灵邮件。
- **高安全隐私防线**：
  - 敏感 Token 与授权码存储于 iOS 硬件级 Keychain。
  - 后台通知所需 Refresh Token 采用 AES-256-GCM 强加密存入专属存储。

---

## 🚀 极速安装指南

云邮管家采用模块化设计，你可以根据自己的需求选择轻量安装或完整部署。

### 方式一：轻量开箱即用（仅使用 QQ / 网易 / Cloud Mail）

如果你只需要管理 QQ 邮箱、网易 163/126、Yeah 邮箱或 Cloud Mail，**无需自行搭建任何后端**，直接导入手机即可使用：

1. 在 iPhone / iPad 上打开 **Scripting** App。
2. 新建脚本项目，命名为 `云邮管家`。
3. 将本项目 `app/` 目录下的所有文件复制导入到该脚本目录中。
4. 在 Scripting 中运行 `云邮管家`。
5. 点击右上角设置 → **邮箱账号** → **添加邮箱**：
   - **QQ 邮箱 / 网易邮箱**：在官方页面开启 IMAP 服务并生成 **16 位授权码**，填入即可连接。
   - **Cloud Mail**：输入你的 Cloud Mail 部署域名和登录密码。

---

### 方式二：完整部署（启用 Gmail / 微软 OAuth & 后台推送）

若需要使用 Google Gmail、Microsoft 365 官方授权登录，或需要锁屏后台新邮件通知，需部署专属 Cloudflare Worker：

#### 步骤 1：部署 Cloudflare Worker

```bash
git clone https://github.com/1085481057/cloud-mail-manager.git
cd cloud-mail-manager/worker
npm install
cp wrangler.example.toml wrangler.toml
```

1. 编辑 `wrangler.toml`：
   - `name`：填入你自定的 Worker 名称（如 `my-cloud-mail`）。
   - `PUBLIC_ORIGIN`：填入部署后的完整 Worker HTTPS 域名（例如 `https://my-cloud-mail.your-subdomain.workers.dev`）。

2. 创建 Durable Object 或 KV 存储：
   ```bash
   npx wrangler kv namespace create MAIL_PUSH_STORE
   ```
   将生成的 ID 填入 `wrangler.toml` 的 `MAIL_PUSH_STORE` 配置中。

3. 生成并配置核心 Secret 密钥：
   ```bash
   openssl rand -hex 32 | npx wrangler secret put RELAY_CLIENT_SECRET
   openssl rand -hex 32 | npx wrangler secret put MAIL_PUSH_ADMIN_TOKEN
   openssl rand -base64 32 | npx wrangler secret put MAIL_PUSH_ENCRYPTION_KEY
   ```
   > 💡 **请牢记记录好**：
   > - `RELAY_CLIENT_SECRET`：稍后需填入客户端 `deployment-config.ts`。
   > - `MAIL_PUSH_ADMIN_TOKEN`：在 App 内开启后台推送时作为管理凭证。
   > - `MAIL_PUSH_ENCRYPTION_KEY`：用于加密存储 Refresh Token 的主密钥，请妥善备份。

4. （可选）配置 Gmail & Microsoft OAuth 密钥：
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put MICROSOFT_CLIENT_ID
   # 仅 Confidential 模式需要：
   npx wrangler secret put MICROSOFT_CLIENT_SECRET
   ```

5. 部署上线：
   ```bash
   npx wrangler deploy
   ```
   部署完成后访问 `https://YOUR_WORKER.workers.dev/health`，若返回 `ok` 即表示后端运行正常！

---

#### 步骤 2：配置客户端部署文件

1. 在 `app/` 目录下复制配置文件模板：
   ```bash
   cp app/deployment-config.example.ts app/deployment-config.ts
   ```

2. 打开 `app/deployment-config.ts` 填入你的后端信息：
   ```typescript
   export const DEPLOYMENT = {
     workerOrigin: "https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev",
     relayClientSecret: "你在步骤 1 生成的 RELAY_CLIENT_SECRET",
     gmailEnabled: true,      // 已配置 Google OAuth 则开启
     microsoftEnabled: true,  // 已配置 Microsoft OAuth 则开启
     imapEnabled: true,       // 允许连接 QQ/网易 IMAP 网关
   } as const
   ```

3. 将整个 `app/` 目录导入 Scripting App（项目名必须为 `云邮管家`）。

---

#### 步骤 3：开启后台实时推送通知

1. 打开 Scripting App → 底部工具栏 → **Remote Push**。
2. 创建一个 Send-Only（仅推送）类型的 **Subscription Key** 并复制。
3. 打开云邮管家 → 右上角设置 → **邮件推送**：
   - 粘贴你的 **Remote Push Key**。
   - 输入你在步骤 1 生成的 **MAIL_PUSH_ADMIN_TOKEN**（所有者令牌）。
   - 点击 **测试推送**，手机收到测试通知后点击 **开启后台推送**。

---

## 📌 常见邮箱配置与注意事项

### 1. QQ 邮箱注意事项
- **必须使用专属授权码**：不能使用 QQ 密码。登录 [QQ 邮箱网页版](https://mail.qq.com) → 设置 → 账户 → 找到 “POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV服务” → 开启 IMAP 并生成 16 位授权码。
- **自动转发规则设置**：
  - 若使用 Cloudflare Email Routing 做邮件秒级转发推送，在 QQ 邮箱设置自动转发时，**请务必设置为“仅转发收件箱邮件”**，不要开启包含已发信件的全局转发规则，避免自发邮件触发重复通知。
  - 本客户端已内置智能跨账号去重：即使发件人是 `@qq.com`，只要收件方是 Gmail，也会精准归属 Gmail，绝不会误生成多余的 QQ 邮件副本。

### 2. 网易 163 / 126 / Yeah 邮箱
- 登录网易邮箱网页端 → 设置 → POP3/SMTP/IMAP → 开启 “POP3/SMTP/IMAP服务” 并新增**授权密码**。

### 3. Google Gmail OAuth 配置
- 在 Google Cloud Console 创建项目并启用 **Gmail API**。
- 创建 OAuth 2.0 Web Client，重定向 URI 严格设置为：
  `https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/oauth/google/callback`
- 处于测试阶段的应用，需在 OAuth 同意屏幕中将你的个人 Gmail 地址加入 **Test Users**。

### 4. Microsoft 365 / Outlook
- 在 Microsoft Entra (Azure Portal) 中注册应用，重定向 URI 严格设置为：
  `https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/oauth/microsoft/callback`
- 添加 Delegated 权限：`User.Read`、`Mail.ReadWrite`、`offline_access`。

---

## 🛠️ 项目目录结构

```text
cloud-mail-manager/
├── app/                        # Scripting 客户端前端源码
│   ├── index.tsx               # 首页交互、列表流式渲染、自愈去重
│   ├── api.ts                  # 多协议网络请求聚合调度
│   ├── imap.ts                 # QQ & 网易 IMAP 增量解析与下载
│   ├── gmail.ts                # Gmail 增量同步与详情抓取
│   ├── microsoft.ts            # Microsoft Graph 同步
│   ├── models.ts               # 数据模型与智能邮件指纹匹配器
│   ├── push.ts                 # Remote Push 本地/远端通信
│   ├── store.ts                # 快照持久化、Keychain 存取
│   └── deployment-config.ts    # [本地私有] 客户端连接凭证（不入库）
└── worker/                     # Cloudflare Worker 后端源码
    ├── worker.mjs              # 请求主路由、Email Routing 入口
    ├── background-push.mjs     # 邮件轮询、指纹防重、推送分发
    ├── imap-provider.mjs       # IMAP 会话管理网关
    └── wrangler.example.toml   # Worker 部署配置示例模板
```

---

## 🔒 安全与隐私

- **无中心化收集**：全套系统仅运行在你的 iOS 设备和你的 Cloudflare Worker 上。
- **加密落盘**：推送服务所需的 Refresh Token 使用 AES-256-GCM 加密，只有你掌握私钥。
- **邮件零留存**：Worker 处理邮件转发通知时仅在内存中提取标题与摘要，原始正文与附件绝不持久化到服务器。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
欢迎提出 Issue 与 Pull Request！
