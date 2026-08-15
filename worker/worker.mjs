import { handleImap, handleQQImap } from "./imap-provider.mjs"
import { handleBackgroundPush, handleForwardedEmail, handleMicrosoftWebhook, runBackgroundChecks } from "./background-push.mjs"

const GOOGLE_SCRIPT_CALLBACK = "scripting://oauth_callback/gmail-cloud-mail-manager"
const MICROSOFT_SCRIPT_CALLBACK = "scripting://oauth_callback/microsoft-cloud-mail-manager"
const AUTHORIZE_PATH = "/oauth/google/authorize"
const CALLBACK_PATH = "/oauth/google/callback"
const TOKEN_PATH = "/oauth/google/token"
const MICROSOFT_AUTHORIZE_PATH = "/oauth/microsoft/authorize"
const MICROSOFT_CALLBACK_PATH = "/oauth/microsoft/callback"
const MICROSOFT_TOKEN_PATH = "/oauth/microsoft/token"
const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const MICROSOFT_AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
const FORWARDED_CALLBACK_PARAMETERS = ["code", "error", "error_description", "error_uri", "state", "scope", "authuser", "prompt"]

function securityHeaders() {
  return {
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  }
}

function textResponse(message, status) {
  return new Response(message, { status, headers: { ...securityHeaders(), "Content-Type": "text/plain; charset=utf-8" } })
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { ...securityHeaders(), "Content-Type": "application/json; charset=utf-8" } })
}

function publicCallbackURL(env, path = CALLBACK_PATH) {
  const origin = new URL(env.PUBLIC_ORIGIN)
  if (origin.protocol !== "https:" || origin.pathname !== "/") throw new Error("PUBLIC_ORIGIN must be an HTTPS origin without a path")
  return `${origin.origin}${path}`
}

function requireConfiguration(env) {
  if (!env.PUBLIC_ORIGIN || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.RELAY_CLIENT_SECRET) {
    throw new Error("OAuth relay configuration is incomplete")
  }
}

function authorize(requestURL, env) {
  requireConfiguration(env)
  const target = new URL(GOOGLE_AUTHORIZE_URL)
  for (const [name, value] of requestURL.searchParams) target.searchParams.append(name, value)
  target.searchParams.set("client_id", env.GOOGLE_CLIENT_ID)
  target.searchParams.set("redirect_uri", publicCallbackURL(env))
  target.searchParams.set("response_type", "code")
  return new Response(null, { status: 302, headers: { ...securityHeaders(), Location: target.toString() } })
}

function callback(requestURL, scriptCallback = GOOGLE_SCRIPT_CALLBACK) {
  if (!requestURL.searchParams.has("code") && !requestURL.searchParams.has("error")) return textResponse("Missing OAuth code or error", 400)
  if (!requestURL.searchParams.has("state")) return textResponse("Missing OAuth state", 400)

  const target = new URL(scriptCallback)
  for (const name of FORWARDED_CALLBACK_PARAMETERS) {
    const value = requestURL.searchParams.get(name)
    if (value !== null) target.searchParams.set(name, value)
  }
  return new Response(null, { status: 302, headers: { ...securityHeaders(), Location: target.toString() } })
}

function requireDevelopmentSession(request, env) {
  return Boolean(env.RELAY_CLIENT_SECRET) && request.headers.get("authorization") === `Bearer ${env.RELAY_CLIENT_SECRET}`
}

function imapError(error) {
  const message = String(error?.message ?? error)
  if (message === "MAILBOX_CHANGED") return { status: 409, code: "MAILBOX_CHANGED", message: "邮箱状态已更新，请刷新收件箱后重试" }
  if (/拒绝/.test(message)) return { status: 401, code: "INVALID_CREDENTIAL", message }
  if (/授权码|地址|UID|不支持|未知/.test(message)) return { status: 400, code: "INVALID_REQUEST", message }
  return { status: 502, code: "PROVIDER_UNAVAILABLE", message: "邮箱服务暂时不可用，请稍后重试" }
}

async function jsonBody(request) {
  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().includes("application/json")) throw new Error("UNSUPPORTED_MEDIA_TYPE")
  try { return await request.json() } catch { throw new Error("INVALID_JSON") }
}

async function qqImap(request, env) {
  if (!requireDevelopmentSession(request, env)) return jsonResponse({ error: "Unauthorized" }, 401)
  let body
  try { body = await jsonBody(request) } catch (error) {
    return jsonResponse({ error: error.message === "UNSUPPORTED_MEDIA_TYPE" ? "Unsupported Media Type" : "请求格式无效" }, error.message === "UNSUPPORTED_MEDIA_TYPE" ? 415 : 400)
  }
  try {
    return jsonResponse(await handleQQImap(body))
  } catch (error) {
    const mapped = imapError(error)
    return jsonResponse({ error: mapped.message }, mapped.status)
  }
}

async function v1Imap(request, env, requestedAction) {
  if (!requireDevelopmentSession(request, env)) return jsonResponse({ error: { code: "UNAUTHORIZED", message: "登录已失效" } }, 401)
  let body
  try { body = await jsonBody(request) } catch (error) {
    const unsupported = error.message === "UNSUPPORTED_MEDIA_TYPE"
    return jsonResponse({ error: { code: unsupported ? "UNSUPPORTED_MEDIA_TYPE" : "INVALID_REQUEST", message: unsupported ? "请求必须使用 JSON" : "请求格式无效" } }, unsupported ? 415 : 400)
  }
  const action = requestedAction === "modify"
    ? body?.operation === "read" ? "read" : body?.operation === "delete" ? "delete" : ""
    : requestedAction
  if (!action) return jsonResponse({ error: { code: "INVALID_REQUEST", message: "不支持的邮件操作" } }, 400)
  try {
    const data = await handleImap({ ...body, action })
    return jsonResponse({ data })
  } catch (error) {
    const mapped = imapError(error)
    console.error("IMAP provider request failed", mapped.code)
    return jsonResponse({ error: { code: mapped.code, message: mapped.message } }, mapped.status)
  }
}

