import {
  AppEvents, Button, ContentUnavailableView, Divider, HStack, Image, List, Navigation, NavigationLink,
  NavigationStack, Picker, ProgressView, Script, ScrollView, Section, SecureField, Spacer,
  Text, TextField, Toggle, VStack, WebView, ZStack, gradient, useEffect, useMemo, useState,
} from "scripting"
import {
  createCloudMailAccount, deleteCloudMailAccount, deleteMessage, fetchAccountMessages, fetchOlderAccountMessages,
  fetchCloudMailAccounts, fetchCloudMailWebsiteConfig, loginCloudMail, markMessageRead,
  pinCloudMailAccount, renameCloudMailAccount, setCloudMailAllReceive,
} from "./api"
import { authorizeGmail, disconnectGmail, gmailOAuthConfigured, isGmailAuthorized } from "./gmail"
import { authorizeMicrosoft, disconnectMicrosoft, isMicrosoftAuthorized, microsoftOAuthConfigured } from "./microsoft"
import type { CloudMailRemoteAccount, MailAccount, MailMessage, Provider } from "./models"
import { providerColor, providerIcon, providerName } from "./models"
import { demoMessages, loadAccounts, loadMessageSnapshot, loadSecret, makeAccount, removeAccount, saveAccounts, saveMessageSnapshot, saveSecret } from "./store"
import { unsubscribeFromHtml, unsubscribeMessage } from "./unsubscribe"
import { testImapAccount } from "./imap"
import { imapGatewayConfigured } from "./mail-gateway-config"
import { clearBackgroundPush, configureBackgroundPush, hasBackgroundPushConfiguration, loadBackgroundPushAdminToken, loadBackgroundPushStatus, saveBackgroundPushAdminToken } from "./background-push"

declare function fetch(url: string, init?: any): Promise<any>

const formattedDateCache = new Map<string, string>()
const timestampCache = new Map<string, number>()

function messageTimestamp(value: string) {
  const cached = timestampCache.get(value)
  if (cached !== undefined) return cached
  const timestamp = new Date(value).getTime()
  const normalized = Number.isNaN(timestamp) ? 0 : timestamp
  timestampCache.set(value, normalized)
  if (timestampCache.size > 500) timestampCache.delete(timestampCache.keys().next().value!)
  return normalized
}

function formatDate(value: string) {
  const cached = formattedDateCache.get(value)
  if (cached !== undefined) return cached
  const date = new Date(value)
  const formatted = Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
  formattedDateCache.set(value, formatted)
  if (formattedDateCache.size > 500) formattedDateCache.delete(formattedDateCache.keys().next().value!)
  return formatted
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1)
  return `${(size / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

function mailBodyDocument(message: MailMessage) {
  const sourceHtml = message.html?.trim() || `<pre class="plain-text">${escapeHtml(message.body)}</pre>`
  const optimizedHtml = sourceHtml.replace(/<img\b(?![^>]*\bloading=)([^>]*)>/gi, '<img loading="lazy" decoding="async"$1>')
  const serializedHtml = JSON.stringify(optimizedHtml).replace(/</g, "\\u003c")
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>html,body{margin:0;min-height:100%;background:#fff}body{padding:16px;overflow-x:hidden;max-width:100%;box-sizing:border-box}.plain-text{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;width:100%;max-width:100%;box-sizing:border-box;margin:0;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#16181b}a,button{border-radius:8px}a[style*="background"],a[style*="background-color"],button{overflow:hidden;transition:opacity .15s}a[style*="background"]:active,a[style*="background-color"]:active,button:active{opacity:.72}</style></head><body><div id="mail-host"></div><script>(()=>{const html=${serializedHtml};const host=document.getElementById("mail-host");if(!host)return;host.style.visibility="hidden";const root=host.attachShadow({mode:"open"});const bodyStyleMatch=html.match(/<body[^>]*style="([^"]*)"[^>]*>/i);const bodyStyle=bodyStyleMatch?bodyStyleMatch[1]:"";const cleanedHtml=html.replace(/<\\/?body[^>]*>/gi,"");root.innerHTML=\`<style>:host{all:initial;width:100%;height:100%;font-family:-apple-system,Inter,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:14px;line-height:1.5;color:#16181b;word-break:break-word}h1,h2,h3,h4{font-size:18px;font-weight:700}p{margin:0}a{text-decoration:none;color:#007aff}a[style*='background'],a[style*='background-color'],td[bgcolor]>a:only-child,td[style*='background']>a:only-child,button{border-radius:12px!important;overflow:hidden;transition:opacity .15s ease,transform .15s ease}.mail-action-cell{border-radius:12px!important;overflow:hidden!important}a[style*='background']:active,a[style*='background-color']:active,td[bgcolor]>a:only-child:active,td[style*='background']>a:only-child:active,button:active{opacity:.78;transform:scale(.985)}.shadow-content{background:#fff;width:100%;max-width:100%;height:fit-content;min-width:0;border-radius:14px;overflow:hidden;overflow-wrap:anywhere;word-break:break-word;${'${bodyStyle}'}}img:not(table img){max-width:100%;height:auto!important}</style><div class="shadow-content">${'${cleanedHtml}'}</div>\`;root.querySelectorAll(\"a[style*='background'],a[style*='background-color']\").forEach(link=>{const cell=link.closest('td');if(cell)cell.classList.add('mail-action-cell')});const original=new Map();const nodes=()=>{const out=[];const walker=document.createTreeWalker(root.querySelector('.shadow-content'),NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){const parent=node.parentElement;if(!parent||parent.closest('script,style,noscript,textarea,input,select,option'))continue;if(node.nodeValue&&node.nodeValue.trim())out.push(node)}return out};window.__mailTranslation={read:()=>nodes().map(node=>node.nodeValue||''),apply:(values)=>nodes().forEach((node,index)=>{if(!original.has(node))original.set(node,node.nodeValue||'');if(values[index]!==undefined)node.nodeValue=values[index]}),restore:()=>{nodes().forEach(node=>{if(original.has(node))node.nodeValue=original.get(node)});original.clear()}};const reveal=()=>{host.style.visibility='visible';window.webkit?.messageHandlers?.mailBodyReady?.postMessage(true);requestAnimationFrame(()=>{const content=root.querySelector('.shadow-content');const width=host.parentElement?.clientWidth||0;const contentWidth=content?.scrollWidth||0;host.style.zoom=String(width&&contentWidth?Math.min(1,width/contentWidth):1)})};reveal()})()</script></body></html>`
}

const mailDocumentCache = new Map<string, string>()
const mailTranslationCache = new Map<string, string[]>()
let snapshotTimer: ReturnType<typeof setTimeout> | undefined
let pendingSnapshot: MailMessage[] | undefined
let inboxRefreshInFlight = false

function scheduleMessageSnapshot(messages: MailMessage[], delay = 180) {
  pendingSnapshot = messages
  if (snapshotTimer !== undefined) clearTimeout(snapshotTimer)
  snapshotTimer = setTimeout(() => {
    snapshotTimer = undefined
    const snapshot = pendingSnapshot
    pendingSnapshot = undefined
    if (snapshot) saveMessageSnapshot(snapshot)
  }, delay)
}
const googleTextCache = new Map<string, string>()
const GOOGLE_KEY_SCRIPT = "https://translate.googleapis.com/_/translate_http/_/js/k=translate_http.tr.en_US.YusFYy3P_ro.O/am=AAg/d=1/exm=el_conf/ed=1/rs=AN8SPfq1Hb8iJRleQqQc8zhdzXmF9E56eQ/m=el_main"
let googleApiKey = ""
let googleApiKeyAt = 0

async function getGoogleApiKey(force = false) {
  if (!force && googleApiKey && Date.now() - googleApiKeyAt < 20 * 60 * 1000) return googleApiKey
  try {
    const response = await fetch(GOOGLE_KEY_SCRIPT)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const source = await response.text()
    googleApiKey = source.match(/["']x-goog-api-key["']\s*:\s*["'](\w{39})["']/i)?.[1] || ""
  } catch {
    googleApiKey = ""
  }
  googleApiKeyAt = Date.now()
  return googleApiKey
}

async function requestGoogleHtml(texts: string[], retry = true): Promise<string[]> {
  const key = await getGoogleApiKey()
  if (!key) throw new Error("Google 翻译服务暂时不可用")
  const response = await fetch("https://translate-pa.googleapis.com/v1/translateHtml", {
    method: "POST",
    headers: { "Content-Type": "application/application/json+protobuf", "X-goog-api-key": key },
    body: JSON.stringify([[texts, "auto", "zh-CN"], "te"]),
  })
  if (!response.ok) {
    if (retry && [401, 403].includes(response.status)) {
      await getGoogleApiKey(true)
      return requestGoogleHtml(texts, false)
    }
    throw new Error(`Google 翻译请求失败（HTTP ${response.status}）`)
  }
  const payload = await response.json()
  const translated = payload?.[0]
  if (!Array.isArray(translated) || translated.length !== texts.length || translated.some(value => typeof value !== "string")) {
    throw new Error("Google 翻译返回格式不兼容")
  }
  return translated
}

async function translateWithGoogle(texts: string[]): Promise<string[]> {
  const results = new Array<string>(texts.length)
  const missing: Array<{ index: number; text: string }> = []
  texts.forEach((text, index) => {
    const cached = googleTextCache.get(text)
    if (cached !== undefined) results[index] = cached
    else missing.push({ index, text })
  })
  const batches: Array<typeof missing> = []
  let current: typeof missing = []
  let chars = 0
  for (const item of missing) {
    if (current.length && chars + item.text.length > 2_000) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(item)
    chars += item.text.length
  }
  if (current.length) batches.push(current)
  let next = 0
  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++]
      const translated = await requestGoogleHtml(batch.map(item => item.text))
      batch.forEach((item, index) => {
        results[item.index] = translated[index]
        googleTextCache.set(item.text, translated[index])
      })
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, batches.length) }, () => worker()))
  while (googleTextCache.size > 600) googleTextCache.delete(googleTextCache.keys().next().value!)
  return results
}

