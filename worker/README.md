# Unified mail gateway for Scripting

This Worker provides Google and Microsoft OAuth redirect relays, fixed-provider QQ/NetEase IMAP routes, and optional background push for 云邮管家. Each deployment has exactly one owner. It is not a shared multi-user service and has no installation or registration model. OAuth relay requests do not persist tokens; when background push is enabled, the owner's push key and Gmail/Microsoft refresh tokens are encrypted in that deployment's KV namespace. Email Routing and Cloud Mail webhook requests parse only the fields needed for a notification; message bodies and attachments are not persisted.

## Why callback-only relay is insufficient

Scripting `OAuth2.authorize({ callbackURL })` exposes one callback value. The helper uses it for callback handling and for the authorization-code token request. A callback-only HTTPS `302` relay would require the helper to listen on HTTPS while the final callback actually uses `scripting://`; that double-redirect behavior is undocumented and cannot be assumed.

This Worker instead gives the helper these endpoints:

```text
authorizeUrl   = https://YOUR_DOMAIN/oauth/google/authorize
accessTokenUrl = https://YOUR_DOMAIN/oauth/google/token
callbackURL    = scripting://oauth_callback/gmail-cloud-mail-manager
```

The Worker rewrites `redirect_uri` to this exact Google-registered URI in both authorization and initial token exchange:

```text
https://YOUR_DOMAIN/oauth/google/callback
```

Refresh requests contain no `redirect_uri` and are proxied through `/token` with the Worker-held Web client secret.

## Google configuration

Create a Google OAuth **Web application** client, enable Gmail API, and register exactly:

```text
https://YOUR_DOMAIN/oauth/google/callback
```

Set `PUBLIC_ORIGIN` in `wrangler.toml` to the exact production HTTPS origin. Set all credentials as Worker secrets, never `[vars]` or source code:

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put RELAY_CLIENT_SECRET
npx wrangler deploy
```

Use a stable custom domain in production. Changing between `workers.dev` and a custom domain changes `redirect_uri` and causes `redirect_uri_mismatch`.

## Scripting configuration

```ts
import { createOAuthCallbackURLScheme } from "scripting"

const callbackURL = createOAuthCallbackURLScheme("gmail-cloud-mail-manager")
const oauth = new OAuth2({
  consumerKey: "relay",
  consumerSecret: RELAY_CLIENT_SECRET,
  authorizeUrl: "https://YOUR_DOMAIN/oauth/google/authorize",
  accessTokenUrl: "https://YOUR_DOMAIN/oauth/google/token",
  responseType: "code",
  contentType: "application/x-www-form-urlencoded",
})

oauth.allowMissingStateCheck = false

const credential = await oauth.authorize({
  callbackURL,
  scope: "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify",
  state: secureRandomState,
  parameters: {
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
  },
})
```

The helper's `consumerSecret` is an independent shared relay secret, not Google's client secret. Worker `/token` rejects requests without it, then replaces helper credentials with the Google client ID/secret. The Worker also overwrites `redirect_uri` and authorization `response_type`. The current Gmail confidential-client flow intentionally does not use PKCE because Scripting's OAuth helper omits `client_secret` when PKCE is enabled, which is incompatible with this relay's development credential check.

Use `prompt=consent` when connecting/reconnecting and a refresh token is required. Store the returned access token, refresh token, and expiry in Keychain. This architecture keeps the Web client secret out of the script, but the token proxy is intentionally tied to this OAuth client and callback. Restrict Worker access further with Cloudflare controls if it is not meant for general use.

## Microsoft configuration

Register exactly `https://YOUR_DOMAIN/oauth/microsoft/callback` in a multi-tenant Microsoft Entra application. Configure `MICROSOFT_CLIENT_ID` as a Worker secret; only confidential clients need `MICROSOFT_CLIENT_SECRET`. The client uses Authorization Code + PKCE and requests `openid profile email offline_access Mail.ReadWrite` through the `common` tenant endpoint.

## QQ and NetEase IMAP

The `/v1/mail/accounts/verify`, `/v1/mail/messages/list`, and `/v1/mail/messages/modify` routes only accept fixed QQ, NetEase 163, NetEase 126, and Yeah presets. Hostname, IP, and port are never client-controlled. Read/delete mutations require both UIDVALIDITY and UID; a mailbox generation mismatch returns HTTP 409 `MAILBOX_CHANGED`. NetEase 163 sends RFC 2971 `ID` after `LOGIN` and before `SELECT INBOX`; the other presets do not send it. `RELAY_CLIENT_SECRET` is suitable only for this single-owner self-hosted model: keep the configured script private and add Cloudflare rate limiting where appropriate. A shared public gateway would require real user/device sessions, nonce replay protection, and provider-scoped authorization.

## Refresh

Refresh uses the same Worker token endpoint and does not open a browser:

```ts
const renewed = await oauth.renewAccessToken({
  refreshToken: saved.oauthRefreshToken,
})

const next = {
  oauthToken: renewed.oauthToken,
  oauthTokenExpiresAt: renewed.oauthTokenExpiresAt,
  oauthRefreshToken: renewed.oauthRefreshToken || saved.oauthRefreshToken,
}
```

Google normally omits `refresh_token` in a refresh response, so retaining the old token is mandatory. Refresh about 60 seconds before expiry. On a Gmail API `401`, refresh and retry once. On `invalid_grant`, delete the credential and require reconnect.

## Security properties

- Fixed callback path and fixed Scripting destination: no user-controlled open redirect.
- Callback forwards only an allowlist of OAuth response fields.
- `state` is required by Worker and validated by Scripting helper; `allowMissingStateCheck` stays false.
- `code_verifier`, refresh tokens, and token responses never appear in callback URLs.
- OAuth responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- Google client secret is stored only as a Cloudflare secret.
- Token proxy requires a separate relay secret and uses a fixed configured `PUBLIC_ORIGIN`, never the request Host.