function microsoftAuthorize(requestURL, env) {
  if (!env.PUBLIC_ORIGIN || !env.MICROSOFT_CLIENT_ID) throw new Error("Microsoft OAuth configuration is incomplete")
  const target = new URL(MICROSOFT_AUTHORIZE_URL)
  for (const [name, value] of requestURL.searchParams) target.searchParams.append(name, value)
  target.searchParams.set("client_id", env.MICROSOFT_CLIENT_ID)
  target.searchParams.set("redirect_uri", publicCallbackURL(env, MICROSOFT_CALLBACK_PATH))
  target.searchParams.set("response_type", "code")
  target.searchParams.set("response_mode", "query")
  return new Response(null, { status: 302, headers: { ...securityHeaders(), Location: target.toString() } })
}

async function microsoftToken(request, env) {
  if (!env.PUBLIC_ORIGIN || !env.MICROSOFT_CLIENT_ID) return textResponse("Microsoft OAuth configuration is incomplete", 503)
  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) return textResponse("Unsupported Media Type", 415)
  const body = new URLSearchParams(await request.text())
  const grantType = body.get("grant_type")
  if (grantType !== "authorization_code" && grantType !== "refresh_token") return textResponse("Unsupported grant_type", 400)
  body.set("client_id", env.MICROSOFT_CLIENT_ID)
  if (env.MICROSOFT_CLIENT_SECRET) body.set("client_secret", env.MICROSOFT_CLIENT_SECRET)
  else body.delete("client_secret")
  if (grantType === "authorization_code") body.set("redirect_uri", publicCallbackURL(env, MICROSOFT_CALLBACK_PATH))
  else body.delete("redirect_uri")
  const upstream = await fetch(MICROSOFT_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: body.toString() })
  return new Response(upstream.body, { status: upstream.status, headers: { ...securityHeaders(), "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8" } })
}

async function token(request, requestURL, env) {
  requireConfiguration(env)
  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) return textResponse("Unsupported Media Type", 415)

  const body = new URLSearchParams(await request.text())
  const grantType = body.get("grant_type")
  if (grantType !== "authorization_code" && grantType !== "refresh_token") return textResponse("Unsupported grant_type", 400)
  if (body.get("client_secret") !== env.RELAY_CLIENT_SECRET) return textResponse("Unauthorized", 401)

  body.set("client_id", env.GOOGLE_CLIENT_ID)
  body.set("client_secret", env.GOOGLE_CLIENT_SECRET)
  if (grantType === "authorization_code") body.set("redirect_uri", publicCallbackURL(env))
  else body.delete("redirect_uri")

  const upstream = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  })
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { ...securityHeaders(), "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8" },
  })
}

export default {
  async fetch(request, env, context) {
    const requestURL = new URL(request.url)
    try {
      if (request.method === "GET" && requestURL.pathname === "/health") return textResponse("ok", 200)
      if (request.method === "GET" && requestURL.pathname === AUTHORIZE_PATH) return authorize(requestURL, env)
      if (request.method === "GET" && requestURL.pathname === CALLBACK_PATH) return callback(requestURL)
      if (request.method === "POST" && requestURL.pathname === TOKEN_PATH) return await token(request, requestURL, env)
      if (request.method === "GET" && requestURL.pathname === MICROSOFT_AUTHORIZE_PATH) return microsoftAuthorize(requestURL, env)
      if (request.method === "GET" && requestURL.pathname === MICROSOFT_CALLBACK_PATH) return callback(requestURL, MICROSOFT_SCRIPT_CALLBACK)
      if (request.method === "POST" && requestURL.pathname === MICROSOFT_TOKEN_PATH) return await microsoftToken(request, env)
      if ((request.method === "POST" || request.method === "GET") && requestURL.pathname === "/v1/webhooks/microsoft/mail") return await handleMicrosoftWebhook(request, env, context)
      if (request.method === "POST" && requestURL.pathname === "/qq/imap") return await qqImap(request, env)
      if (request.method === "POST" && requestURL.pathname === "/v1/mail/accounts/verify") return await v1Imap(request, env, "test")
      if (request.method === "POST" && requestURL.pathname === "/v1/mail/messages/list") return await v1Imap(request, env, "messages")
      if (request.method === "POST" && requestURL.pathname === "/v1/mail/messages/modify") return await v1Imap(request, env, "modify")
      if (requestURL.pathname === "/v1/push/config") {
        const response = await handleBackgroundPush(request, env, requestURL.pathname, jsonResponse)
        if (response) return response
      }
      if ([AUTHORIZE_PATH, CALLBACK_PATH, TOKEN_PATH, MICROSOFT_AUTHORIZE_PATH, MICROSOFT_CALLBACK_PATH, MICROSOFT_TOKEN_PATH, "/v1/webhooks/microsoft/mail", "/qq/imap", "/v1/mail/accounts/verify", "/v1/mail/messages/list", "/v1/mail/messages/modify", "/v1/push/config"].includes(requestURL.pathname)) return textResponse("Method Not Allowed", 405)
      return textResponse("Not Found", 404)
    } catch (error) {
      console.error("OAuth relay failed", error)
      return textResponse("OAuth relay configuration or upstream request failed", 502)
    }
  },
  async scheduled(_controller, env, context) {
    context.waitUntil(runBackgroundChecks(env))
  },
  async email(message, env) {
    await handleForwardedEmail(message, env)
  },
}