async function translateFast(translator: Translation | undefined, texts: string[], onGoogle: () => void): Promise<{ texts: string[]; engine: "apple" | "google" }> {
  const longMessage = texts.length >= 12 || texts.reduce((sum, text) => sum + text.length, 0) >= 1_200
  if (!translator || longMessage) {
    onGoogle()
    return { texts: await translateWithGoogle(texts), engine: "google" }
  }
  const apple = translateResilient(translator, texts).then(value => ({ texts: value, engine: "apple" as const }))
  let timer: ReturnType<typeof setTimeout> | undefined
  const google = new Promise<{ texts: string[]; engine: "google" }>((resolve, reject) => {
    timer = setTimeout(() => {
      timer = undefined
      onGoogle()
      translateWithGoogle(texts).then(value => resolve({ texts: value, engine: "google" }), reject)
    }, 2500)
  })
  try {
    const result = await Promise.any([apple, google])
    if (timer !== undefined) clearTimeout(timer)
    return result
  } catch {
    if (timer !== undefined) clearTimeout(timer)
    return apple
  }
}

async function translateResilient(translator: Translation, texts: string[], retry = 0): Promise<string[]> {
  if (!texts.length) return []
  try {
    return await translator.translateBatch({ texts, target: "zh" })
  } catch (error) {
    const message = String((error as any)?.message ?? error)
    if (!/cancel|cancellation/i.test(message)) throw error
    if (texts.length === 1) {
      if (retry >= 2) return texts
      await new Promise<void>(resolve => setTimeout(() => resolve(), 180 * (retry + 1)))
      return translateResilient(translator, texts, retry + 1)
    }
    const middle = Math.ceil(texts.length / 2)
    const left = await translateResilient(translator, texts.slice(0, middle))
    const right = await translateResilient(translator, texts.slice(middle))
    return [...left, ...right]
  }
}

function cachedMailBodyDocument(message: MailMessage) {
  const key = `${message.accountId}:${message.id}:${message.html?.length ?? message.body.length}`
  const cached = mailDocumentCache.get(key)
  if (cached) return cached
  const document = mailBodyDocument(message)
  mailDocumentCache.set(key, document)
  while (mailDocumentCache.size > 6) {
    const oldest = mailDocumentCache.keys().next().value
    if (oldest === undefined) break
    mailDocumentCache.delete(oldest)
  }
  return document
}