The Worker is not an account session service and does not persist tokens. The relay secret is still extractable from a distributed script, so this remains appropriate for a private/self-managed deployment, not a public multi-user product. Do not log request bodies or callback query strings.

## Single-owner background push

The owner API is `PUT|GET|DELETE /v1/push/config`. It manages one encrypted record under a fixed KV key. Set these as independent Worker secrets:

```sh
openssl rand -hex 32 | npx wrangler secret put MAIL_PUSH_ADMIN_TOKEN
openssl rand -base64 32 | npx wrangler secret put MAIL_PUSH_ENCRYPTION_KEY
```

Enter the same `MAIL_PUSH_ADMIN_TOKEN` once in 云邮管家 under 邮箱账号 → 邮件推送 → 所有者令牌. The app stores it only in the device Keychain; it is never part of the shareable source configuration. `MAIL_PUSH_ENCRYPTION_KEY` must decode to exactly 32 bytes and must be backed up securely: losing or rotating it without first clearing/re-encrypting KV makes the stored owner configuration unreadable. Neither secret falls back to `RELAY_CLIENT_SECRET`.

Create a dedicated KV namespace for each Worker deployment and put its ID in that deployment's Wrangler config. Development and production must not share KV because they use the same fixed owner key. Production enables a one-minute Cron; development intentionally has neither KV nor Cron by default.

Updating the owner config is idempotent and preserves server-side cursors for unchanged accounts. The first scheduled check establishes a baseline and sends no historical notifications. The bounded polling fallback may report at most five newest messages when more than ten arrive between checks. Per-account exponential backoff limits repeated OAuth/provider failures.

This KV implementation provides best-effort, at-least-once notification behavior. A Worker termination after Remote Push accepts a message but before KV is updated can still duplicate that notification. Strong delivery guarantees require Durable Objects or D1 transactions plus an outbox/Queue. Gmail History API and Microsoft Graph delta/webhook subscriptions should replace bounded list polling for high-volume mailboxes.

Email Routing parses MIME in memory with the locked `postal-mime` dependency. The original message and attachments are not written to KV. Dedupe hashes expire after seven days, forwarded-message fingerprints expire after ten minutes, and an empty-MIME diagnostic containing only byte counts/content types/attachment sizes expires after 30 minutes.

## Cloud Mail webhook

A self-hosted Cloud Mail instance can push immediately to `POST /v1/webhooks/cloud-mail`. Set the same random value as the `CLOUD_MAIL_WEBHOOK_SECRET` secret in both Workers and send it as a Bearer token. The JSON body is limited to 32 KB and must contain a stable nonempty `id`; optional fields are `from`, `subject`, `preview`, and `code`. Successful IDs are deduplicated for seven days. This endpoint does not accept Cloud Mail JWTs and must not be exposed without its dedicated secret.

### Migration from the installation model

Deploy the new Worker, enter its owner token in the app's Keychain-backed push setting, and enable background push once to write `mail-push:owner-config:v2`. After validation, delete legacy KV keys with prefix `mail-push:v1:`. The new Worker neither reads nor lists those keys.

## Unified gateway deployment

The local source is a Wrangler ES module project: `worker.mjs` imports `imap-provider.mjs`, and `wrangler.toml` is the deployment entry. Run the following on a machine with the standard Cloudflare Wrangler CLI and an authenticated Cloudflare account:

```sh
npm install
cp wrangler.example.toml wrangler.toml
# Edit name, PUBLIC_ORIGIN, and the dedicated KV namespace ID.
npx wrangler deploy --dry-run
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put RELAY_CLIENT_SECRET
npx wrangler secret put MICROSOFT_CLIENT_ID
# Set only when using a confidential Microsoft client:
npx wrangler secret put MICROSOFT_CLIENT_SECRET
npx wrangler secret put MAIL_PUSH_ADMIN_TOKEN
npx wrangler secret put MAIL_PUSH_ENCRYPTION_KEY
# Optional, only for a self-hosted Cloud Mail webhook:
npx wrangler secret put CLOUD_MAIL_WEBHOOK_SECRET
npx wrangler deploy
```

Do not run the deploy command from this iOS Scripting shell: its npm implementation installs packages into a shared store but does not expose local CLI binaries, and Wrangler's platform runtime cannot be validated here. Before switching the client to QQ/NetEase or Microsoft, verify `/health`, `/v1/mail/*`, and `/oauth/microsoft/*` on the deployed origin. After deployment, verify `/health`, OAuth callbacks, authenticated `/v1/mail/*`, and authenticated `GET /v1/push/config` before entering mailbox or push credentials.

## Verification

Syntax check:

```sh
node --check worker.mjs
node --check background-push.mjs
node --check imap-provider.mjs
```

Required real-device tests:

1. Initial authorization reaches Google with the exact HTTPS callback, nonempty state, `access_type=offline`, and `prompt=consent`.
2. Google callback returns `302` to the fixed Scripting callback with unchanged `code` and `state`.
3. Scripting helper posts the code and `code_verifier` to Worker `/token`; Worker rewrites the HTTPS `redirect_uri`; response contains access token, nonempty refresh token, and expiry.
4. Gmail `users.getProfile` succeeds with the first access token.
5. Force expiry and call `renewAccessToken`; confirm a new access token is returned without browser UI, preserve the old refresh token if omitted, and call `users.getProfile` again.
6. Denied consent, wrong/missing state, reused authorization code, and revoked refresh token all fail without exposing secrets.

Static review and syntax checks cannot prove steps 1-5. They require a deployed Worker, actual Google client secrets, and an iPhone running Scripting.