function MessageDetail({ message, account, onRead, onDeleted, onDeleteFailed }: { message: MailMessage; account?: MailAccount; onRead: () => void; onDeleted: () => void; onDeleteFailed: (error: unknown) => void }) {
  const dismiss = Navigation.useDismiss()
  const [busy, setBusy] = useState(false)
  const [translated, setTranslated] = useState(false)
  const [status, setStatus] = useState("")
  const [bodyReady, setBodyReady] = useState(false)
  const controller = useMemo(() => new WebViewController(), [])
  const translationKey = `${message.accountId}:${message.id}:${message.body.length}`
  const translationSupported = parseFloat(Device.systemVersion) >= 18
  const translator = useMemo(() => translationSupported ? new Translation() : undefined, [])
  const unsubscribeInfo = useMemo(() => message.unsubscribeUrl
    ? { url: message.unsubscribeUrl, oneClick: Boolean(message.unsubscribeOneClick) }
    : unsubscribeFromHtml(message.html ?? ""), [])

  async function performUnsubscribe() {
    if (!unsubscribeInfo || busy) return
    setBusy(true)
    setStatus("正在取消订阅…")
    try {
      const oneClick = await unsubscribeMessage({
        ...message,
        unsubscribeUrl: unsubscribeInfo.url,
        unsubscribeOneClick: unsubscribeInfo.oneClick,
      })
      setStatus(oneClick ? "已取消订阅" : "退订请求已提交，部分发件方可能稍后生效")
    } catch (error) {
      setStatus(`取消订阅失败：${String((error as any)?.message ?? error)}`)
    } finally { setBusy(false) }
  }

  async function translateBody() {
    setBusy(true)
    setStatus(translator ? "正在准备系统翻译…" : "正在准备 Google 翻译…")
    try {
      if (translated) {
        await controller.evaluateJavaScript("window.__mailTranslation?.restore(); return true")
        setTranslated(false)
        setStatus("")
        return
      }
      const cached = mailTranslationCache.get(translationKey)
      if (cached) {
        await controller.evaluateJavaScript(`window.__mailTranslation?.apply(${JSON.stringify(cached)}); return true`)
        setTranslated(true)
        setStatus("已使用翻译缓存")
        return
      }
      const sourceTexts = await controller.evaluateJavaScript<string[]>("return window.__mailTranslation?.read() ?? []")
      const uniqueTexts: string[] = []
      const uniqueIndex = new Map<string, number>()
      const nodeIndexes: number[] = []
      let total = 0
      let truncated = false
      for (const value of sourceTexts) {
        const normalized = value.trim()
        const chineseCount = (normalized.match(/[\u3400-\u9fff]/g) ?? []).length
        const latinCount = (normalized.match(/[A-Za-z]/g) ?? []).length
        const translatable = latinCount >= 2 && chineseCount <= latinCount * 1.5
        if (!normalized || !translatable) { nodeIndexes.push(-1); continue }
        let index = uniqueIndex.get(normalized)
        if (index === undefined) {
          if (total + normalized.length > 8_000 || uniqueTexts.length >= 80) {
            truncated = true
            nodeIndexes.push(-1)
            continue
          }
          index = uniqueTexts.length
          uniqueIndex.set(normalized, index)
          uniqueTexts.push(normalized)
          total += normalized.length
        }
        nodeIndexes.push(index)
      }
      if (!uniqueTexts.length) { setStatus("正文已经是中文或没有可翻译文字"); return }
      setStatus(`正在翻译 ${uniqueTexts.length} 段…`)
      const longMessage = uniqueTexts.length >= 12 || total >= 1_200
      const result = await translateFast(translator, uniqueTexts, () => setStatus(longMessage ? "正文较长，正在使用 Google 翻译…" : "系统翻译较慢，正在切换 Google 翻译…"))
      const translatedUnique = result.texts
      const translatedTexts = sourceTexts.map((source, index) => {
        if (nodeIndexes[index] < 0) return source
        const leading = source.match(/^\s*/)?.[0] ?? ""
        const trailing = source.match(/\s*$/)?.[0] ?? ""
        return `${leading}${translatedUnique[nodeIndexes[index]]}${trailing}`
      })
      mailTranslationCache.set(translationKey, translatedTexts)
      while (mailTranslationCache.size > 12) mailTranslationCache.delete(mailTranslationCache.keys().next().value!)
      await controller.evaluateJavaScript(`window.__mailTranslation?.apply(${JSON.stringify(translatedTexts)}); return true`)
      setTranslated(true)
      const engineName = result.engine === "google" ? "Google" : "系统"
      setStatus(truncated ? `已用${engineName}快速翻译正文主要内容` : `已用${engineName}翻译并保留原邮件布局`)
    } catch (error) {
      setStatus(`翻译失败：${String((error as any)?.message ?? error)}`)
    } finally { setBusy(false) }
  }

  function remove() {
    if (!account || !["cloudmail", "gmail", "qq", "netease163", "netease126", "yeah"].includes(account.provider) || busy) return
    setBusy(true)
    onDeleted()
    dismiss()
    deleteMessage(account, message.id).catch(onDeleteFailed)
  }

  useEffect(() => {
    controller.shouldAllowRequest = async request => {
      // loadHTML 的初始主文档是 other，且当前运行时 request.url 实际可能为 undefined。
      if (request.navigationType === "other" && !request.url) return true
      if (["formSubmitted", "formResubmitted"].includes(request.navigationType)) return false
      let url: URL
      try { url = new URL(request.url) } catch { return false }
      if (request.navigationType === "linkActivated") {
        if (unsubscribeInfo && url.href === unsubscribeInfo.url) {
          await performUnsubscribe()
          return false
        }
        if (["mailto:", "tel:"].includes(url.protocol)) {
          await Safari.openURL(url.href)
          return false
        }
        // Keep normal web links inside the mail WebView. This also keeps
        // landing pages and unsubscribe pages in the current mail context.
        return url.protocol === "http:" || url.protocol === "https:"
      }
      if (["about:", "data:", "cid:"].includes(url.protocol)) return true
      return request.method === "GET" && ["http:", "https:"].includes(url.protocol)
    }
    let mounted = true
    controller.addScriptMessageHandler("mailBodyReady", () => {
      if (mounted) setBodyReady(true)
      return true
    }).then(() => controller.loadHTML(cachedMailBodyDocument(message), account?.baseUrl)).then(loaded => {
      if (mounted && !loaded) setStatus("邮件正文加载失败，可先查看纯文本摘要")
    }).catch(error => {
      if (mounted) setStatus(`邮件正文加载失败：${String((error as any)?.message ?? error)}`)
    })
    if (account && ["cloudmail", "gmail", "qq", "netease163", "netease126", "yeah"].includes(account.provider) && message.unread) {
      markMessageRead(account, message.id).then(onRead).catch(console.error)
    }
    return () => { mounted = false; controller.dispose() }
  }, [])

  return (
    <VStack spacing={0} navigationTitle="邮件" navigationBarTitleDisplayMode="inline" translationHost={translator ?? undefined} toolbar={{
      topBarLeading: <Button title="返回" systemImage="chevron.left" action={dismiss} />,
      topBarTrailing: <Button title="分享" systemImage="square.and.arrow.up" action={() => ShareSheet.present([`${message.subject}\n\n${message.body}`])} buttonStyle="bordered" buttonBorderShape={{ roundedRectangleRadius: 10 }} />,
      bottomBar: <HStack spacing={24} padding={{ horizontal: 12, vertical: 8 }}>
        {message.verificationCode ? <Button title="复制验证码" systemImage="doc.on.doc" action={() => Pasteboard.setString(message.verificationCode ?? "")} disabled={busy} buttonStyle="bordered" buttonBorderShape={{ roundedRectangleRadius: 10 }} /> : null}
        <Button title={translated ? "显示原文" : "翻译"} systemImage="translate" action={translateBody} disabled={busy || !message.body.trim() || !bodyReady} buttonStyle="bordered" buttonBorderShape={{ roundedRectangleRadius: 10 }} />
        {unsubscribeInfo ? <Button title="取消订阅" systemImage="envelope.badge" action={performUnsubscribe} disabled={busy} buttonStyle="bordered" buttonBorderShape={{ roundedRectangleRadius: 10 }} /> : null}
        {["cloudmail", "gmail", "qq", "netease163", "netease126", "yeah"].includes(account?.provider ?? "") ? <Button title={account?.provider === "gmail" ? "移入垃圾箱" : "删除"} systemImage="trash" role="destructive" action={remove} disabled={busy} buttonStyle="bordered" buttonBorderShape={{ roundedRectangleRadius: 10 }} /> : null}
      </HStack>,
    }} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <VStack alignment="leading" spacing={10} padding={{ top: 14, leading: 16, bottom: 14, trailing: 16 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <HStack spacing={10} frame={{ maxWidth: "infinity" }}>
          <Image systemName="person.crop.circle.fill" font="title" foregroundStyle="systemGray3" />
          <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font="subheadline" fontWeight="semibold" lineLimit={1}>{message.from}</Text>
            <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{message.to ? `发送至 ${message.to}` : providerName(message.provider)}</Text>
          </VStack>
          <Text font="caption" foregroundStyle="secondaryLabel">{formatDate(message.date)}</Text>
        </HStack>
        <Text font="title3" fontWeight="semibold">{message.subject}</Text>
        {message.verificationCode ? (
          <Button action={() => Pasteboard.setString(message.verificationCode ?? "")} buttonStyle="bordered" buttonBorderShape={{ roundedRectangleRadius: 12 }}>
            <HStack><Text font="caption" foregroundStyle="secondaryLabel">验证码</Text><Spacer /><Text font="title3" fontWeight="semibold" foregroundStyle="systemOrange">{message.verificationCode}</Text><Image systemName="doc.on.doc" foregroundStyle="systemOrange" /></HStack>
          </Button>
        ) : null}
      </VStack>
      <Divider />
      <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <WebView controller={controller} frame={{ maxWidth: "infinity", maxHeight: "infinity" }} />
        {busy ? <VStack><Spacer /><HStack spacing={8} padding={10}><ProgressView /><Text font="caption" foregroundStyle="secondaryLabel">{status}</Text></HStack></VStack> : null}
      </ZStack>
      {!busy && status ? <Text font="caption" foregroundStyle="secondaryLabel" padding={{ horizontal: 16, vertical: 6 }}>{status}</Text> : null}
      {(message.attachments?.length ?? 0) > 0 ? (
        <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Divider />
          <Text font="caption" fontWeight="semibold" foregroundStyle="secondaryLabel" padding={{ top: 8, leading: 16, bottom: 3, trailing: 16 }}>附件（{message.attachments?.length ?? 0}）</Text>
          {(message.attachments ?? []).map(attachment => (
            <Button key={attachment.id} action={() => attachment.url && Safari.openURL(attachment.url)} disabled={!attachment.url} buttonStyle="bordered" buttonBorderShape={{ roundedRectangleRadius: 10 }}>
              <HStack padding={{ top: 7, leading: 12, bottom: 7, trailing: 12 }}>
                <Image systemName="paperclip" foregroundStyle="systemBlue" />
                <Text lineLimit={1}>{attachment.filename}</Text>
                <Spacer />
                <Text font="caption" foregroundStyle="secondaryLabel">{formatBytes(attachment.size)}</Text>
              </HStack>
            </Button>
          ))}
        </VStack>
      ) : null}
    </VStack>
  )
}

function AddCloudMailboxView({ account, onChanged }: { account: MailAccount; onChanged: () => void }) {
  const dismiss = Navigation.useDismiss()
  const [prefix, setPrefix] = useState("")
  const [domain, setDomain] = useState("")
  const [domains, setDomains] = useState<string[]>([])
  const [verifyRequired, setVerifyRequired] = useState(false)
  const [status, setStatus] = useState("正在读取可用域名")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchCloudMailWebsiteConfig(account).then(config => {
      setDomains(config.domainList)
      setDomain(config.domainList[0] ?? "")
      setVerifyRequired(config.addVerifyOpen)
      setStatus(config.domainList.length ? "" : "站点未返回可用域名")
    }).catch(error => setStatus(String((error as any)?.message ?? error)))
  }, [])

  async function create() {
    const normalizedDomain = domain.startsWith("@") ? domain : `@${domain}`
    const email = `${prefix.trim()}${normalizedDomain}`
    setBusy(true)
    setStatus("正在创建")
    try {
      await createCloudMailAccount(account, email)
      onChanged()
      dismiss()
    } catch (error) { setStatus(String((error as any)?.message ?? error)) }
    setBusy(false)
  }

  return (
    <List navigationTitle="创建邮箱" navigationBarTitleDisplayMode="inline" toolbar={{ cancellationAction: <Button title="取消" action={dismiss} /> }}>
      <Section header={<Text>邮箱地址</Text>} footer={<Text>{verifyRequired ? "此部署启用了 Turnstile，原生创建可能被服务端拒绝，需要前往网页完成验证。" : "创建数量和可用域名由 Cloud Mail 角色权限控制。"}</Text>}>
        <TextField title="邮箱前缀" prompt="name" value={prefix} onChanged={setPrefix} />
        {domains.length ? (
          <Picker title="域名" value={domain} onChanged={(value: any) => setDomain(String(value))}>
            {domains.map(item => <Text key={item} tag={item}>{item}</Text>)}
          </Picker>
        ) : <TextField title="域名" prompt="@example.com" value={domain} onChanged={setDomain} />}
        <Button title={busy ? "正在创建" : "创建邮箱"} systemImage="plus.circle" action={create} disabled={busy || !prefix.trim() || !domain.trim() || verifyRequired} />
        {verifyRequired ? <Button title="前往网页创建" systemImage="safari" action={() => Safari.openURL(account.baseUrl ?? "")} /> : null}
        {status ? <Text font="caption" foregroundStyle="secondaryLabel">{status}</Text> : null}
      </Section>
    </List>
  )
}

function CloudMailboxEditor({ connection, mailbox, onChanged }: { connection: MailAccount; mailbox: CloudMailRemoteAccount; onChanged: () => void }) {
  const dismiss = Navigation.useDismiss()
  const [name, setName] = useState(mailbox.name)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")

  async function perform(action: () => Promise<void>, close = false) {
    setBusy(true); setStatus("")
    try {
      await action()
      setBusy(false)
      if (close) {
        // Keep the editor route stable after deletion; the parent reloads when
        // the user returns, avoiding a concurrent native navigation update.
        setStatus("已删除，请返回上一页")
      } else onChanged()
    } catch (error) { setStatus(String((error as any)?.message ?? error)); setBusy(false) }
  }

  return (
    <List navigationTitle={mailbox.email} navigationBarTitleDisplayMode="inline">
      <Section header={<Text>邮箱</Text>}>
        <Text>{mailbox.email}</Text>
        <TextField title="显示名称" value={name} onChanged={setName} />
        <Button title="保存名称" systemImage="checkmark" action={() => perform(() => renameCloudMailAccount(connection, mailbox.accountId, name))} disabled={busy || !name.trim()} />
      </Section>
      <Section header={<Text>收件设置</Text>} footer={<Text>Cloud Mail 同一时间最多有一个统一收件邮箱。再次点击当前邮箱会关闭统一收件。</Text>}>
        <Button title={mailbox.allReceive === 1 ? "关闭统一收件" : "设为统一收件箱"} systemImage="tray.full" action={() => perform(() => setCloudMailAllReceive(connection, mailbox.accountId))} disabled={busy} />
        <Button title="置顶邮箱" systemImage="pin" action={() => perform(() => pinCloudMailAccount(connection, mailbox.accountId))} disabled={busy} />
      </Section>
      <Section>
        <Button title="删除邮箱" systemImage="trash" role="destructive" action={() => perform(() => deleteCloudMailAccount(connection, mailbox.accountId), true)} disabled={busy || mailbox.email === connection.address} />
        {mailbox.email === connection.address ? <Text font="caption" foregroundStyle="secondaryLabel">登录主邮箱不能删除</Text> : null}
        {status ? <Text font="caption" foregroundStyle="systemRed">{status}</Text> : null}
      </Section>
    </List>
  )
}

function CloudMailboxesView({ connection, onConnectionChanged }: { connection: MailAccount; onConnectionChanged: () => void }) {
  const [mailboxes, setMailboxes] = useState<CloudMailRemoteAccount[]>([])
  const [selectedId, setSelectedId] = useState(connection.remoteAccountId)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState("")

  async function reload() {
    setLoading(true); setStatus("")
    try {
      const list = await fetchCloudMailAccounts(connection)
      setMailboxes(list)
      const selected = list.find(item => item.accountId === connection.remoteAccountId)
      if (selected) {
        const accounts = loadAccounts()
        const index = accounts.findIndex(item => item.id === connection.id)
        if (index >= 0) { accounts[index] = { ...accounts[index], allReceive: selected.allReceive }; saveAccounts(accounts); onConnectionChanged() }
      }
    } catch (error) { setStatus(String((error as any)?.message ?? error)) }
    setLoading(false)
  }

  function selectMailbox(mailbox: CloudMailRemoteAccount) {
    const accounts = loadAccounts()
    const index = accounts.findIndex(item => item.id === connection.id)
    if (index >= 0) {
      accounts[index] = { ...accounts[index], remoteAccountId: mailbox.accountId, address: mailbox.email, allReceive: mailbox.allReceive }
      saveAccounts(accounts)
      setSelectedId(mailbox.accountId)
      onConnectionChanged()
      setStatus(`当前收件邮箱：${mailbox.email}`)
    }
  }

  useEffect(() => { reload() }, [])

  return (
    <List navigationTitle="Cloud Mail 邮箱" refreshable={reload} toolbar={{
      topBarTrailing: <Button title="创建" systemImage="plus" action={() => Navigation.present(<AddCloudMailboxView account={connection} onChanged={reload} />)} />,
    }} overlay={!loading && !mailboxes.length ? <ContentUnavailableView title="暂无邮箱" systemImage="tray" description={status || "创建一个新邮箱"} /> : undefined}>
      {loading ? <HStack><ProgressView /><Text foregroundStyle="secondaryLabel">正在读取邮箱</Text></HStack> : null}
      {mailboxes.map(mailbox => (
        <Section key={mailbox.accountId}>
          <HStack>
            <Button action={() => selectMailbox(mailbox)}>
              <HStack spacing={12}>
                <Image systemName={mailbox.accountId === selectedId ? "checkmark.circle.fill" : "circle"} foregroundStyle={mailbox.accountId === selectedId ? "systemGreen" : "secondaryLabel"} />
                <VStack alignment="leading" spacing={3}>
                  <Text fontWeight="semibold">{mailbox.name || mailbox.email}</Text>
                  <Text font="caption" foregroundStyle="secondaryLabel">{mailbox.email}</Text>
                </VStack>
              </HStack>
            </Button>
            <Spacer />
            {mailbox.allReceive === 1 ? <Image systemName="tray.full.fill" foregroundStyle="systemOrange" /> : null}
            <NavigationLink destination={<CloudMailboxEditor connection={connection} mailbox={mailbox} onChanged={reload} />}><Image systemName="ellipsis.circle" /></NavigationLink>
          </HStack>
        </Section>
      ))}
      {status ? <Section><Text font="caption" foregroundStyle="secondaryLabel">{status}</Text></Section> : null}
    </List>
  )
}

function AccountEditor({ initial, initialProvider, autoStartAuthorization = false, onSaved }: { initial?: MailAccount; initialProvider?: Provider; autoStartAuthorization?: boolean; onSaved: () => void }) {
  const dismiss = Navigation.useDismiss()
  const seed = initial ?? makeAccount(initialProvider ?? "cloudmail")
  const [provider, setProvider] = useState<Provider>(seed.provider)
  const [name, setName] = useState(seed.name)
  const [address, setAddress] = useState(seed.address)
  const [baseUrl, setBaseUrl] = useState(seed.baseUrl ?? "")
  const [inboxPath] = useState(seed.inboxPath ?? "/api/email/list")
  const [secret, setSecret] = useState(provider === "cloudmail" ? "" : initial ? loadSecret(initial.id) : "")
  const [enabled, setEnabled] = useState(seed.enabled)
  const [loginStatus, setLoginStatus] = useState(initial && loadSecret(initial.id) ? "已登录" : "未登录")
  const [loggingIn, setLoggingIn] = useState(false)
  const [authorizing, setAuthorizing] = useState(false)
  const [connectingQQ, setConnectingQQ] = useState(false)
  const gmailAuthorized = provider === "gmail" && isGmailAuthorized(seed.id)
  const microsoftAuthorized = provider === "microsoft" && isMicrosoftAuthorized(seed.id)
  const isImapProvider = ["qq", "netease163", "netease126", "yeah"].includes(provider)

  function persist() {
    const accounts = loadAccounts()
    const latest = accounts.find(item => item.id === seed.id)
    const account: MailAccount = { ...(latest ?? seed), provider, name: name.trim() || providerName(provider), address: address.trim(), baseUrl: baseUrl.trim(), inboxPath: "/api/email/list", enabled }
    const index = accounts.findIndex(item => item.id === account.id)
    if (index >= 0) accounts[index] = account
    else accounts.push(account)
    saveAccounts(accounts)
    if (isImapProvider) saveSecret(account.id, secret)
    onSaved()
    dismiss()
  }

  async function connectGmail() {
    const account: MailAccount = { ...(loadAccounts().find(item => item.id === seed.id) ?? seed), provider: "gmail", name: name.trim() || "Gmail", address: address.trim(), enabled }
    const accounts = loadAccounts()
    const index = accounts.findIndex(item => item.id === account.id)
    if (index >= 0) accounts[index] = account
    else accounts.push(account)
    saveAccounts(accounts)
    setAuthorizing(true)
    setLoginStatus("正在打开 Google 授权")
    try {
      const updated = await authorizeGmail(account)
      setAddress(updated.address)
      setName(updated.name)
      setLoginStatus("Google 已连接")
      onSaved()
    } catch (error) {
      setLoginStatus(String((error as any)?.message ?? error))
    } finally { setAuthorizing(false) }
  }

  function disconnectGoogle() {
    disconnectGmail(seed.id)
    setLoginStatus("已断开 Google 连接")
    onSaved()
  }

  async function connectMicrosoft() {
    const account: MailAccount = { ...(loadAccounts().find(item => item.id === seed.id) ?? seed), provider: "microsoft", name: name.trim() || "Microsoft 365", address: address.trim(), enabled }
    setAuthorizing(true)
    setLoginStatus("正在打开 Microsoft 365 授权")
    try {
      const updated = await authorizeMicrosoft(account)
      setAddress(updated.address)
      setName(updated.name)
      setLoginStatus("Microsoft 365 已连接")
      onSaved()
    } catch (error) { setLoginStatus(String((error as any)?.message ?? error)) }
    finally { setAuthorizing(false) }
  }

  function disconnectMicrosoftAccount() {
    disconnectMicrosoft(seed.id)
    setLoginStatus("已断开 Microsoft 365 连接")
    onSaved()
  }

  const imapAuthorizationPortal: Partial<Record<Provider, string>> = {
    qq: "https://wx.mail.qq.com/account",
    netease163: "https://mail.163.com/?dv=pc",
    netease126: "https://mail.126.com/",
    yeah: "https://www.yeah.net/",
  }

  function authorizationCodeFromText(value: string | null) {
    const source = value?.trim() ?? ""
    if (!source) return ""
    if (provider === "qq") {
      const compact = source.replace(/\s+/g, "")
      if (/^[A-Za-z0-9]{16}$/.test(compact)) return compact
      return source.match(/(?:^|[^A-Za-z0-9])([A-Za-z0-9]{16})(?=$|[^A-Za-z0-9])/)?.[1] ?? ""
    }
    if (provider === "netease163") return /^[A-Za-z0-9]{16}$/.test(source) ? source : ""
    const compact = source.replace(/\s+/g, "")
    return /^[A-Za-z0-9_-]{6,64}$/.test(compact) ? compact : ""
  }

  async function pasteAuthorizationCode(showMissingMessage = true) {
    const pasted = authorizationCodeFromText(await Pasteboard.getString())
    if (!pasted) {
      if (showMissingMessage) setLoginStatus(`剪贴板里没有可用的${providerName(provider)}授权码`)
      return ""
    }
    setSecret(pasted)
    setLoginStatus(`授权码已填入（尾号 ${pasted.slice(-4)}），请连接邮箱`)
    return pasted
  }

  async function visibleImapAddress(web: WebViewController) {
    const domains: Partial<Record<Provider, string>> = { qq: "qq.com", netease163: "163.com" }
    const domain = domains[provider]
    if (!domain) return ""
    try {
      const candidates = await web.evaluateJavaScript<string[]>(`
        const emails = []
        const visit = currentWindow => {
          try {
            const text = currentWindow.document.body?.innerText ?? ""
            emails.push(...(text.match(/[A-Z0-9._%+-]+@(?:qq\\.com|163\\.com)\\b/gi) ?? []))
            for (const frame of currentWindow.frames) visit(frame)
          } catch {}
        }
        visit(window)
        return [...new Set(emails.map(email => email.toLowerCase()))]
      `)
      const expected = new RegExp(`^[^\\s@]+@${domain.replace(".", "\\.")}$`, "i")
      return candidates?.find(item => expected.test(item)) ?? ""
    } catch {
      return ""
    }
  }

  async function openImapAuthorization() {
    const url = imapAuthorizationPortal[provider]
    if (!url || authorizing || connectingQQ) return
    const web = new WebViewController()
    const pasteboardChangeCount = await Pasteboard.changeCount
    if (provider === "qq" || provider === "netease163") {
      web.setCustomUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
    }
    if (provider === "qq" || provider === "netease163") {
      web.shouldAllowRequest = async request => {
        if (!request.url) return true
        if (provider === "qq") {
          try {
            const host = new URL(request.url).hostname.toLowerCase()
            return host !== "wap.mail.qq.com" && host !== "w.mail.qq.com"
          } catch { return true }
        }
        if (request.navigationType === "linkActivated" && /^https?:\/\//i.test(request.url)) {
          const targetURL = request.url
          setTimeout(() => { void web.loadURL(targetURL) }, 0)
          return false
        }
        return true
      }
    }
    setAuthorizing(true)
    setLoginStatus(`正在打开${providerName(provider)}官方页面`)
    try {
      const loaded = await web.loadURL(url)
      if (!loaded) throw new Error("官方页面加载失败")
      await web.present({ fullscreen: true, navigationTitle: `${providerName(provider)}官方授权` })

      const detectedAddress = await visibleImapAddress(web)
      const pasteboardChanged = await Pasteboard.changeCount !== pasteboardChangeCount
      const detectedCode = pasteboardChanged ? authorizationCodeFromText(await Pasteboard.getString()) : ""
      if (detectedAddress) setAddress(detectedAddress)
      if (detectedCode) setSecret(detectedCode)

      const email = detectedAddress || address.trim().toLowerCase()
      if (email && detectedCode) {
        await connectImap(email, detectedCode)
      } else if (detectedAddress) {
        setLoginStatus(`已识别${providerName(provider)}地址，请复制授权码后点“粘贴授权码”`)
      } else if (detectedCode) {
        setLoginStatus(`授权码已填入，请确认${providerName(provider)}地址后连接`)
      } else {
        setLoginStatus(provider === "qq" || provider === "netease163" ? "未识别到本次授权信息，请填写邮箱地址并粘贴授权码" : "请粘贴刚生成的邮箱授权码")
      }
    } catch (error) {
      setLoginStatus(String((error as any)?.message ?? error))
    } finally {
      setAuthorizing(false)
      web.dispose()
    }
  }

  async function connectImap(addressInput = address, authorizationCode = secret) {
    if (!imapGatewayConfigured()) { setLoginStatus("QQ 和网易邮箱服务尚未上线"); return false }
    const email = addressInput.trim().toLowerCase()
    const code = authorizationCode.trim()
    const domains: Partial<Record<Provider, string>> = { qq: "qq.com", netease163: "163.com", netease126: "126.com", yeah: "yeah.net" }
    const domain = domains[provider]
    if (!domain || !new RegExp(`^[^\\s@]+@${domain.replace(".", "\\.")}$`, "i").test(email)) { setLoginStatus(`请输入有效的${providerName(provider)}地址`); return false }
    if (!code) { setLoginStatus(`请输入${providerName(provider)}授权码`); return false }
    if (provider === "qq" && !/^[A-Za-z0-9]{16}$/.test(code)) { setLoginStatus("QQ 邮箱授权码应为 16 位字符"); return false }
    if (provider === "netease163" && !/^[A-Za-z0-9]{16}$/.test(code)) { setLoginStatus("网易 163 授权码应为 16 位字母或数字"); return false }
    setAddress(email)
    setSecret(code)
    const accounts = loadAccounts()
    const duplicate = !initial ? accounts.find(item => item.provider === provider && item.address.trim().toLowerCase() === email) : undefined
    const accountSeed = duplicate ?? accounts.find(item => item.id === seed.id) ?? seed
    const account: MailAccount = { ...accountSeed, provider, name: name.trim() || providerName(provider), address: email, baseUrl: "", enabled }
    setConnectingQQ(true)
    const codeSuffix = code.slice(-4)
    setLoginStatus(`正在连接${providerName(provider)}（授权码尾号 ${codeSuffix}）`)
    try {
      await testImapAccount(account, code)
      const index = accounts.findIndex(item => item.id === account.id)
      const connected = { ...account, qqBeforeUID: undefined, qqPaginationEnded: false, syncState: undefined }
      if (index >= 0) accounts[index] = connected
      else accounts.push(connected)
      saveAccounts(accounts)
      saveSecret(account.id, code)
      setLoginStatus(`${providerName(provider)}已连接`)
      onSaved()
      dismiss()
      return true
    } catch (error) {
      setLoginStatus(`连接失败：${String((error as any)?.message ?? error)}（授权码尾号 ${codeSuffix}）`)
      return false
    } finally { setConnectingQQ(false) }
  }

  useEffect(() => {
    if (!autoStartAuthorization || (provider !== "qq" && provider !== "netease163")) return
    const timer = setTimeout(() => { void openImapAuthorization() }, 200)
    return () => clearTimeout(timer)
  }, [])

  async function login() {
    const account: MailAccount = { ...seed, provider: "cloudmail", name: name.trim() || "Cloud Mail", address: address.trim(), baseUrl: baseUrl.trim(), inboxPath: "/api/email/list", enabled }
    setLoggingIn(true)
    setLoginStatus("正在登录")
    try {
      const updated = await loginCloudMail(account, secret)
      setAddress(updated.address)
      setName(updated.name)
      setLoginStatus("登录成功")
      setSecret("")
      onSaved()
    } catch (error) {
      setLoginStatus(String((error as any)?.message ?? error))
    }
    setLoggingIn(false)
  }

  return (
    <List navigationTitle={initial ? "编辑账号" : "添加账号"} navigationBarTitleDisplayMode="inline" toolbar={{
      cancellationAction: <Button title="取消" action={dismiss} />,
      confirmationAction: isImapProvider || provider === "microsoft" ? undefined : <Button title="保存" action={persist} disabled={provider !== "gmail" && !address.trim() && provider !== "cloudmail"} />,
    }}>
      <Section header={<Text>类型</Text>}>
        <Picker title="邮箱服务" value={provider} onChanged={(value: any) => {
          const next = value as Provider
          setProvider(next)
          if (!initial) setName(providerName(next))
        }}>
          <Text tag="cloudmail">Cloud Mail</Text>
          {initial?.provider === "gmail" ? <Text tag="gmail">Gmail</Text> : null}
          {microsoftOAuthConfigured() || initial?.provider === "microsoft" ? <Text tag="microsoft">Microsoft 365</Text> : null}
          {imapGatewayConfigured() || initial?.provider === "qq" ? <Text tag="qq">QQ 邮箱</Text> : null}
          {imapGatewayConfigured() || initial?.provider === "netease163" ? <Text tag="netease163">网易 163</Text> : null}
          {imapGatewayConfigured() || initial?.provider === "netease126" ? <Text tag="netease126">网易 126</Text> : null}
          {imapGatewayConfigured() || initial?.provider === "yeah" ? <Text tag="yeah">Yeah 邮箱</Text> : null}
        </Picker>
        <Toggle title="启用此账号" value={enabled} onChanged={setEnabled} />
      </Section>
      {provider === "gmail" || provider === "microsoft" ? null : <Section header={<Text>账号</Text>}>
        <TextField title="显示名称" value={name} onChanged={setName} />
        <TextField title="邮箱地址" prompt="name@example.com" value={address} onChanged={setAddress} />
      </Section>}
      {provider === "cloudmail" ? (
        <Section header={<Text>Cloud Mail 登录</Text>} footer={<Text>密码只用于本次登录，不会保存。服务端返回的 JWT 会加密存入 iOS Keychain。</Text>}>
          <TextField title="部署地址" prompt="https://mail.example.com" value={baseUrl} onChanged={setBaseUrl} />
          <SecureField title="登录密码" value={secret} onChanged={setSecret} />
          <Button title={loggingIn ? "正在登录" : "登录并保存"} systemImage="person.badge.key" action={login} disabled={loggingIn || !baseUrl.trim() || !address.trim() || !secret} />
          <Text font="caption" foregroundStyle={loginStatus === "登录成功" || loginStatus === "已登录" ? "systemGreen" : "secondaryLabel"}>{loginStatus}</Text>
        </Section>
      ) : provider === "gmail" ? (
        <Section header={<Text>Google 账号</Text>} footer={<Text>点击后会打开 Google 官方登录与授权页面。云邮管家不会读取或保存 Google 密码。</Text>}>
          {address ? <HStack><Image systemName="g.circle.fill" foregroundStyle="systemRed" /><Text>{address}</Text></HStack> : null}
          <Button title={authorizing ? "正在打开 Google" : gmailAuthorized ? "重新登录 Google" : "使用 Google 登录"} systemImage="person.badge.key" action={connectGmail} disabled={authorizing} />
          {gmailAuthorized ? <Button title="断开 Google 连接" systemImage="link.badge.minus" role="destructive" action={disconnectGoogle} disabled={authorizing} /> : null}
          <Text font="caption" foregroundStyle={gmailAuthorized ? "systemGreen" : "secondaryLabel"}>{gmailAuthorized ? "已授权，可同步 Gmail 收件箱" : loginStatus === "未登录" ? "尚未连接 Google" : loginStatus}</Text>
        </Section>
      ) : provider === "microsoft" ? (
        <Section header={<Text>Microsoft 365 账号</Text>} footer={<Text>点击后会打开 Microsoft 365 官方登录页面。云邮管家不会读取或保存 Microsoft 365 密码。</Text>}>
          {address ? <HStack><Image systemName="m.circle.fill" foregroundStyle="systemBlue" /><Text>{address}</Text></HStack> : null}
          <Button title={authorizing ? "正在打开 Microsoft 365" : microsoftAuthorized ? "重新登录 Microsoft 365" : "使用 Microsoft 365 登录"} systemImage="person.badge.key" action={connectMicrosoft} disabled={authorizing || !microsoftOAuthConfigured()} />
          {microsoftAuthorized ? <Button title="断开 Microsoft 365 连接" systemImage="link.badge.minus" role="destructive" action={disconnectMicrosoftAccount} disabled={authorizing} /> : null}
          <Text font="caption" foregroundStyle={microsoftAuthorized ? "systemGreen" : "secondaryLabel"}>{microsoftAuthorized ? "已授权，可同步 Microsoft 365 收件箱" : loginStatus === "未登录" ? "尚未连接 Microsoft 365" : loginStatus}</Text>
        </Section>
      ) : (
        <Section header={<Text>{providerName(provider)}官方授权</Text>} footer={<Text>{provider === "qq" ? "在腾讯官方页面登录，开启 IMAP 并复制 16 位授权码后关闭页面。云邮管家会从页面公开显示内容识别邮箱地址，并读取本次复制的授权码自动连接；不会读取密码、短信或网页 Cookie。" : provider === "netease163" ? "在网易官方页面登录，进入设置 → POP3/SMTP/IMAP，开启 IMAP 并复制 16 位授权码后关闭页面。云邮管家会识别邮箱地址和本次复制的授权码并自动连接；不会读取密码、短信或网页 Cookie。" : "在官方页面登录，进入邮箱设置开启 IMAP 并生成客户端授权码。复制授权码后关闭页面，云邮管家会自动填入；不会读取你的邮箱密码、短信或网页 Cookie。"}</Text>}>
          <Button title={authorizing ? `正在打开${providerName(provider)}` : provider === "qq" || provider === "netease163" ? `连接${providerName(provider)}` : `登录${providerName(provider)}并获取授权码`} systemImage="person.badge.key" action={openImapAuthorization} disabled={authorizing || connectingQQ || !imapGatewayConfigured()} />
          <SecureField title="邮箱授权码" value={secret} onChanged={setSecret} />
          <Button title="粘贴授权码" systemImage="doc.on.clipboard" action={() => pasteAuthorizationCode()} disabled={authorizing || connectingQQ} />
          <Button title={connectingQQ ? "正在连接" : "连接并保存"} systemImage="checkmark.circle" action={() => connectImap()} disabled={authorizing || connectingQQ} />
          <Text font="caption" foregroundStyle={(loginStatus.endsWith("已连接") || (initial && Boolean(loadSecret(initial.id)))) && imapGatewayConfigured() ? "systemGreen" : "secondaryLabel"}>{!imapGatewayConfigured() ? "QQ 和网易邮箱服务尚未上线" : initial && loadSecret(initial.id) && loginStatus === "已登录" ? `已连接，可同步${providerName(provider)}收件箱` : loginStatus}</Text>
        </Section>
      )}
      {initial?.provider === "cloudmail" && loadSecret(initial.id) ? (
        <Section header={<Text>站内邮箱</Text>} footer={<Text>管理这个 Cloud Mail 用户下的全部邮箱地址。</Text>}>
          <NavigationLink title="邮箱地址管理" destination={<CloudMailboxesView connection={loadAccounts().find(item => item.id === initial.id) ?? initial} onConnectionChanged={onSaved} />} />
        </Section>
      ) : null}
      {initial ? (
        <Section>
          <Button title="删除连接" role="destructive" action={() => {
            removeAccount(initial)
            setLoginStatus("已删除，请返回上一页")
          }} />
        </Section>
      ) : null}
    </List>
  )
}

function AccountsView({ onChanged }: { onChanged: () => void }) {
  const dismiss = Navigation.useDismiss()
  const [accounts, setAccounts] = useState(loadAccounts())
  const [addingGmail, setAddingGmail] = useState(false)
  const [addingMicrosoft, setAddingMicrosoft] = useState(false)
  const [pushEnabled, setPushEnabled] = useState(hasBackgroundPushConfiguration())
  const [pushAdminToken, setPushAdminToken] = useState(loadBackgroundPushAdminToken())
  const [pushBusy, setPushBusy] = useState(false)
  const [status, setStatus] = useState("")
  const reload = () => { setAccounts(loadAccounts()); onChanged() }

  useEffect(() => {
    let mounted = true
    loadBackgroundPushStatus().then(result => {
      if (mounted) setPushEnabled(result.enabled)
    }).catch(() => {})
    return () => { mounted = false }
  }, [])

  async function enablePush() {
    if (pushBusy) return
    setPushBusy(true)
    setStatus("正在启用后台邮件推送")
    try {
      saveBackgroundPushAdminToken(pushAdminToken)
      const result = await configureBackgroundPush(loadAccounts(), loadMessageSnapshot())
      setPushEnabled(true)
      setStatus(`后台推送已启用，正在监控 ${result.accountCount} 个邮箱`)
    } catch (error) {
      setStatus(String((error as any)?.message ?? error))
    } finally { setPushBusy(false) }
  }

  async function disablePush() {
    if (pushBusy) return
    setPushBusy(true)
    setStatus("正在关闭后台邮件推送")
    try {
      await clearBackgroundPush()
      setPushEnabled(false)
      setStatus("后台推送已关闭，Worker 中的所有者配置已删除")
    } catch (error) {
      setStatus(String((error as any)?.message ?? error))
    } finally { setPushBusy(false) }
  }

  async function addMicrosoft() {
    if (addingMicrosoft) return
    if (!microsoftOAuthConfigured()) {
      setStatus("Microsoft 365 登录服务配置中，请稍后再试")
      return
    }
    setAddingMicrosoft(true)
    setStatus("正在打开 Microsoft 365 登录")
    try {
      await authorizeMicrosoft(makeAccount("microsoft"))
      setStatus("Microsoft 365 邮箱已添加，正在同步邮件")
      reload()
      dismiss()
    } catch (error) { setStatus(String((error as any)?.message ?? error)) }
    finally { setAddingMicrosoft(false) }
  }

  async function addGmail() {
    if (addingGmail) return
    setAddingGmail(true)
    setStatus("正在打开 Google 登录")
    try {
      await authorizeGmail(makeAccount("gmail"))
      setStatus("Gmail 已添加，正在同步邮件")
      reload()
      dismiss()
    } catch (error) {
      setStatus(String((error as any)?.message ?? error))
    } finally { setAddingGmail(false) }
  }

  function addImapProvider(provider: "qq" | "netease163") {
    Navigation.present(<AccountEditor initialProvider={provider} autoStartAuthorization onSaved={reload} />)
  }

  function addCloudMail() {
    Navigation.present(<AccountEditor initialProvider="cloudmail" onSaved={reload} />)
  }

  return (
    <List navigationTitle="邮箱账号" overlay={accounts.length ? undefined : <ContentUnavailableView title="还没有邮箱账号" systemImage="person.crop.circle.badge.plus" description="选择下方邮箱服务快速添加" />}>
      <Section header={<Text>快速添加</Text>} footer={<Text>Cloud Mail 密码仅用于本次登录；其他邮箱在官方页面授权或使用客户端授权码。长期凭据只保存在 iOS Keychain。</Text>}>
        <Button title="添加 Cloud Mail" systemImage="cloud.fill" action={addCloudMail} />
        <Button title={addingGmail ? "正在打开 Google" : "添加 Gmail"} systemImage="g.circle.fill" action={addGmail} disabled={addingGmail || !gmailOAuthConfigured()} />
        {imapGatewayConfigured() ? <Button title="添加 QQ 邮箱" systemImage="q.circle.fill" action={() => addImapProvider("qq")} /> : null}
        {imapGatewayConfigured() ? <Button title="添加网易 163" systemImage="envelope.fill" action={() => addImapProvider("netease163")} /> : null}
        <Button title={addingMicrosoft ? "正在打开 Microsoft 365" : "添加 Microsoft 365 邮箱"} systemImage="m.circle.fill" action={addMicrosoft} disabled={addingMicrosoft} />
        {!gmailOAuthConfigured() ? <Text font="caption" foregroundStyle="secondaryLabel">当前版本尚未配置 Google 登录服务</Text> : null}
        {status ? <Text font="caption" foregroundStyle="secondaryLabel">{status}</Text> : null}
      </Section>
      <Section header={<Text>邮件推送</Text>} footer={<Text>令牌只保存在本机 Keychain，必须与自己部署的 Worker 中 MAIL_PUSH_ADMIN_TOKEN 一致。启用后可随时关闭并删除 Worker 中的邮箱凭据与推送配置。</Text>}>
        <SecureField title="所有者令牌" value={pushAdminToken} onChanged={setPushAdminToken} />
        <HStack spacing={12}>
          <Image systemName={pushEnabled ? "bell.badge.fill" : "bell.slash.fill"} foregroundStyle={pushEnabled ? "systemGreen" : "secondaryLabel"} frame={{ width: 28 }} />
          <VStack alignment="leading" spacing={3}>
            <Text fontWeight="semibold">后台接收</Text>
            <Text font="caption" foregroundStyle="secondaryLabel">{pushEnabled ? "已启用" : "未启用"}</Text>
          </VStack>
          <Spacer />
          <Button title={pushBusy ? "处理中" : pushEnabled ? "更新" : "开启"} systemImage={pushEnabled ? "arrow.clockwise" : "bell.badge"} action={enablePush} disabled={pushBusy || !pushAdminToken.trim()} />
        </HStack>
        {pushEnabled ? <Button title="关闭并删除云端数据" systemImage="trash" role="destructive" action={disablePush} disabled={pushBusy} /> : null}
      </Section>
      {accounts.map(account => (
        <Section key={account.id}>
          <NavigationLink destination={<AccountEditor initial={account} onSaved={reload} />}>
            <HStack spacing={12}>
              <Image systemName={providerIcon(account.provider)} foregroundStyle={providerColor(account.provider)} frame={{ width: 28 }} />
              <VStack alignment="leading" spacing={3}>
                <Text fontWeight="semibold">{account.name}</Text>
                <Text font="caption" foregroundStyle="secondaryLabel">{account.address || providerName(account.provider)}</Text>
              </VStack>
              <Spacer />
              <Text font="caption" foregroundStyle={account.enabled && (account.provider !== "gmail" || isGmailAuthorized(account.id)) && (account.provider !== "microsoft" || isMicrosoftAuthorized(account.id)) && (!["qq", "netease163", "netease126", "yeah"].includes(account.provider) || imapGatewayConfigured() && Boolean(loadSecret(account.id))) ? "systemGreen" : "secondaryLabel"}>{!account.enabled ? "已停用" : account.provider === "gmail" && !isGmailAuthorized(account.id) ? "未授权" : account.provider === "microsoft" && !isMicrosoftAuthorized(account.id) ? "未授权" : ["qq", "netease163", "netease126", "yeah"].includes(account.provider) && !imapGatewayConfigured() ? "服务未上线" : ["qq", "netease163", "netease126", "yeah"].includes(account.provider) && !loadSecret(account.id) ? "未连接" : "已启用"}</Text>
            </HStack>
          </NavigationLink>
        </Section>
      ))}
    </List>
  )
}

function MainView() {
  const initialAccounts = useMemo(() => loadAccounts(), [])
  const initialSnapshot = useMemo(() => loadMessageSnapshot(), [])
  const visibleAccounts = useMemo(() => initialAccounts.filter(account => !["qq", "netease163", "netease126", "yeah"].includes(account.provider) || imapGatewayConfigured()), [initialAccounts])
  const visibleSnapshot = useMemo(() => initialSnapshot.filter(message => !["qq", "netease163", "netease126", "yeah"].includes(message.provider) || imapGatewayConfigured()), [initialSnapshot])
  const [accounts, setAccounts] = useState(initialAccounts)
  const [messages, setMessages] = useState<MailMessage[]>(visibleAccounts.length ? visibleSnapshot : demoMessages)
  const [verificationToast, setVerificationToast] = useState<MailMessage | null>(null)
  const knownMessageIds = useMemo(() => new Set(initialSnapshot.map(message => `${message.accountId}:${message.id}`)), [])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [accountHasMore, setAccountHasMore] = useState<Record<string, boolean>>(() => Object.fromEntries(initialAccounts.map(account => [account.id, true])))
  const [syncVersion, setSyncVersion] = useState(0)
  const [status, setStatus] = useState(initialAccounts.length ? (initialSnapshot.length ? "正在后台更新" : "正在同步邮件") : "当前显示演示数据")

  async function refresh() {
    if (inboxRefreshInFlight) return
    inboxRefreshInFlight = true
    const current = loadAccounts().filter(item => item.enabled && (item.provider !== "gmail" || isGmailAuthorized(item.id)) && (item.provider !== "microsoft" || isMicrosoftAuthorized(item.id)) && (!["qq", "netease163", "netease126", "yeah"].includes(item.provider) || imapGatewayConfigured()))
    setAccounts(current)
    if (!current.length) {
      setMessages(demoMessages)
      setStatus("当前显示演示数据")
      inboxRefreshInFlight = false
      return
    }
    setLoading(true)
    setAccountHasMore(Object.fromEntries(current.map(account => [account.id, true])))
    if (messages.length) setStatus("正在后台更新")
    const enabledIds = new Set(current.map(item => item.id))
    const accountsWithKnownMail = new Set(messages.map(message => message.accountId))
    const errors: string[] = []
    let completed = 0
    await Promise.all(current.map(async account => {
      try {
        const latest = messages.filter(item => item.accountId === account.id).sort((a, b) => messageTimestamp(b.date) - messageTimestamp(a.date))[0]
        const result = await fetchAccountMessages(account, latest?.id)
        const incoming = result.messages
        const newVerificationMail = accountsWithKnownMail.has(account.id)
          ? incoming
            .filter(message => message.verificationCode && !knownMessageIds.has(`${message.accountId}:${message.id}`))
            .sort((a, b) => messageTimestamp(b.date) - messageTimestamp(a.date))[0]
          : undefined
        incoming.forEach(message => knownMessageIds.add(`${message.accountId}:${message.id}`))
        if (newVerificationMail) {
          setVerificationToast(currentToast => !currentToast || messageTimestamp(newVerificationMail.date) > messageTimestamp(currentToast.date) ? newVerificationMail : currentToast)
        }
        setMessages(items => {
          // Gmail refreshes the newest page authoritatively while preserving
          // older pages loaded by the user. Cloud Mail's /latest is incremental.
          const existing = result.resetAccount ? [] : items.filter(item => item.accountId === account.id)
          const oldestIncomingTime = incoming.length
            ? Math.min(...incoming.map(item => messageTimestamp(item.date)))
            : Number.NEGATIVE_INFINITY
          const gmailHistory = existing.filter(item => messageTimestamp(item.date) < oldestIncomingTime)
          const accountItems = account.provider === "gmail"
            ? incoming.length ? [...incoming, ...gmailHistory] : existing
            : [...existing, ...incoming]
          const unique = new Map(accountItems.map(item => [item.id, item]))
          const merged = [...items.filter(item => item.accountId !== account.id && enabledIds.has(item.accountId)), ...unique.values()]
            .sort((a, b) => messageTimestamp(b.date) - messageTimestamp(a.date))
          scheduleMessageSnapshot(merged)
          return merged
        })
      } catch (error) {
        errors.push(`${account.name}：${String((error as any)?.message ?? error)}`)
      } finally {
        completed += 1
        setStatus(`已同步 ${completed}/${current.length} 个账号`)
      }
    }))
    setStatus(errors.length ? errors.join("；") : "同步完成")
    setLoading(false)
    inboxRefreshInFlight = false
    setSyncVersion(value => value + 1)
  }

  useEffect(() => { if (accounts.length) refresh() }, [])
  useEffect(() => {
    if (!accounts.length) return
    const timer = setTimeout(refresh, 15_000)
    return () => clearTimeout(timer)
  }, [accounts, messages, syncVersion])
  useEffect(() => {
    const handleScenePhase = (phase: "active" | "inactive" | "background") => {
      if (phase === "active") refresh()
    }
    AppEvents.scenePhase.addListener(handleScenePhase)
    return () => AppEvents.scenePhase.removeListener(handleScenePhase)
  }, [accounts, messages])
  useEffect(() => {
    const timer = setTimeout(() => {
      const first = messages[0]
      if (first) cachedMailBodyDocument(first)
    }, 450)
    return () => clearTimeout(timer)
  }, [messages])

  async function loadMore() {
    if (loading || loadingMore) return
    const current = loadAccounts().filter(item => item.enabled && (item.provider !== "gmail" || isGmailAuthorized(item.id)) && (item.provider !== "microsoft" || isMicrosoftAuthorized(item.id)) && (!["qq", "netease163", "netease126", "yeah"].includes(item.provider) || imapGatewayConfigured()) && accountHasMore[item.id] !== false)
    if (!current.length) return
    setLoadingMore(true)
    const nextHasMore = { ...accountHasMore }
    const errors: string[] = []
    await Promise.all(current.map(async account => {
      try {
        const oldest = messages.filter(item => item.accountId === account.id).sort((a, b) => messageTimestamp(a.date) - messageTimestamp(b.date))[0]
        const result = await fetchOlderAccountMessages(account, oldest)
        nextHasMore[account.id] = result.hasMore
        if (result.messages.length) {
          setMessages(items => {
            const merged = [...items, ...result.messages]
            const unique = [...new Map(merged.map(item => [`${item.accountId}:${item.id}`, item])).values()]
              .sort((a, b) => messageTimestamp(b.date) - messageTimestamp(a.date))
            scheduleMessageSnapshot(unique)
            return unique
          })
        }
      } catch (error) {
        nextHasMore[account.id] = false
        errors.push(`${account.name}：${String((error as any)?.message ?? error)}`)
      }
    }))
    setAccountHasMore(nextHasMore)
    if (errors.length) setStatus(errors.join("；"))
    setLoadingMore(false)
  }

  function copyVerificationCode() {
    if (!verificationToast?.verificationCode) return
    Pasteboard.setString(verificationToast.verificationCode)
    setVerificationToast(null)
  }

  async function removeFromInbox(message: MailMessage) {
    const account = accounts.find(item => item.id === message.accountId) ?? loadAccounts().find(item => item.id === message.accountId)
    if (!account || !["cloudmail", "gmail", "microsoft", "qq", "netease163", "netease126", "yeah"].includes(account.provider)) {
      setStatus("找不到该邮件对应的邮箱账号，无法删除")
      return
    }
    setMessages(items => {
      const updated = items.filter(item => item.accountId !== message.accountId || item.id !== message.id)
      scheduleMessageSnapshot(updated)
      return updated
    })
    try {
      await deleteMessage(account, message.id)
    } catch (error) {
      setMessages(items => {
        const restored = [...new Map([...items, message].map(item => [`${item.accountId}:${item.id}`, item])).values()]
          .sort((a, b) => messageTimestamp(b.date) - messageTimestamp(a.date))
        scheduleMessageSnapshot(restored)
        return restored
      })
      setStatus(`删除失败，邮件已恢复：${String((error as any)?.message ?? error)}`)
    }
  }

  function openMessage(message: MailMessage) {
    const accountId = message.accountId
    const messageId = message.id
    Navigation.present(
      <NavigationStack>
        <MessageDetail
          message={message}
          account={accounts.find(item => item.id === accountId)}
          onRead={() => setMessages(items => {
            const updated = items.map(item => item.accountId === accountId && item.id === messageId ? { ...item, unread: false } : item)
            scheduleMessageSnapshot(updated)
            return updated
          })}
          onDeleted={() => setMessages(items => {
            const updated = items.filter(item => item.accountId !== accountId || item.id !== messageId)
            scheduleMessageSnapshot(updated)
            return updated
          })}
          onDeleteFailed={error => {
            setMessages(items => {
              const restored = [...new Map([...items, message].map(item => [`${item.accountId}:${item.id}`, item])).values()]
                .sort((a, b) => messageTimestamp(b.date) - messageTimestamp(a.date))
              scheduleMessageSnapshot(restored)
              return restored
            })
            setStatus(`删除失败，邮件已恢复：${String((error as any)?.message ?? error)}`)
          }}
        />
      </NavigationStack>,
    ).catch(console.error)
  }

  return (
    <NavigationStack>
      <List navigationTitle="收件箱" refreshable={refresh} toolbar={{
        topBarLeading: <Button title="账号" systemImage="person.crop.circle" action={() => Navigation.present(<NavigationStack><AccountsView onChanged={refresh} /></NavigationStack>)} />,
        topBarTrailing: <Button title="刷新" systemImage="arrow.clockwise" action={refresh} disabled={loading} />,
      }} overlay={verificationToast ? {
        alignment: "top",
        content: <Button
          action={copyVerificationCode}
          buttonStyle="plain"
          padding={{ horizontal: 38, vertical: 18 }}
          frame={{ minWidth: 176 }}
          glassEffect={{ glass: UIGlass.clear().tint("rgba(126,92,255,0.12)").interactive(), shape: { type: "rect", cornerRadius: 30, style: "continuous" } }}
          glassEffectTransition="materialize"
          shadow={{ color: "rgba(91,112,255,0.20)", radius: 24, y: 9 }}
          offset={{ x: 0, y: 12 }}
        >
          <Text
            font="largeTitle"
            fontWeight="bold"
            lineLimit={1}
            foregroundStyle={gradient("linear", {
              stops: [
                { color: "#FF4F87", location: 0 },
                { color: "#A855F7", location: 0.34 },
                { color: "#368BFF", location: 0.68 },
                { color: "#20CDBB", location: 1 },
              ],
              startPoint: "leading",
              endPoint: "trailing",
            })}
          >
            {verificationToast.verificationCode ?? ""}
          </Text>
        </Button>,
      } : !loading && messages.length === 0 ? <ContentUnavailableView title="暂无邮件" systemImage="tray" description="下拉刷新或检查账号配置" /> : undefined}>
        <Section footer={<Text>{status}</Text>}>
          {loading && messages.length === 0 ? <HStack><ProgressView /><Text foregroundStyle="secondaryLabel">正在同步邮件</Text></HStack> : null}
          {messages.map(message => (
            <Button
              key={`${message.accountId}-${message.id}`}
              action={() => openMessage(message)}
              trailingSwipeActions={["cloudmail", "gmail", "microsoft", "qq", "netease163", "netease126", "yeah"].includes(message.provider) ? {
                allowsFullSwipe: true,
                actions: [<Button title={message.provider === "gmail" ? "垃圾箱" : "删除"} systemImage="trash" role="destructive" action={() => removeFromInbox(message)} />],
              } : undefined}
            >
              <HStack alignment="top" spacing={10} padding={{ vertical: 6 }}>
                <VStack spacing={5} frame={{ width: 18 }}>
                  <Image systemName={providerIcon(message.provider)} foregroundStyle={providerColor(message.provider)} font="caption" />
                  {message.unread ? <Image systemName="circle.fill" foregroundStyle="systemBlue" font="caption2" /> : null}
                </VStack>
                <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity" }}>
                  <HStack>
                    <Text font="subheadline" fontWeight={message.unread ? "semibold" : "regular"} lineLimit={1}>{message.from}</Text>
                    <Spacer />
                    <Text font="caption2" foregroundStyle="tertiaryLabel">{formatDate(message.date)}</Text>
                  </HStack>
                  <Text font="subheadline" fontWeight={message.unread ? "semibold" : "medium"} lineLimit={1}>{message.subject}</Text>
                  <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={2}>{message.preview}</Text>
                </VStack>
              </HStack>
            </Button>
          ))}
          {Object.values(accountHasMore).some(Boolean) && syncVersion > 0 ? (
            <HStack
              key={`load-more-${syncVersion}-${messages.length}`}
              frame={{ height: 1, maxWidth: "infinity" }}
              onAppear={() => { if (!loading && !loadingMore) loadMore() }}
            />
          ) : null}
        </Section>
      </List>
    </NavigationStack>
  )
}

async function run() {
  await Navigation.present(<MainView />)
  Script.exit()
}

run().catch(async error => {
  console.error(error)
  Script.exit()
})
