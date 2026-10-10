// ===== 更新说明检查（脚本管理工具注入，勿删） =====
;(async () => {
  try {
    // 这段块永远是被发布脚本 index.tsx 的第一条语句，因此**绝对不能引用目标脚本自己
    // import 进来的名字**。加壳工具会把整个脚本打包成 CommonJS bundle（模块体被包进一个
    // 函数，require("scripting") 产生的 const 绑定虽然在本块之前声明不了、但一定在本块
    // 之后才初始化），于是：
    //   - 目标脚本没 import Script 时 → 裸的 Script 直接 ReferenceError；
    //   - 目标脚本 import 了 Script 时 → TS 会改写成 scripting_N.Script.env，
    //     而那个 const 在本块之后才初始化，处在 TDZ，同样 ReferenceError。
    // 两种都正好被本块自己的 catch 吞掉，表现就是「加壳脚本永远不弹更新说明」，
    // 而未加壳脚本因为 ESM 会把 import 提升，反而一直正常（所以这个 bug 只在加壳包上出现）。
    // 这里统一用自己的局部变量：取不到就当没取到，继续往下走，不影响脚本本体。
    // ⚠️ scripting 必须在 try **外面**用 let 声明：它下面的 try 还要拿 __S 取 Script.directory，
    // 用块内的 const 声明时那个绑定出了 try 就不可见，参考会直接抛 ReferenceError
    // （又被本块最外层的 catch 吞掉 → 更新说明永远不弹）。
    let __S: any = null
    let __env = ""
    try {
      __S = await import("scripting")
      __env = String((__S && __S.Script && __S.Script.env) || "")
    } catch (e) {}
    // 主页标签（home_screen）会反复重建实例，每次重建都会重跑这段注入块；
    // 更新说明弹窗在主页标签里既弹不出来也没意义，直接跳过省掉那几次文件读写。
    if (__env === "home_screen") return
    // 说明正文优先从脚本目录的 changelog.json 读（发布时才需要写入）：
    // 入口里的常量只是老包兜底。加壳只加密 lib/，根目录的 changelog.json 是明文文件，
    // 壳里的解密壳运行时也能读到它 —— 所以「已加壳的脚本发布新说明」不必先去壳。
    const __noteFile = "changelog.json"
    // 历史更新说明的唯一来源就是下面这个文件里的 history：随包分发、换设备/重装也都在。
    // 设备本地那份 changelog_history/{scriptName}.json 已在发布时被吸收进本文件并删除，
    // 这里不再读写它 —— 历史散在两个地方必然会出现「同一条说明只在一处能看到」。
    // 本地只留一份很小的「哪些次发布已经弹过」记录（changelog_ran），它不含说明正文。
    const __historyFromFileOnly = true
    let note = ""
    let version = "2.0"
    let scriptName = "云邮管家"
    let folderName = "云邮管家"
    let scriptAuthor = ""
    let notifyAuthor = false
    let publishId = "p1791617460552-64827"
    // 历史更新说明：**只**从包里 changelog.json 的 history 读（随包分发，换设备/重装也有）。
    // 设备本地那份 changelog_history/{scriptName}.json 已在发布时被吸收进本文件并删除，
    // 运行期不再读写它（否则历史会散在两个地方，同一条说明只在一处能看到）。
    // 本地只留一份很小的「哪几次发布已经弹过」记录 changelog_ran/{scriptName}.json，
    // 只存 版本号@发布序号 字符串，不含说明正文。
    let fileHistory: { version: string; note: string }[] = []
    let ranPath = ""
    let ran: Record<string, number> = {}
    try {
      const __dir = String((__S && __S.Script && __S.Script.directory) || "")
      if (__dir) {
        const __p = __dir + "/" + __noteFile
        if (FileManager.existsSync(__p)) {
          const __f = JSON.parse(await FileManager.readAsString(__p)) || {}
          if (typeof __f.note === "string" && __f.note.trim()) {
            note = __f.note
            version = String(__f.version || version || "")
            scriptName = String(__f.scriptName || scriptName || "")
            folderName = String(__f.folderName || folderName || "")
            scriptAuthor = String(__f.scriptAuthor || scriptAuthor || "")
            if (typeof __f.notifyAuthor === "boolean") notifyAuthor = __f.notifyAuthor
            if (typeof __f.publishId === "string" && __f.publishId) publishId = __f.publishId
            if (Array.isArray(__f.history)) {
              fileHistory = __f.history.filter((h: any) => h && typeof h === "object" && typeof h.version === "string" && typeof h.note === "string" && h.version && h.note)
            }
          }
        }
      }
    } catch (e) {}
    if (!note) return
    if (!version) return
    const base = FileManager.appGroupDocumentsDirectory || ""
    // base 拿不到时（脚本无 App Group 权限等）不能直接 return，否则更新说明永远不弹：
    // 只是无法写去重记录，这时跳过读写继续往下弹
    let history: { version: string; note: string }[] = []
    let skipPrompt = false
    let seen: Record<string, boolean> = {}
    let statePath = ""
    let hideButtonLabels = false
    let langIsEn = false
    const verNums = (v: string) => {
      const p = String(v || "").split(".").map((n) => parseInt(n, 10) || 0)
      while (p.length < 3) p.push(0)
      return p
    }
    // 「本次发布之前是不是已经在这个设备上弹过」：只看本地那份 ran 记录（只存发布键）。
    // 不能拿包里 history 判 —— 那一堆本来就有本次发布的条目，拿它判会永不弹窗。
    // 去重键只用「版本号@发布序号」：版本号一致但重新发布（换了说明）时仍会重新提示。
    const seenKey = version + "@" + publishId
    if (base) {
      ranPath = base + "/changelog_ran/" + scriptName + ".json"
      try {
        try { await FileManager.createDirectory(base + "/changelog_ran", true) } catch (e) {}
        const raw = JSON.parse(await FileManager.readAsString(ranPath))
        if (raw && typeof raw === "object") ran = raw
      } catch (e) {}
      if (Number(ran[seenKey] || 0) > 0) skipPrompt = true
    }
    // 展示用的历史 = 包里 changelog.json 的 history（即写入时已经算好的完整列表）。
    // 只做「同文合并 + 排序」这两种**纯展示层**的整理，不写回任何文件：
    // 说明正文的唯一落盘位置是 changelog.json（发布时写的），运行期只读。
    try {
      const byNote = new Map<string, { version: string, note: string }>()
      for (const h of fileHistory) {
        if (!h) continue
        const key = String(h.note || "")
        const prev = byNote.get(key)
        if (!prev) {
          byNote.set(key, { version: h.version, note: h.note })
          continue
        }
        const a = verNums(h.version)
        const b = verNums(prev.version)
        let bigger = false
        for (let i = 0; i < 3; i++) {
          if (a[i] !== b[i]) {
            bigger = a[i] > b[i]
            break
          }
        }
        if (bigger) byNote.set(key, { version: h.version, note: h.note })
      }
      history = Array.from(byNote.values())
    } catch (e) {}
    try {
      // 本次条目已经在包里 history 里：去掉旧条目再把本次置顶（页面默认停在第 1 页）
      history = history.filter((h) => h && h.version !== version && h.note !== note)
      history.sort((a, b) => {
        const pa = verNums(a.version)
        const pb = verNums(b.version)
        for (let i = 0; i < 3; i++) {
          if (pa[i] !== pb[i]) return pb[i] - pa[i]
        }
        return 0
      })
      // 本次发布的说明恒定排在第 1 页，其余历史按版本号降序跟在其后（最多共 20 条）：
      // 弹窗默认停在第 1 页，用户必须先翻页才能看到「这次的更新写了什么」是错的；
      // 而且版本号一旦回退（重置版本号、测试版改名回写、从高版本分支切回来，
      // 例如 1.0.111 → 1.0.3），仅按版本号排序会把本次说明压到最后一页甚至被截断丢弃，
      // 所以本次条目不参与排序，强制置顶
      history = [{ version, note }].concat(history.slice(0, 19))
    } catch (e) {}
    if (base) {
      const seenDir = base + "/changelog_seen"
      try { await FileManager.createDirectory(seenDir, true) } catch (e) {}
      statePath = seenDir + "/" + scriptName + ".json"
      try { seen = JSON.parse(await FileManager.readAsString(statePath)) || {} } catch (e) {}
      // 作者本人不提示：本机脚本管理工具发布过该版本（本机即作者/发布者设备），或设置里填写的用户名与脚本作者一致，
      // 且本次发布未勾选「作者本人也提示更新」时，不弹更新说明
      try {
        const mgrCfgPath = base + "/script-manager-config.json"
        const mgrCfg = JSON.parse(await FileManager.readAsString(mgrCfgPath)) || {}
        hideButtonLabels = mgrCfg.hideButtonLabels === true
        // 兜底：读取不到系统语言（兼容旧版 Scripting/特殊环境）时，回退「用户设置」里的中英文切换
        langIsEn = mgrCfg.language === "en"
        const mgrName = String(mgrCfg.authorName || "").trim()
        const published = mgrCfg.publishedVersions || {}
        if (!notifyAuthor && ((scriptAuthor && mgrName && mgrName === scriptAuthor) || published[folderName] === version)) {
          return
        }
      } catch (e) {}
    }
    // 本次发布之前已经在这个设备上弹过（ran 记录里有）：不再提示，避免把同一次发布重复弹一遍
    if (skipPrompt) return
    // 用户点过「不提醒」的那几次发布：不再提示
    if (seen[seenKey]) return
    // 同一次发布短时间内只提示一次：同一份代码可能被并发执行两份
    // （常驻主页标签 import 本入口时顶层代码会跟着跑一遍、用户连点图标、
    //  快捷指令与点击同时启动），两个实例都会通过上面的 seen 检查、各弹一个窗。
    // seen 只在用户点「不提醒」时写，挡不住这种情况，这里用单独的「已提示」记录占位，
    // 且必须赶在下面的 600ms 延时之前写入：后到的实例醒来看到记录就直接退出。
    // 同一个文件里再记一条**永久**的 ran：本次发布已经在这个设备上弹过，以后都不再弹。
    // 它取代了原先「设备本地历史里有没有本次条目」那个判据（那个文件已被 changelog.json 取代）。
    const shownPath = base ? base + "/changelog_shown/" + scriptName + ".json" : ""
    if (shownPath) {
      const shownTtl = 10 * 60 * 1000
      let shown: Record<string, number> = {}
      try { shown = JSON.parse(await FileManager.readAsString(shownPath)) || {} } catch (e) {}
      const lastShown = Number(shown[seenKey] || 0)
      if (lastShown > 0 && Date.now() - lastShown < shownTtl) return
      try {
        try { await FileManager.createDirectory(base + "/changelog_shown", true) } catch (e) {}
        shown[seenKey] = Date.now()
        // 只保留最近 10 条，避免文件无限增长
        const shownKeys = Object.keys(shown)
        if (shownKeys.length > 10) {
          shownKeys.sort((a, b) => Number(shown[b]) - Number(shown[a]))
          for (const k of shownKeys.slice(10)) delete shown[k]
        }
        await FileManager.writeAsString(shownPath, JSON.stringify(shown))
      } catch (e) {}
    }
    if (ranPath) {
      try {
        ran[seenKey] = Date.now()
        // 只保留最近 20 次发布，避免文件无限增长
        const ranKeys = Object.keys(ran)
        if (ranKeys.length > 20) {
          ranKeys.sort((a, b) => Number(ran[b]) - Number(ran[a]))
          for (const k of ranKeys.slice(20)) delete ran[k]
        }
        await FileManager.writeAsString(ranPath, JSON.stringify(ran))
      } catch (e) {}
    }
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 600))
    const { Navigation, NavigationStack, ScrollView, VStack, HStack, Text, Button, Divider, Spacer, Image, ZStack, useState, useEffect, Device } = await import("scripting")
    // 更新说明页面文案语言优先跟随「系统语言」：非中文系统按英文显示（只有中英两版，其他语言回退英文），
    // 拿不到系统语言时保持上面读到的用户设置兜底值
    try {
      const sysLang = String((Device && (Device.systemLanguageCode || (Device.preferredLanguages && Device.preferredLanguages[0]))) || "").trim()
      if (sysLang) {
        langIsEn = !/^zh/i.test(sysLang)
      }
    } catch (e) {}
    const markSeen = async () => {
      if (!statePath) return
      try {
        seen[seenKey] = true
        await FileManager.writeAsString(statePath, JSON.stringify(seen))
      } catch (e) {}
    }
    function ChangelogView(props: { note: string; version: string; scriptName: string; history: { version: string; note: string }[] }) {
      const dismiss = Navigation.useDismiss()
      // 文案语言：优先系统语言（非中文系统显示英文），读取失败回退用户设置；英文显示英文，否则中文
      const isEn = langIsEn
      const noHistoryText = isEn ? "No update history" : "暂无历史更新记录"
      const versionPrefix = isEn ? "Version " : "版本 "
      const pageText = (i: number, t: number) => (isEn ? i + " / " + t : "第 " + i + " / " + t + " 页")
      const labelFirst = isEn ? "First" : "首页"
      const labelPrev = isEn ? "Prev" : "上页"
      const labelNext = isEn ? "Next" : "下页"
      const labelLast = isEn ? "Last" : "尾页"
      const labelNoRemind = isEn ? "No remind" : "不提醒"
      const labelDismiss = isEn ? "Close" : "临时关"
      const [pageIndex, setPageIndex] = useState(0)
      const [scrollAnchor, setScrollAnchor] = useState<string | null>("note")
      // 检测内容是否不满一页：首次可见性回调时若底部 Divider（changelog-end）无需滚动即可见，则为不满一页；
      // 不满一页时不显示内容末尾的灰色实线与右下角向下图标（null=尚未检测到，保持原行为，兼容 iOS 17 降级）
      const [endInitiallyVisible, setEndInitiallyVisible] = useState<boolean | null>(null)
      const atBottom = scrollAnchor === "changelog-end"
      const shortContent = endInitiallyVisible === true
      // 翻页后内容变化，重置检测让可见性回调重新判断当前页
      useEffect(() => {
        setEndInitiallyVisible(null)
      }, [pageIndex])
      const total = props.history.length
      const current = total > 0 ? props.history[Math.min(pageIndex, total - 1)] : null
      const atFirst = pageIndex <= 0
      const atLast = pageIndex >= total - 1
      // 英文模式下：发布方写的更新说明若含中文，先走免费网络翻译（免费/非 Pro 用户也能用），
      // 网络失败/离线再回退 Apple 机内翻译；都失败/不可用则显示原文。
      const hasCJK = (s: string): boolean => {
        for (let i = 0; i < s.length; i++) {
          const c = s.charCodeAt(i)
          if ((c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) return true
        }
        return false
      }
      const txTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> => new Promise<T>((res, rej) => {
        const t = setTimeout(() => rej(new Error("timeout")), ms)
        p.then((v: T) => { clearTimeout(t); res(v) }, (e) => { clearTimeout(t); rej(e) })
      })
      // 免费网络翻译兜底（谷歌：Chrome 词典端点更抗限流，优先；失败再走 gtx；无需密钥、不挑 Pro/iOS18/语言包）
      const translateNetwork = (text: string, ms: number): Promise<string> => {
        const dictUrl = "https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=zh-CN&tl=en&q=" + encodeURIComponent(text)
        const gtxUrl = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=en&dt=t&q=" + encodeURIComponent(text)
        const pick = (url: string) => txTimeout(fetch(url), ms).then(async (res) => {
          if (!res.ok) throw new Error("HTTP " + res.status)
          const data: any = await res.json()
          if (Array.isArray(data) && typeof data[0] === "string") return data[0]
          const segs: any[] = Array.isArray(data?.[0]) ? data[0] : []
          let out = ""
          for (const s of segs) { if (Array.isArray(s) && typeof s[0] === "string") out += s[0] }
          return out
        })
        return pick(dictUrl).catch(() => pick(gtxUrl))
      }
      // 中→英：网络优先，失败回退 Apple 机内翻译
      const translateNote = (text: string): Promise<string> => (async () => {
        try {
          const r = await translateNetwork(text, 6000)
          if (r && r.trim()) return r.trim()
        } catch (e) {}
        try {
          const raw: any = await txTimeout(Translation.shared.translate({ text, source: "zh", target: "en" }) as any, 4000)
          const r = typeof raw === "string" ? raw : ""
          return r && r.trim() ? r.trim() : text
        } catch (e) { return text }
      })()
      const [translations, setTranslations] = useState<Record<string, string>>({})
      useEffect(() => {
        if (!isEn || !current) return
        const n = current.note
        if (translations[n] != null) return
        if (!hasCJK(n)) { setTranslations((p) => ({ ...p, [n]: n })); return }
        let alive = true
        translateNote(n)
          .then((out: string) => { if (alive) setTranslations((p) => ({ ...p, [n]: out && out.trim() ? out.trim() : n })) })
          .catch(() => { if (alive) setTranslations((p) => ({ ...p, [n]: n })) })
        return () => { alive = false }
      }, [isEn, current])
      const displayNote = current ? (translations[current.note] != null ? translations[current.note] : current.note) : ""
      // 底部按钮列宽与标签：英文文案（如「No remind」）比中文长，原先 36 的标签宽度会把英文文字
      // 截断成「No remi…」（英文版本下按钮文字显示不全），因此列宽放宽到 48，并允许标签按需缩放，
      // 保证中英文标签都完整显示；图标仍为 36×36 圆形，列内居中，视觉不变
      const buttonColumnWidth = 48
      const buttonLabel = (label: string) => (
        <Text font={9} foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.6} allowsTightening frame={{ maxWidth: buttonColumnWidth }}>{label}</Text>
      )
      const navButton = (icon: string, color: any, disabled: boolean, action: () => void, label: string) => (
        <VStack alignment="center" spacing={2} frame={{ width: buttonColumnWidth }}>
          <ZStack
            frame={{ width: 36, height: 36 }}
            background={{
              style: { color: disabled ? "label" : color, opacity: disabled ? 0.08 : 0.15 },
              shape: { type: "rect", cornerRadius: 18 },
            }}
            contentShape={{ kind: "interaction", shape: "rect" }}
            onTapGesture={() => { if (!disabled) action() }}
          >
            <Image systemName={icon} font={14} foregroundStyle={disabled ? "secondaryLabel" : color} />
          </ZStack>
          {!hideButtonLabels && buttonLabel(label)}
        </VStack>
      )
      // 底部操作按钮（图标 + 可选文字标签）：hideButtonLabels 开启（隐藏）时只显示纯圆形图标
      const actionButton = (icon: string, color: any, label: string, action: () => void) => (
        <VStack alignment="center" spacing={2} frame={{ width: buttonColumnWidth }}>
          <ZStack
            frame={{ width: 36, height: 36 }}
            background={{ style: { color, opacity: 0.15 }, shape: { type: "rect", cornerRadius: 18 } }}
            contentShape={{ kind: "interaction", shape: "rect" }}
            onTapGesture={action}
          >
            <Image systemName={icon} font={14} foregroundStyle={color} />
          </ZStack>
          {!hideButtonLabels && buttonLabel(label)}
        </VStack>
      )
      return (
        <NavigationStack translationHost={Translation.shared}>
          <VStack navigationTitle={props.scriptName + (isEn ? " · Changelog" : " · 更新说明")} navigationBarTitleDisplayMode="inline" navigationBarBackButtonHidden spacing={0}>
            {total === 0 ? (
              <VStack alignment="center" spacing={8} padding={32} frame={{ maxHeight: "infinity" }}>
                <Text font="subheadline" foregroundStyle="secondaryLabel">{noHistoryText}</Text>
              </VStack>
            ) : current ? (
              <>
                <HStack alignment="center" padding={{ top: 14, horizontal: 16, bottom: 10 }}>
                  <Text font="headline" bold>{versionPrefix}{current.version}</Text>
                  <Spacer />
                  <Text font="caption2" foregroundStyle="secondaryLabel">{pageText(pageIndex + 1, total)}</Text>
                </HStack>
                <ZStack alignment="bottomTrailing" frame={{ maxHeight: "infinity" }}>
                  <ScrollView
                    frame={{ maxHeight: "infinity" }}
                    scrollIndicator="visible"
                    scrollPosition={{ value: scrollAnchor, onChanged: (v) => setScrollAnchor(v as string | null), anchor: "bottom" }}
                    onScrollTargetVisibilityChange={{
                      idType: "string",
                      threshold: 0,
                      onChanged: (ids) => {
                        // 首次回调确定底部 Divider 是否初始可见：可见 ⇒ 内容不满一页
                        setEndInitiallyVisible((prev) =>
                          prev === null ? (Array.isArray(ids) && (ids as string[]).includes("changelog-end")) : prev
                        )
                      },
                    }}
                  >
                    <VStack scrollTargetLayout alignment="leading" spacing={10} padding={{ horizontal: 16, bottom: 24 }}>
                      <VStack key="note" alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}>
                        <Text font="body" multilineTextAlignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}>{displayNote}</Text>
                      </VStack>
                      {!shortContent && <Divider key="changelog-end" />}
                    </VStack>
                  </ScrollView>
                  {!shortContent && !atBottom && (
                    <VStack padding={{ horizontal: 12, vertical: 10 }}>
                      <Image systemName="arrow.down.circle" font={15} foregroundStyle="systemBlue" />
                    </VStack>
                  )}
                </ZStack>
              </>
            ) : null}
            <VStack spacing={2} alignment="center" padding={{ horizontal: 16, vertical: 12 }} background={{ style: "barMaterial", shape: { type: "rect", cornerRadius: 16 } }} shadow={{ radius: 8, y: 2, color: "#00000014" }}>
              <HStack spacing={8} alignment="center" padding={{ horizontal: 10, vertical: 8 }}>
                {navButton("backward.end.fill", "systemBlue", atFirst, () => setPageIndex(0), labelFirst)}
                {navButton("chevron.left", "systemBlue", atFirst, () => setPageIndex(pageIndex - 1), labelPrev)}
                {navButton("chevron.right", "systemBlue", atLast, () => setPageIndex(pageIndex + 1), labelNext)}
                {navButton("forward.end.fill", "systemBlue", atLast, () => setPageIndex(total - 1), labelLast)}
              </HStack>
              <HStack spacing={8} alignment="center">
                {actionButton("bell.slash", "systemRed", labelNoRemind, () => { markSeen(); dismiss() })}
                {actionButton("xmark", "label", labelDismiss, () => dismiss())}
              </HStack>
            </VStack>
          </VStack>
        </NavigationStack>
      )
    }
    await Navigation.present({
      element: <ChangelogView note={note} version={version} scriptName={scriptName} history={history} />,
    })
  } catch (e) {}
})();
// ===== 更新说明检查结束 =====















import {
  AppEvents, Button, ContentUnavailableView, Divider, HStack, Image, List, Navigation, NavigationLink,
  NavigationStack, Notification, Picker, ProgressView, Script, ScrollView, Section, SecureField, Spacer,
  Text, TextField, Toggle, VStack, WebView, ZStack, gradient, useEffect, useMemo, useRef, useState,
} from "scripting"
import {
  createCloudMailAccount, deleteCloudMailAccount, deleteMessage, fetchAccountMessages, fetchOlderAccountMessages,
  fetchCloudMailAccounts, fetchCloudMailWebsiteConfig, fetchSingleMessage, loginCloudMail, markMessageRead,
  parseDateString, pinCloudMailAccount, renameCloudMailAccount, setCloudMailAllReceive,
} from "./api"
import { authorizeGmail, disconnectGmail, gmailOAuthConfigured, isGmailAuthorized } from "./gmail"
import { authorizeMicrosoft, disconnectMicrosoft, isMicrosoftAuthorized, microsoftOAuthConfigured } from "./microsoft"
import type { CloudMailRemoteAccount, MailAccount, MailMessage, Provider } from "./models"
import { isMessageMatch, providerColor, providerIcon, providerName, stripEmailSignature } from "./models"
import { demoMessages, getICloudAccountBackupStatus, loadAccounts, loadMessageContent, isMessageContentFull, saveMessageContent, loadMessageSnapshot, loadSecret, makeAccount, removeAccount, restoreAccountsFromICloud, saveAccounts, saveMessageSnapshot, saveSecret, syncAccountsToICloud, type ICloudAccountBackupStatus } from "./store"
import { unsubscribeFromHtml, unsubscribeMessage } from "./unsubscribe"
import { extractVerificationCode } from "./verification"
import { testImapAccount } from "./imap"
import { imapGatewayConfigured } from "./mail-gateway-config"
import { clearBackgroundPush, configureBackgroundPush, hasBackgroundPushConfiguration, importAndConfigureBackgroundPush, loadBackgroundPushAdminToken, loadBackgroundPushStatus, saveBackgroundPushAdminToken, testBackgroundPush, type BackgroundPushStatus } from "./background-push"

declare function fetch(url: string, init?: any): Promise<any>

const formattedDateCache = new Map<string, string>()
const timestampCache = new Map<string, number>()

function messageTimestamp(value: unknown): number {
  if (!value) return 0
  if (typeof value === "number") {
    return value < 1e11 ? value * 1000 : value
  }
  const str = String(value).trim()
  if (!str) return 0
  const cached = timestampCache.get(str)
  if (cached !== undefined) return cached

  // 1. 纯数字时间戳（毫秒或秒）
  if (/^\d+$/.test(str)) {
    const num = Number(str)
    const normalized = num < 1e11 ? num * 1000 : num
    timestampCache.set(str, normalized)
    if (timestampCache.size > 1000) timestampCache.delete(timestampCache.keys().next().value!)
    return normalized
  }

  // 兼容来自通知 query 或未带时区后缀的 UTC 时间字符串（例如 2026-10-05 15:40:00）
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(str)) {
    const utcTs = Date.parse(str.replace(" ", "T") + "Z")
    if (Number.isFinite(utcTs) && utcTs > 0) {
      timestampCache.set(str, utcTs)
      if (timestampCache.size > 1000) timestampCache.delete(timestampCache.keys().next().value!)
      return utcTs
    }
  }

  // 2. 标准解析
  let ts = Date.parse(str)
  if (Number.isFinite(ts) && ts > 0) {
    timestampCache.set(str, ts)
    if (timestampCache.size > 1000) timestampCache.delete(timestampCache.keys().next().value!)
    return ts
  }

  // 3. 常见中文或带斜杠日期，例如 2026/09/19 15:30:00 或 2026年9月19日
  const match = str.match(/^(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})(?:日)?(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/)
  if (match) {
    const [, y, m, d, h = "0", min = "0", s = "0"] = match
    ts = new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(s)).getTime()
    if (Number.isFinite(ts) && ts > 0) {
      timestampCache.set(str, ts)
      if (timestampCache.size > 1000) timestampCache.delete(timestampCache.keys().next().value!)
      return ts
    }
  }

  // 4. 清除括号如 (CST) 或 RFC 2822 尾部注释重试
  const cleaned = str.replace(/\([A-Za-z0-9_+\-\s]+\)/g, "").trim()
  ts = Date.parse(cleaned)
  if (Number.isFinite(ts) && ts > 0) {
    timestampCache.set(str, ts)
    if (timestampCache.size > 1000) timestampCache.delete(timestampCache.keys().next().value!)
    return ts
  }

  timestampCache.set(str, 0)
  return 0
}

let cachedAccountOrders: Map<string, number> | undefined

function invalidateAccountOrderCache() {
  cachedAccountOrders = undefined
}

function accountOrder(accountId: string): number {
  if (!cachedAccountOrders) {
    cachedAccountOrders = new Map()
    const accounts = loadAccounts()
    accounts.forEach((acc, idx) => cachedAccountOrders!.set(acc.id, idx))
  }
  return cachedAccountOrders.get(accountId) ?? 9999
}

function messageStableKey(message: MailMessage) {
  return `${message.accountId}:${message.id}`
}

function compareMessagesDescending(a: MailMessage, b: MailMessage) {
  const timeDifference = messageTimestamp(b.date) - messageTimestamp(a.date)
  if (timeDifference !== 0) return timeDifference
  const orderDifference = accountOrder(a.accountId) - accountOrder(b.accountId)
  return orderDifference || messageStableKey(b).localeCompare(messageStableKey(a))
}

function compareMessagesAscending(a: MailMessage, b: MailMessage) {
  const timeDifference = messageTimestamp(a.date) - messageTimestamp(b.date)
  if (timeDifference !== 0) return timeDifference
  const orderDifference = accountOrder(a.accountId) - accountOrder(b.accountId)
  return orderDifference || messageStableKey(a).localeCompare(messageStableKey(b))
}

function formatDate(value: string) {
  const cached = formattedDateCache.get(value)
  if (cached !== undefined) return cached
  const ts = messageTimestamp(value)
  let formatted: string
  if (ts <= 0) {
    formatted = value
  } else {
    const date = new Date(ts)
    formatted = date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
  }
  formattedDateCache.set(value, formatted)
  if (formattedDateCache.size > 1000) formattedDateCache.delete(formattedDateCache.keys().next().value!)
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
  let sourceHtml: string
  const isPendingFullHtml = !message.html?.trim() && (message.isPlaceholder || message.id.startsWith("notif-"))
  if (message.html?.trim()) {
    sourceHtml = message.html.trim()
  } else if (message.body?.trim() || message.preview?.trim()) {
    const rawBody = (message.body?.trim() || message.preview?.trim() || "").trim()
    const loadingBanner = isPendingFullHtml
      ? `<div style="display:flex;align-items:center;gap:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:9px 13px;margin-bottom:16px;font-size:13px;color:#64748b;font-weight:500;"><div style="width:7px;height:7px;border-radius:50%;background:#0284c7;flex-shrink:0;"></div><span>正在同步完整图文排版与图片…</span></div>`
      : ""
    sourceHtml = `${loadingBanner}<pre class="plain-text">${escapeHtml(rawBody)}</pre>`
  } else {
    // 如果没有任何可用内容，至少渲染一个空容器，防止 WebView 完全不刷新
    sourceHtml = `<pre class="plain-text" style="color: #94a3b8; text-align: center; margin-top: 40px;">（无内容可显示）</pre>`
  }
  // 关键优化：移除 loading="lazy"，邮件图片直接以最高优先级并行加载，杜绝 Loon 等顶栏图标延迟显现
  const optimizedHtml = sourceHtml.replace(/<img\b(?![^>]*\bdecoding=)([^>]*)>/gi, '<img decoding="async"$1>')
  const safeSourceHtml = optimizedHtml.replace(/<\/script/gi, "<\\/script")
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>html,body{margin:0;min-height:100%;background:#fff}body{padding:16px;overflow-x:hidden;max-width:100%;box-sizing:border-box}.plain-text{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;width:100%;max-width:100%;box-sizing:border-box;margin:0;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#16181b}a,button{border-radius:8px}a[style*="background"],a[style*="background-color"],button{overflow:hidden;transition:opacity .15s}a[style*="background"]:active,a[style*="background-color"]:active,button:active{opacity:.72}</style></head><body><div id="mail-host"></div><script type="text/plain" id="mail-source">${safeSourceHtml}</script><script>(()=>{const sourceEl=document.getElementById("mail-source");const html=sourceEl?sourceEl.textContent||"":"";const host=document.getElementById("mail-host");if(!host)return;const root=host.attachShadow({mode:"open"});const bodyStyleMatch=html.match(/<body[^>]*style="([^"]*)"[^>]*>/i);const bodyStyle=bodyStyleMatch?bodyStyleMatch[1]:"";const cleanedHtml=html.replace(/<\\/?body[^>]*>/gi,"");const styleEl=document.createElement("style");styleEl.textContent=\`:host{all:initial;width:100%;height:100%;font-family:-apple-system,Inter,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:14px;line-height:1.5;color:#16181b;word-break:break-word}pre,.plain-text{white-space:pre-wrap!important;word-break:break-word!important;overflow-wrap:anywhere!important;font-family:-apple-system,Inter,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif!important;font-size:15px!important;line-height:1.6!important;color:#16181b!important;margin:0!important;padding:0!important}h1,h2,h3,h4{font-size:18px;font-weight:700}p{margin:0}a{text-decoration:none;color:#007aff}a[style*='background'],a[style*='background-color'],td[bgcolor]>a:only-child,td[style*='background']>a:only-child,button{border-radius:12px!important;overflow:hidden;transition:opacity .15s ease,transform .15s ease}.mail-action-cell{border-radius:12px!important;overflow:hidden!important}a[style*='background']:active,a[style*='background-color']:active,td[bgcolor]>a:only-child:active,td[style*='background']>a:only-child:active,button:active{opacity:.78;transform:scale(.985)}.shadow-content{background:#fff;width:100%;max-width:100%;height:fit-content;min-width:0;border-radius:14px;overflow:hidden;overflow-wrap:anywhere;word-break:break-word;\${bodyStyle}}img:not(table img){max-width:100%;height:auto!important}\`;root.appendChild(styleEl);const contentDiv=document.createElement("div");contentDiv.className="shadow-content";contentDiv.innerHTML=cleanedHtml;root.appendChild(contentDiv);contentDiv.querySelectorAll("a[style*='background'],a[style*='background-color']").forEach(link=>{const cell=link.closest('td');if(cell)cell.classList.add('mail-action-cell')});contentDiv.querySelectorAll('a').forEach(a=>{a.removeAttribute('target')});contentDiv.addEventListener('click',e=>{const path=typeof e.composedPath==='function'?e.composedPath():[];const link=path.find(el=>el&&el.tagName==='A')||(e.target&&e.target.closest?e.target.closest('a'):null);if(link&&link.href){const href=link.href;if(/^(?:https?|mailto|tel):/i.test(href)){e.preventDefault();e.stopPropagation();window.webkit?.messageHandlers?.mailOpenLink?.postMessage(href);}}},true);window.open=url=>{if(url&&typeof url==='string'&&/^(?:https?|mailto|tel):/i.test(url)){window.webkit?.messageHandlers?.mailOpenLink?.postMessage(url)}return null};const original=new Map();const nodes=()=>{const out=[];const walker=document.createTreeWalker(contentDiv,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){const parent=node.parentElement;if(!parent||parent.closest('script,style,noscript,textarea,input,select,option'))continue;if(node.nodeValue&&node.nodeValue.trim())out.push(node)}return out};window.__mailTranslation={read:()=>nodes().map(node=>node.nodeValue||''),apply:(values)=>nodes().forEach((node,index)=>{if(!original.has(node))original.set(node,node.nodeValue||'');if(values[index]!==undefined)node.nodeValue=values[index]}),restore:()=>{nodes().forEach(node=>{if(original.has(node))node.nodeValue=original.get(node)});original.clear()}};const reveal=()=>{host.style.visibility='visible';window.webkit?.messageHandlers?.mailBodyReady?.postMessage(true);requestAnimationFrame(()=>{const width=host.parentElement?.clientWidth||0;const contentWidth=contentDiv?.scrollWidth||0;host.style.zoom=String(width&&contentWidth?Math.min(1,width/contentWidth):1)})};reveal();})()</script></body></html>`
}

const mailDocumentCache = new Map<string, string>()
const mailTranslationCache = new Map<string, string[]>()
let snapshotTimer: ReturnType<typeof setTimeout> | undefined
let pendingSnapshot: MailMessage[] | undefined
let inboxRefreshInFlight = false
let lastNotificationHandledAt = 0
const pendingReadMessageKeys = new Set<string>()

// ===== 活跃详情页更新订阅总线 =====
// 用于通知占位邮件打开后，后台增量同步一旦拉回真实完整邮件，即刻推送至前台详情页更新
type ActiveDetailSubscriber = {
  targetMessage: MailMessage
  updateMessage: (realMsg: MailMessage) => void
}
const activeDetailSubscribers = new Set<ActiveDetailSubscriber>()

function broadcastRealMessageToDetail(incoming: MailMessage[]) {
  if (activeDetailSubscribers.size === 0 || incoming.length === 0) return
  for (const subscriber of activeDetailSubscribers) {
    const matched = incoming.find(item => 
      !item.isPlaceholder && 
      item.accountId === subscriber.targetMessage.accountId &&
      (
        item.id === subscriber.targetMessage.id ||
        isMessageMatch(
          { id: item.id, subject: item.subject, from: item.from, date: item.date, preview: item.preview },
          subscriber.targetMessage.id,
          subscriber.targetMessage.subject,
          subscriber.targetMessage.from,
          subscriber.targetMessage.date,
          subscriber.targetMessage.preview
        )
      )
    )
    if (matched) {
      const tTime = new Date(subscriber.targetMessage.date || "").getTime()
      const cTime = new Date(matched.date || "").getTime()
      if (!Number.isFinite(tTime) || !Number.isFinite(cTime) || Math.abs(tTime - cTime) < 24 * 3600 * 1000) {
        const hydrated = loadMessageContent(matched)
        subscriber.updateMessage(hydrated)
      }
    }
  }
}

function scheduleMessageSnapshot(messages: MailMessage[], delay = 180) {
  pendingSnapshot = messages
  if (snapshotTimer !== undefined) clearTimeout(snapshotTimer)
  snapshotTimer = setTimeout(() => {
    snapshotTimer = undefined
    const snapshot = pendingSnapshot
    pendingSnapshot = undefined
    if (snapshot) {
      // 安全防护：绝不允许任何异步刷新把既有的有效快照无故覆盖为空数组
      const existing = loadMessageSnapshot()
      if (snapshot.length === 0 && existing.length > 0) {
        console.warn("拦截到异常的空快照写入，保留既有快照")
        return
      }
      saveMessageSnapshot(snapshot)
    }
  }, delay)
}
const googleTextCache = new Map<string, string>()
const GOOGLE_FALLBACK_KEY = "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520"
const GOOGLE_KEY_SCRIPT = "https://translate.googleapis.com/_/translate_http/_/js/k=translate_http.tr.en_US.YusFYy3P_ro.O/am=AAg/d=1/exm=el_conf/ed=1/rs=" + "AN8SPfq1Hb8iJRleQqQc8zhdzXmF9E56eQ/m=el_main"
let googleApiKey = GOOGLE_FALLBACK_KEY
let googleApiKeyAt = Date.now()

async function getGoogleApiKey(force = false) {
  if (!force && googleApiKey && Date.now() - googleApiKeyAt < 20 * 60 * 1000) return googleApiKey
  try {
    const response = await fetch(GOOGLE_KEY_SCRIPT)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const source = await response.text()
    googleApiKey = source.match(/["']x-goog-api-key["']\s*:\s*["'](\w{39})["']/i)?.[1] || GOOGLE_FALLBACK_KEY
  } catch {
    googleApiKey = GOOGLE_FALLBACK_KEY
  }
  googleApiKeyAt = Date.now()
  return googleApiKey
}

async function requestGoogleHtml(texts: string[], retry = true): Promise<string[]> {
  const key = await getGoogleApiKey()
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

function hydrateDetailMessage(message: MailMessage): MailMessage {
  try {
    const snapshot = loadMessageSnapshot()
    const cached = snapshot.find(candidate =>
      !candidate.isPlaceholder &&
      !candidate.id.startsWith("notif-") &&
      candidate.accountId === message.accountId &&
      (
        candidate.id === message.id ||
        isMessageMatch(
          { id: candidate.id, subject: candidate.subject, from: candidate.from, date: candidate.date, preview: candidate.preview },
          message.id, message.subject, message.from, message.date, message.preview,
        )
      ),
    )
    if (cached) {
      const hydrated = loadMessageContent(cached)
      if (hydrated.html || isMessageContentFull(hydrated)) return { ...hydrated, unread: message.unread }
    }
  } catch {}
  return loadMessageContent(message)
}

function MessageDetail({ message, account, onRead, onReadFailed, onDeleted, onDeleteFailed, onMessageUpdated, onCustomBack, onClose }: { message: MailMessage; account?: MailAccount; onRead: () => void; onReadFailed: (error: unknown) => void; onDeleted: () => void; onDeleteFailed: (error: unknown) => void; onMessageUpdated?: (updated: MailMessage) => void; onCustomBack?: () => void; onClose?: () => void }) {
  const dismissBase = Navigation.useDismiss()
  const dismiss = () => { onClose?.(); dismissBase() }
  const [activeMessage, setActiveMessage] = useState(() => hydrateDetailMessage(message))
  const [busy, setBusy] = useState(false)
  const [translated, setTranslated] = useState(false)
  const [status, setStatus] = useState(message.isPlaceholder ? "" : "")
  const [bodyReady, setBodyReady] = useState(false)
  const [syncFailed, setSyncFailed] = useState(false)
  const controller = useMemo(() => new WebViewController(), [])
  const translationKey = `${activeMessage.accountId}:${activeMessage.id}:${activeMessage.body.length}`
  const translationSupported = parseFloat(Device.systemVersion) >= 18
  const translator = useMemo(() => translationSupported ? new Translation() : undefined, [])
  const unsubscribeInfo = useMemo(() => activeMessage.unsubscribeUrl
    ? { url: activeMessage.unsubscribeUrl, oneClick: Boolean(activeMessage.unsubscribeOneClick) }
    : unsubscribeFromHtml(activeMessage.html ?? ""), [activeMessage])

  // 1. 订阅后台增量同步：只要当前邮件仍是通知临时对象或缺少完整 html，
  // 一旦后台拉回真实邮件，即刻无缝替换当前内容并即时更新，无需用户退出重进！
  useEffect(() => {
    const isComplete = Boolean(activeMessage.html?.trim()) && !activeMessage.isPlaceholder && !activeMessage.id.startsWith("notif-")
    if (isComplete) return
    const sub: ActiveDetailSubscriber = {
      targetMessage: activeMessage,
      updateMessage: (realMsg: MailMessage) => {
        // 订阅后台更新过来的邮件同样需要强制抹除未读状态，防止由于竞态条件导致蓝点复活
        realMsg.unread = false
        setActiveMessage(realMsg)
        onMessageUpdated?.(realMsg)
        setStatus("")
        setSyncFailed(false)
      }
    }
    activeDetailSubscribers.add(sub)

    // 关键双保险：本地快照高频轮询，一旦后台同步把真实邮件写回磁盘，当前详情页最快 500ms 内就地自动升级，绝不需退出再点！
    let stopped = false
    let tickCount = 0
    let pollTimer: ReturnType<typeof setTimeout> | undefined

    const runPoll = () => {
      if (stopped) return
      tickCount += 1
      if (tickCount > 25) return
      try {
        const snapshot = loadMessageSnapshot()
        const matched = snapshot.find(m =>
          !m.isPlaceholder &&
          !m.id.startsWith("notif-") &&
          (account ? m.accountId === account.id : true) &&
          isMessageMatch(
            { id: m.id, subject: m.subject, from: m.from, date: m.date, preview: m.preview },
            activeMessage.id, activeMessage.subject, activeMessage.from, activeMessage.date, activeMessage.preview
          )
        )
        if (matched) {
          const hydrated = loadMessageContent(matched)
          if (isMessageContentFull(hydrated) || hydrated.html || (hydrated.body && hydrated.body.length >= (activeMessage.body?.length || 0))) {
            stopped = true
            hydrated.unread = false
            setActiveMessage(hydrated)
            onMessageUpdated?.(hydrated)
            setStatus("")
            setSyncFailed(false)
            return
          }
        }
      } catch {}
      if (!stopped) {
        pollTimer = setTimeout(runPoll, 500)
      }
    }
    pollTimer = setTimeout(runPoll, 500)

    return () => {
      stopped = true
      if (pollTimer !== undefined) clearTimeout(pollTimer)
      activeDetailSubscribers.delete(sub)
    }
  }, [activeMessage.id, activeMessage.isPlaceholder, Boolean(activeMessage.html), account?.baseUrl])

  // 2. 主动单封拉取同步
  function syncBody(force = false) {
    const isComplete = Boolean(activeMessage.html?.trim()) && !activeMessage.isPlaceholder && !activeMessage.id.startsWith("notif-")
    if (!force && isComplete) return
    if (!account) {
      if (activeMessage.isPlaceholder) {
        setSyncFailed(true)
        setStatus("未找到对应邮箱账号，无法拉取正文")
      }
      return
    }
    setSyncFailed(false)
    setStatus("")

    let active = true
    const timeoutTimer = setTimeout(() => {
      if (!active) return
      active = false
      setSyncFailed(true)
      setStatus(activeMessage.preview ? "后台正文补全超时，当前先显示摘要" : "后台正文补全超时，请稍后重试")
    }, 15000)

    const attemptFetch = async (retries = 3) => {
      let lastError = ""
      for (let i = 0; i < retries; i++) {
        if (!active) return

        // 优先查验本地快照并 hydration
        try {
          const snapshot = loadMessageSnapshot()
          const cached = snapshot.find(m => 
            !m.isPlaceholder && 
            m.accountId === account.id &&
            isMessageMatch(
              { id: m.id, subject: m.subject, from: m.from, date: m.date, preview: m.preview },
              activeMessage.id, activeMessage.subject, activeMessage.from, activeMessage.date, activeMessage.preview
            )
          )
          if (cached) {
            const hydrated = loadMessageContent(cached)
            if (isMessageContentFull(hydrated)) {
              clearTimeout(timeoutTimer)
              hydrated.unread = false
              setActiveMessage(hydrated)
              onMessageUpdated?.(hydrated)
              setStatus("")
              setSyncFailed(false)
              return
            }
          }
        } catch {}

        try {
          const fullMsg = await fetchSingleMessage(account, activeMessage.id, activeMessage.subject, activeMessage.from, activeMessage.date, activeMessage.preview, true)
          if (!active) return
          if (fullMsg) {
            clearTimeout(timeoutTimer)
            saveMessageContent(fullMsg)
            fullMsg.unread = false
            setActiveMessage(fullMsg)
            onMessageUpdated?.(fullMsg)
            setStatus("")
            setSyncFailed(false)
            return
          }
        } catch (e) {
           console.error("Fetch single message failed:", e)
           lastError = String((e as any)?.message ?? e)
        }

        if (i < retries - 1) {
          await new Promise(r => setTimeout(() => r(void 0), 1500))
        }
      }

      if (!active) return
      clearTimeout(timeoutTimer)
      setSyncFailed(true)
      setStatus(`正文加载失败，点击重试 (${lastError})`)
    }

    attemptFetch().catch(err => {
      if (!active) return
      clearTimeout(timeoutTimer)
      setSyncFailed(true)
      setStatus(`正文同步失败：${String((err as any)?.message ?? err)}`)
    })

    return () => {
      active = false
      clearTimeout(timeoutTimer)
    }
  }

  useEffect(() => {
    // 只要当前邮件不是完整邮件（无 html 或仍是通知临时对象），在后台拉取完整正文
    const isComplete = Boolean(activeMessage.html?.trim()) && !activeMessage.isPlaceholder && !activeMessage.id.startsWith("notif-")
    if (isComplete) return
    const cleanup = syncBody()
    return () => { cleanup?.() }
  }, [activeMessage.id, activeMessage.isPlaceholder, activeMessage.body, activeMessage.html, account?.id])

  async function performUnsubscribe() {
    if (!unsubscribeInfo || busy) return
    setBusy(true)
    setStatus("正在取消订阅…")
    try {
      const oneClick = await unsubscribeMessage({
        ...activeMessage,
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
    try { (Notification as any).removeDelivereds([activeMessage.id]) } catch {}
    deleteMessage(account, activeMessage.id).catch(error => {
      const errorMsg = String((error as any)?.message ?? error)
      if (
        errorMsg.includes("404") ||
        errorMsg.toLowerCase().includes("not found") ||
        errorMsg.includes("HTTP 404") ||
        errorMsg.includes("邮件缓存已过期") ||
        errorMsg.includes("MAILBOX_CHANGED") ||
        errorMsg.includes("UID 无效") ||
        errorMsg.includes("超时") ||
        errorMsg.includes("Timeout")
      ) {
        // 这些属于本地已删或远程状态不一致/已不存在，保持删除状态，绝不恢复！
        return
      }
      onDeleteFailed(error)
    })
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
        if (["mailto:", "tel:", "http:", "https:"].includes(url.protocol)) {
          await Safari.openURL(url.href)
          return false
        }
        return false
      }
      if (["about:", "data:", "cid:"].includes(url.protocol)) return true
      return request.method === "GET" && ["http:", "https:"].includes(url.protocol)
    }
    let mounted = true
    controller.addScriptMessageHandler("mailOpenLink", async (href?: string) => {
      if (typeof href === "string" && href) {
        if (unsubscribeInfo && href === unsubscribeInfo.url) {
          await performUnsubscribe()
        } else if (/^(?:https?|mailto|tel):/i.test(href)) {
          await Safari.openURL(href)
        }
      }
      return true
    })
    controller.addScriptMessageHandler("mailBodyReady", () => {
      if (mounted) setBodyReady(true)
      return true
    })
    
    if (account && ["cloudmail", "gmail", "microsoft", "qq", "netease163", "netease126", "yeah"].includes(account.provider) && activeMessage.unread) {
      // Update the list immediately; reconcile with the provider in the background.
      const messageKey = `${activeMessage.accountId}:${activeMessage.id}`
      pendingReadMessageKeys.add(messageKey)
      onRead()
      try { (Notification as any).removeDelivereds([activeMessage.id]) } catch {}
      markMessageRead(account, activeMessage.id)
        .then(() => pendingReadMessageKeys.delete(messageKey))
        .catch(error => {
          pendingReadMessageKeys.delete(messageKey)
          onReadFailed(error)
        })
    }
    return () => { mounted = false; controller.dispose(); onClose?.() }
  }, [])

  // 当 activeMessage 内容改变或准备就绪时，加载最新 HTML 文档
  useEffect(() => {
    controller.loadHTML(cachedMailBodyDocument(activeMessage), account?.baseUrl || "about:blank").catch(console.error)
  }, [activeMessage.id, activeMessage.body, activeMessage.html, activeMessage.isPlaceholder, account?.baseUrl])

  return (
    <VStack
      spacing={0}
      navigationTitle="邮件"
      navigationBarTitleDisplayMode="inline"
      translationHost={translator ?? undefined}
      toolbarBackgroundVisibility={{ visibility: "hidden", bars: ["bottomBar"] }}
      ignoresSafeArea={{ edges: "bottom" }}
      toolbar={{
        topBarLeading: <Button title="返回" systemImage="chevron.left" action={() => { if (onCustomBack) onCustomBack(); else dismiss() }} />,
      topBarTrailing: <Button title="分享" systemImage="square.and.arrow.up" action={() => ShareSheet.present([`${activeMessage.subject}\n\n${activeMessage.body}`])} />,
      bottomBar: <HStack spacing={24} padding={{ horizontal: 12, vertical: 8 }}>
        {activeMessage.verificationCode ? <Button title="复制验证码" systemImage="doc.on.doc" action={() => Pasteboard.setString(activeMessage.verificationCode ?? "")} disabled={busy} /> : null}
        <Button title={translated ? "显示原文" : "翻译"} systemImage="translate" action={translateBody} disabled={busy || !activeMessage.body.trim() || !bodyReady} />
        {unsubscribeInfo ? <Button title="取消订阅" systemImage="envelope.badge" action={performUnsubscribe} disabled={busy} /> : null}
        {["cloudmail", "gmail", "qq", "netease163", "netease126", "yeah"].includes(account?.provider ?? "") ? <Button title={account?.provider === "gmail" ? "移入垃圾箱" : "删除"} systemImage="trash" role="destructive" action={remove} disabled={busy} /> : null}
      </HStack>,
    }} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <VStack alignment="leading" spacing={10} padding={{ top: 14, leading: 16, bottom: 14, trailing: 16 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <HStack spacing={10} frame={{ maxWidth: "infinity" }}>
          <Image systemName="person.crop.circle.fill" font="title" foregroundStyle="systemGray3" />
          <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font="subheadline" fontWeight="semibold" lineLimit={1}>{activeMessage.from}</Text>
            <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{activeMessage.to ? `发送至 ${activeMessage.to}` : providerName(activeMessage.provider)}</Text>
          </VStack>
          <Text font="caption" foregroundStyle="secondaryLabel">{formatDate(activeMessage.date)}</Text>
        </HStack>
        <Text font="title3" fontWeight="semibold">{activeMessage.subject}</Text>
        {activeMessage.verificationCode ? (
          <Button action={() => Pasteboard.setString(activeMessage.verificationCode ?? "")} buttonStyle="bordered" buttonBorderShape={{ roundedRectangleRadius: 12 }}>
            <HStack><Text font="caption" foregroundStyle="secondaryLabel">验证码</Text><Spacer /><Text font="title3" fontWeight="semibold" foregroundStyle="systemOrange">{activeMessage.verificationCode}</Text><Image systemName="doc.on.doc" foregroundStyle="systemOrange" /></HStack>
          </Button>
        ) : null}
      </VStack>
      <Divider />
      <ZStack alignment="trailing" padding={{ top: 10, leading: 16, bottom: 10, trailing: 16 }} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <WebView controller={controller} frame={{ maxWidth: "infinity", maxHeight: "infinity" }} clipShape={{ type: "rect", cornerRadius: 18, style: "continuous" }} />
        <VStack background="systemBackground" frame={{ width: 8, maxHeight: "infinity" }} allowsHitTesting={false} />
        {busy ? <VStack><Spacer /><HStack spacing={8} padding={10}><ProgressView /><Text font="caption" foregroundStyle="secondaryLabel">{status}</Text></HStack></VStack> : null}
      </ZStack>
      {!busy && status ? (
        <HStack spacing={8} padding={{ horizontal: 16, vertical: 6 }} alignment="center">
          <Text font="caption" foregroundStyle="secondaryLabel">{status}</Text>
          {syncFailed ? (
            <Button title="重试" systemImage="arrow.clockwise" controlSize="mini" buttonStyle="bordered" action={() => syncBody(true)} />
          ) : null}
        </HStack>
      ) : null}
      {(activeMessage.attachments?.length ?? 0) > 0 ? (
        <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Divider />
          <Text font="caption" fontWeight="semibold" foregroundStyle="secondaryLabel" padding={{ top: 8, leading: 16, bottom: 3, trailing: 16 }}>附件（{activeMessage.attachments?.length ?? 0}）</Text>
          {(activeMessage.attachments ?? []).map(attachment => (
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
    const code = authorizationCode.replace(/\s+/g, "")
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
  const [pushDetails, setPushDetails] = useState<BackgroundPushStatus | null>(null)
  const [iCloudStatus, setICloudStatus] = useState<ICloudAccountBackupStatus | null>(null)
  const [iCloudBusy, setICloudBusy] = useState(false)
  const [status, setStatus] = useState("")
  const reload = () => { setAccounts(loadAccounts()); onChanged() }

  useEffect(() => {
    let mounted = true
    loadBackgroundPushStatus().then(result => {
      if (!mounted) return
      setPushEnabled(result.enabled)
      setPushDetails(result)
    }).catch(() => {})
    getICloudAccountBackupStatus().then(result => {
      if (mounted) setICloudStatus(result)
    }).catch(error => {
      if (mounted) setStatus(`iCloud 状态读取失败：${String((error as any)?.message ?? error)}`)
    })
    return () => { mounted = false }
  }, [])

  async function syncICloudAccounts() {
    if (iCloudBusy) return
    setICloudBusy(true)
    setStatus("正在将账号配置同步到 iCloud")
    try {
      const result = await syncAccountsToICloud()
      setICloudStatus(result)
      setStatus(`已将 ${result.accountCount} 个账号配置同步到 iCloud`)
    } catch (error) {
      setStatus(`iCloud 同步失败：${String((error as any)?.message ?? error)}`)
    } finally { setICloudBusy(false) }
  }

  async function restoreICloudAccounts() {
    if (iCloudBusy) return
    setICloudBusy(true)
    setStatus("正在从 iCloud 恢复账号配置")
    try {
      const restored = await restoreAccountsFromICloud()
      reload()
      const result = await getICloudAccountBackupStatus()
      setICloudStatus(result)
      setStatus(result.backupExists ? `已从 iCloud 恢复 ${restored.length} 个账号配置` : "iCloud 中没有账号备份")
    } catch (error) {
      setStatus(`iCloud 恢复失败：${String((error as any)?.message ?? error)}`)
    } finally { setICloudBusy(false) }
  }

  async function importPushKey() {
    if (pushBusy) return
    setPushBusy(true)
    setStatus("正在导入新 Key、同步 Worker 并验证远程推送")
    try {
      saveBackgroundPushAdminToken(pushAdminToken)
      const result = await importAndConfigureBackgroundPush(loadAccounts(), loadMessageSnapshot())
      setPushEnabled(true)
      setPushDetails(result)
      setStatus(`Remote Push Key 已同步到本机和 Worker，测试已提交至 ${result.verification.deliveredTo} 台设备，编号：${result.verification.nonce}`)
    } catch (error) {
      setStatus(`Remote Push Key 同步失败：${String((error as any)?.message ?? error)}`)
    } finally { setPushBusy(false) }
  }

  async function enablePush() {
    if (pushBusy) return
    setPushBusy(true)
    setStatus("正在启用后台邮件推送")
    try {
      saveBackgroundPushAdminToken(pushAdminToken)
      const result = await configureBackgroundPush(loadAccounts(), loadMessageSnapshot())
      setPushEnabled(true)
      setPushDetails(result)
      setStatus(`后台推送配置已同步，正在监控 ${result.accountCount} 个邮箱`)
    } catch (error) {
      setStatus(String((error as any)?.message ?? error))
    } finally { setPushBusy(false) }
  }

  async function testPush() {
    if (pushBusy) return
    setPushBusy(true)
    setStatus("正在使用 Worker 已保存的订阅发送测试")
    try {
      saveBackgroundPushAdminToken(pushAdminToken)
      const result = await testBackgroundPush()
      setStatus(`测试推送已提交至 ${result.deliveredTo} 台设备，编号：${result.nonce}`)
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
      <Section header={<Text>iCloud 账号同步</Text>} footer={<Text>仅同步账号名称、地址和连接配置，不包含密码、JWT、OAuth 令牌或邮箱授权码。重新安装后如钥匙串凭据不可用，需要重新授权。</Text>}>
        <HStack spacing={12}>
          <Image systemName={iCloudStatus?.available ? "icloud.fill" : "icloud.slash.fill"} foregroundStyle={iCloudStatus?.available ? "systemBlue" : "secondaryLabel"} frame={{ width: 28 }} />
          <VStack alignment="leading" spacing={3}>
            <Text fontWeight="semibold">iCloud Drive</Text>
            <Text font="caption" foregroundStyle="secondaryLabel">{!iCloudStatus ? "正在读取状态" : !iCloudStatus.available ? "未启用或未授权" : iCloudStatus.backupExists ? `已有 ${iCloudStatus.accountCount} 个账号备份` : "尚无账号备份"}</Text>
          </VStack>
        </HStack>
        {iCloudStatus?.updatedAt ? <Text font="caption" foregroundStyle="secondaryLabel">最近同步：{new Date(iCloudStatus.updatedAt).toLocaleString("zh-CN")}</Text> : null}
        <Button title={iCloudBusy ? "正在处理" : "立即同步到 iCloud"} systemImage="arrow.up.icloud" action={syncICloudAccounts} disabled={iCloudBusy || iCloudStatus?.available === false} />
        <Button title="从 iCloud 恢复" systemImage="arrow.down.icloud" action={restoreICloudAccounts} disabled={iCloudBusy || !iCloudStatus?.backupExists} />
      </Section>
      <Section header={<Text>邮件推送</Text>} footer={<Text>管理员令牌在此页面明文显示，便于审查；实际仍只保存在本机 Keychain，并且 Worker 端继续使用加密 Secret。Remote Push Key、OAuth 刷新令牌和邮箱授权码不会改为明文存储。</Text>}>
        <TextField title="Worker 管理员令牌（MAIL_PUSH_ADMIN_TOKEN）" value={pushAdminToken} onChanged={setPushAdminToken} />
         <Text font="caption" foregroundStyle={pushAdminToken.trim() ? "systemGreen" : "systemRed"}>{pushAdminToken.trim() ? "已保存管理员令牌，可访问 Worker" : "未设置管理员令牌，更新和测试会返回未授权"}</Text>
        <Button title="粘贴并同步 Remote Push Key" systemImage="doc.on.clipboard" action={importPushKey} disabled={pushBusy || !pushAdminToken.trim()} />
        <HStack spacing={12}>
          <Image systemName={pushEnabled ? "bell.badge.fill" : "bell.slash.fill"} foregroundStyle={pushEnabled ? "systemGreen" : "secondaryLabel"} frame={{ width: 28 }} />
          <VStack alignment="leading" spacing={3}>
            <Text fontWeight="semibold">后台接收</Text>
            <Text font="caption" foregroundStyle="secondaryLabel">{pushEnabled ? "已启用" : "未启用"}</Text>
          </VStack>
          <Spacer />
          <Button title={pushBusy ? "处理中" : pushEnabled ? "更新" : "开启"} systemImage={pushEnabled ? "arrow.clockwise" : "bell.badge"} action={enablePush} disabled={pushBusy || !pushAdminToken.trim()} />
        </HStack>
        {pushEnabled ? <Button title="测试后台推送" systemImage="paperplane" action={testPush} disabled={pushBusy || !pushAdminToken.trim()} /> : null}
        {pushDetails?.accounts?.map(account => <Text key={account.id} font="caption" foregroundStyle={account.active ? "secondaryLabel" : "systemRed"}>{account.provider}：{account.active ? `正常${account.lastCheckedAt ? `，上次检查 ${account.lastCheckedAt}` : ""}` : account.lastError || "检查失败"}</Text>)}
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

function parseNotificationPayload(query?: Record<string, any>, notifObj?: any) {
  const notifUser = notifObj?.request?.content?.userInfo || notifObj?.userInfo || (Notification as any)?.current?.request?.content?.userInfo || (Notification as any)?.current?.userInfo
  const notifContent = notifObj?.request?.content || notifObj || (Notification as any)?.current?.request?.content || (Notification as any)?.current

  const mergedQuery: Record<string, any> = { ...(query || {}) }
  const rawAction = String(notifUser?.action || notifContent?.action || notifObj?.action || "")
  if (rawAction && rawAction.includes("?")) {
    try {
      const qs = rawAction.split("?")[1]
      const sp = new URLSearchParams(qs)
      for (const [k, v] of sp) {
        if (mergedQuery[k] === undefined) mergedQuery[k] = v
      }
    } catch {}
  }

  const accountId = (mergedQuery.accountId ? String(mergedQuery.accountId) : undefined) || (notifUser?.accountId ? String(notifUser.accountId) : undefined)
  const messageId = (mergedQuery.messageId ? String(mergedQuery.messageId) : undefined) || (notifUser?.messageId ? String(notifUser.messageId) : undefined)
  const from = (mergedQuery.from ? String(mergedQuery.from) : undefined) || (notifUser?.from ? String(notifUser.from) : undefined) || (notifContent?.title ? String(notifContent.title) : undefined)
  let subject = (mergedQuery.subject ? String(mergedQuery.subject) : undefined) || (notifUser?.subject ? String(notifUser.subject) : undefined)
  const date = (mergedQuery.date ? String(mergedQuery.date) : undefined) || (notifUser?.date ? String(notifUser.date) : undefined)
  const code = (mergedQuery.code ? String(mergedQuery.code) : undefined) || (notifUser?.code ? String(notifUser.code) : undefined)
  const to = (mergedQuery.to ? String(mergedQuery.to) : undefined) || (notifUser?.to ? String(notifUser.to) : undefined)
  const provider = (mergedQuery.provider ? (String(mergedQuery.provider) as Provider) : undefined) || (notifUser?.provider ? (String(notifUser.provider) as Provider) : undefined) || (notifUser?.accountScope ? (String(notifUser.accountScope) as Provider) : undefined)

  // 提取正文文本与预览：保持 body 与 html 原汁原味，绝不在正文上瞎改或抹去签名！
  let rawBodyText = (mergedQuery.body ? String(mergedQuery.body) : undefined) || (notifUser?.body ? String(notifUser.body) : undefined)
  let rawPreviewText = (mergedQuery.preview ? String(mergedQuery.preview) : undefined) || (notifUser?.preview ? String(notifUser.preview) : undefined)
  const html = (mergedQuery.html ? String(mergedQuery.html) : undefined) || (notifUser?.html ? String(notifUser.html) : undefined)

  if (notifContent?.body) {
    const rawContentBody = String(notifContent.body)
    const lines = rawContentBody.split("\n")
    if (lines.length >= 2) {
      if (!subject) subject = lines[0]
      const contentRest = lines.slice(1).join("\n")
      if (!rawBodyText) rawBodyText = contentRest
      if (!rawPreviewText) rawPreviewText = contentRest
    } else {
      if (!subject) subject = lines[0]
      if (!rawBodyText) rawBodyText = lines[0]
      if (!rawPreviewText) rawPreviewText = lines[0]
    }
  }

  // 最终的 body 必须保留全部原始文本（包括签名/发自我的 iPhone），首屏立即可见！
  const body = rawBodyText || rawPreviewText || ""
  // preview 仅用于列表单行摘要，去除签名
  const preview = rawPreviewText ? stripEmailSignature(rawPreviewText) : (body ? stripEmailSignature(body) : "")

  if (!accountId && !messageId && !subject && !preview && !from && !body && !html) return null
  return { accountId, messageId, from, to, subject, preview, date, code, body, html, provider }
}

function resolveNotificationAccount(accountId: string | undefined, from: string | undefined, to: string | undefined, accounts: MailAccount[], provider?: string): MailAccount | undefined {
  // 1. 明确指定的 internal accountId 最优先
  if (accountId) {
    const rawId = accountId.includes(":") ? accountId.split(":")[1] : accountId
    const found = accounts.find(a => a.id === rawId || a.id === accountId || (a.provider === "cloudmail" && (rawId === "cloudmail" || String(a.remoteAccountId) === rawId)))
    if (found) return found
  }

  // 2. 真实收件人 to 最权威：发往哪个邮箱地址，就归属哪个收件箱（优先级高于外部转发壳透传的 provider）
  if (to) {
    const lowerTo = to.toLowerCase()
    const gm = accounts.find(a => a.provider === "gmail" && a.enabled)
    if (gm && (lowerTo.includes("gmail-push") || (gm.address && lowerTo.includes(gm.address.toLowerCase())))) return gm
    const cm = accounts.find(a => a.provider === "cloudmail" && a.enabled)
    if (cm && cm.address && lowerTo.includes(cm.address.toLowerCase())) return cm
    const qq = accounts.find(a => a.provider === "qq" && a.enabled)
    if (qq && qq.address && lowerTo.includes(qq.address.toLowerCase())) return qq
    const netease = accounts.find(a => ["netease163", "netease126", "yeah"].includes(a.provider) && a.enabled)
    if (netease && netease.address && lowerTo.includes(netease.address.toLowerCase())) return netease
    const ms = accounts.find(a => a.provider === "microsoft" && a.enabled)
    if (ms && ms.address && lowerTo.includes(ms.address.toLowerCase())) return ms
  }

  // 3. 外部透传的明确 provider 兜底（如 webhook 或 provider 专属推送）
  if (provider) {
    let p = provider
    if (p === "netease") p = "netease163"
    const found = accounts.find(a => (a.provider === p || (p === "netease163" && (a.provider === "netease126" || a.provider === "yeah"))) && a.enabled)
    if (found) return found
  }

  // 兜底一下微软账号
  if (provider === "microsoft") {
    const found = accounts.find(a => a.provider === "microsoft" && a.enabled)
    if (found) return found
  }

  // 关键：绝对禁止使用 from（发件人）判定归属收件箱账号！发件人是 QQ 邮箱绝不代表该邮件属于 QQ 收件箱！

  // 兜底优先匹配 cloudmail
  const cmFallback = accounts.find(a => a.provider === "cloudmail" && a.enabled)
  if (cmFallback) return cmFallback

  return accounts.find(a => a.enabled) || accounts[0]
}

function MainView() {
  const initialAccounts = useMemo(() => loadAccounts(), [])
  const initialSnapshot = useMemo(() => loadMessageSnapshot(), [])
  const visibleAccounts = useMemo(() => initialAccounts.filter(account => !["qq", "netease163", "netease126", "yeah"].includes(account.provider) || imapGatewayConfigured()), [initialAccounts])
  const visibleSnapshot = useMemo(() => {
    const raw = initialSnapshot.filter(message => !["qq", "netease163", "netease126", "yeah"].includes(message.provider) || imapGatewayConfigured())
    // 全局幽灵占位符自愈清洗：若列表中某个真实邮件已经存在，则相同内容（主题/发件人/日期）的占位符或跨账号幽灵条目直接剔除并更新快照
    const realMessages = raw.filter(m => !m.isPlaceholder && !m.id.startsWith("notif-") && (!["qq", "netease163", "netease126", "yeah"].includes(m.provider) || m.id.includes(":")))
    const deduped = raw.filter(item => {
      const isSuspectGhost = item.isPlaceholder || item.id.startsWith("notif-") || (["qq", "netease163", "netease126", "yeah"].includes(item.provider) && !item.id.includes(":"))
      if (isSuspectGhost) {
        const hasReal = realMessages.some(real =>
          real.id !== item.id &&
          isMessageMatch(
            { id: real.id, subject: real.subject, from: real.from, date: real.date, preview: real.preview },
            item.id, item.subject, item.from, item.date, item.preview
          )
        )
        if (hasReal) return false
      }
      return true
    })
    if (deduped.length !== raw.length) {
      saveMessageSnapshot(deduped)
    }
    return deduped
  }, [initialSnapshot])

  // 首屏立即提取通知邮件（若有）并在第 0 毫秒呈现在列表顶端
  const initialNotifPayload = useMemo(() => {
    const query = Script.queryParameters as Record<string, any> | undefined
    const notifObj = (Notification as any)?.current || (Script as any).notificationInfo
    return parseNotificationPayload(query, notifObj)
  }, [])

  const initialMessagesList = useMemo(() => {
    let list = visibleAccounts.length ? visibleSnapshot : demoMessages
    if (initialNotifPayload) {
      lastNotificationHandledAt = Date.now()
    }
    return list
  }, [visibleAccounts, visibleSnapshot, initialNotifPayload])

  const [accounts, setAccounts] = useState(initialAccounts)
  const [messages, setMessages] = useState<MailMessage[]>(initialMessagesList)
  const [verificationToast, setVerificationToast] = useState<MailMessage | null>(null)
  const appLaunchTime = useMemo(() => Date.now(), [])
  const shownVerificationCodes = useRef(new Set<string>())
  const knownMessageIds = useMemo(() => new Set(initialMessagesList.map(message => `${message.accountId}:${message.id}`)), [initialMessagesList])

  // 验证码气泡在 8 秒后自动淡出消失，避免长期遮挡收件箱顶部
  useEffect(() => {
    if (!verificationToast) return
    const timer = setTimeout(() => {
      setVerificationToast(null)
    }, 8000)
    return () => clearTimeout(timer)
  }, [verificationToast])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [accountHasMore, setAccountHasMore] = useState<Record<string, boolean>>(() => Object.fromEntries(initialAccounts.map(account => [account.id, true])))
  const [syncVersion, setSyncVersion] = useState(0)
  const [searchText, setSearchText] = useState("")
  const [searchPresented, setSearchPresented] = useState(false)
  const [activeSearch, setActiveSearch] = useState("")
  const [status, setStatus] = useState(initialAccounts.length ? (initialSnapshot.length ? "正在后台更新" : "正在同步邮件") : "当前显示演示数据")
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null)
  const searchableMessages = useMemo(() => messages.map(message => ({
    message,
    text: [message.from, message.to, message.subject, message.preview, message.verificationCode]
      .filter(Boolean)
      .join("\n")
      .toLocaleLowerCase(),
  })), [messages])
  const filteredMessages = useMemo(() => {
    const list = activeSearch
      ? searchableMessages.filter(item => item.text.includes(activeSearch)).map(item => item.message)
      : messages
    return [...list].sort((a, b) => compareMessagesDescending(a, b))
  }, [messages, searchableMessages, activeSearch])

  useEffect(() => {
    const normalized = searchText.trim().toLocaleLowerCase()
    const timer = setTimeout(() => setActiveSearch(normalized), normalized ? 80 : 220)
    return () => clearTimeout(timer)
  }, [searchText])

  const applyIncomingMessages = (account: MailAccount, incoming: MailMessage[], resetAccount: boolean) => {
    // IMAP 返回的是完整正文；必须在进入列表的同一时刻落盘，不能等快照防抖保存。
    // 否则用户在通知回到收件箱后立刻点击，会再次触发一次远端正文请求。
    for (const message of incoming) {
      if (isMessageContentFull(message)) saveMessageContent(message)
    }
    // 关键：若有正打开的详情页处于占位等待状态，立即尝试从拉回来的 incoming 中匹配并广播刷新！
    broadcastRealMessageToDetail(incoming)
    const enabledIds = new Set((accounts.length ? accounts : loadAccounts()).map(item => item.id))
    setMessages(items => {
      // 找到本地所有的占位符，但如果是刚刚生成的（延长到 3 分钟以内），绝不能随便删，因为 IMAP 服务器可能还没把这封新信放进收件箱！
      const now = Date.now()
      const placeholderIdsToRemove = new Set(
        items.filter(item => item.isPlaceholder && (now - new Date(item.date).getTime() > 180000)).map(item => item.id)
      )
      
      const existing = (resetAccount ? [] : items.filter(item => item.accountId === account.id))
        .filter(item => {
          // 清除属于这个账号且已经超时的占位符，或被真实来信替代的通知条目（避免幽灵邮件和无法删除的副本）
          if (item.isPlaceholder || item.id.startsWith("notif-") || !item.id.includes(":")) {
             const matched = incoming.find(inc => isMessageMatch({ id: inc.id, subject: inc.subject, from: inc.from, date: inc.date, preview: inc.preview }, item.id, item.subject, item.from, item.date, item.preview))
             if (matched) return false
             if (item.isPlaceholder) return !placeholderIdsToRemove.has(item.id)
          }
          return true
        })
      // 关键：保留本地已读状态。如果用户已经在本地点开并标记已读，从服务器拉回来的副本绝不能把状态覆盖回未读蓝点！
      const existingReadIds = new Set(
        existing.filter(item => !item.unread).map(item => item.id)
      )
      const existingReadSignatures = new Set(
        existing.filter(item => !item.unread).map(item => `${item.subject}::${item.from}`)
      )
      const reconciledIncoming = incoming.map(item => {
        const isReadLocally = existingReadIds.has(item.id) || 
          existingReadSignatures.has(`${item.subject}::${item.from}`) ||
          pendingReadMessageKeys.has(`${item.accountId}:${item.id}`)
        return isReadLocally ? { ...item, unread: false } : item
      })

      const oldestIncomingTime = incoming.length
        ? Math.min(...incoming.map(item => messageTimestamp(item.date)))
        : Number.NEGATIVE_INFINITY
      const gmailHistory = existing.filter(item => messageTimestamp(item.date) < oldestIncomingTime)
      const accountItems = account.provider === "gmail"
        ? reconciledIncoming.length ? [...reconciledIncoming, ...gmailHistory] : existing
        : [...existing, ...reconciledIncoming]
      const unique = new Map(accountItems.map(item => [item.id, item]))
      // 对于其他账号的邮件，保留其全部既有真实邮件（绝不能因为账号ID差异或暂时停用就静默剔除已收邮件）
      const otherAccountItems = items.filter(item => {
        if (item.accountId === account.id) return false
        if (item.isPlaceholder || item.id.startsWith("notif-")) {
          if (placeholderIdsToRemove.has(item.id)) return false
          const matchedByIncoming = incoming.some(inc =>
            isMessageMatch({ id: inc.id, subject: inc.subject, from: inc.from, date: inc.date, preview: inc.preview }, item.id, item.subject, item.from, item.date, item.preview)
          )
          if (matchedByIncoming) return false
        }
        return true
      })
      const merged = [...otherAccountItems, ...unique.values()]
        .sort((a, b) => compareMessagesDescending(a, b))
      scheduleMessageSnapshot(merged)
      return merged
    })
  }

  async function syncSingleAccountFast(account: MailAccount) {
    try {
      const currentList = loadMessageSnapshot()
      const latest = currentList.filter(item => item.accountId === account.id && !item.isPlaceholder).sort((a, b) => compareMessagesDescending(a, b))[0]
      const result = await fetchAccountMessages(account, latest?.id)
      const incoming = result.messages.map(message => pendingReadMessageKeys.has(`${message.accountId}:${message.id}`) ? { ...message, unread: false } : message)
      const now = Date.now()
      const newVerificationMail = incoming
        .filter(message => {
          if (!message.verificationCode || !message.unread) return false
          if (knownMessageIds.has(`${message.accountId}:${message.id}`)) return false
          if (shownVerificationCodes.current.has(message.verificationCode)) return false
          const time = messageTimestamp(message.date)
          return (now - time) <= 10 * 60 * 1000 && time >= (appLaunchTime - 5 * 60 * 1000)
        })
        .sort((a, b) => compareMessagesDescending(a, b))[0]
      incoming.forEach(message => knownMessageIds.add(`${message.accountId}:${message.id}`))
      if (newVerificationMail?.verificationCode) {
        shownVerificationCodes.current.add(newVerificationMail.verificationCode)
        setVerificationToast(currentToast => !currentToast || messageTimestamp(newVerificationMail.date) > messageTimestamp(currentToast.date) ? newVerificationMail : currentToast)
      }
      applyIncomingMessages(account, incoming, result.resetAccount)
      return true
    } catch (error) {
      console.warn(`Targeted fast sync failed for ${account.name}:`, error)
      return false
    }
  }

  async function refresh(targetAccountId?: string) {
    if (inboxRefreshInFlight) return
    inboxRefreshInFlight = true
    const allEnabled = loadAccounts().filter(item => item.enabled && (item.provider !== "gmail" || isGmailAuthorized(item.id)) && (item.provider !== "microsoft" || isMicrosoftAuthorized(item.id)) && (!["qq", "netease163", "netease126", "yeah"].includes(item.provider) || imapGatewayConfigured()))
    setAccounts(allEnabled)
    if (!allEnabled.length) {
      setMessages(demoMessages)
      setStatus("当前显示演示数据")
      inboxRefreshInFlight = false
      return
    }
    const current = targetAccountId
      ? [...allEnabled.filter(a => a.id === targetAccountId), ...allEnabled.filter(a => a.id !== targetAccountId)]
      : allEnabled
    setLoading(true)
    setAccountHasMore(Object.fromEntries(allEnabled.map(account => [account.id, true])))
    if (messages.length) setStatus(targetAccountId ? "正在优先同步最新邮件…" : "正在后台更新")
    const accountsWithKnownMail = new Set(messages.map(message => message.accountId))
    const errors: string[] = []
    let completed = 0

    const syncAccount = async (account: MailAccount) => {
      try {
        const latest = messages.filter(item => item.accountId === account.id && !item.isPlaceholder).sort((a, b) => compareMessagesDescending(a, b))[0]
        const result = await fetchAccountMessages(account, latest?.id)
        const incoming = result.messages.map(message => pendingReadMessageKeys.has(`${message.accountId}:${message.id}`) ? { ...message, unread: false } : message)
        const now = Date.now()
        const newVerificationMail = accountsWithKnownMail.has(account.id)
          ? incoming
            .filter(message => {
              if (!message.verificationCode || !message.unread) return false
              if (knownMessageIds.has(`${message.accountId}:${message.id}`)) return false
              if (shownVerificationCodes.current.has(message.verificationCode)) return false
              const time = messageTimestamp(message.date)
              // 必须是 10 分钟以内的极其新鲜的未读验证码邮件，并且到达时间不得早于本次打开应用前 5 分钟
              return (now - time) <= 10 * 60 * 1000 && time >= (appLaunchTime - 5 * 60 * 1000)
            })
            .sort((a, b) => compareMessagesDescending(a, b))[0]
          : undefined
        incoming.forEach(message => knownMessageIds.add(`${message.accountId}:${message.id}`))
        if (newVerificationMail?.verificationCode) {
          shownVerificationCodes.current.add(newVerificationMail.verificationCode)
          setVerificationToast(currentToast => !currentToast || messageTimestamp(newVerificationMail.date) > messageTimestamp(currentToast.date) ? newVerificationMail : currentToast)
        }
        if (incoming.length > 0 || result.resetAccount) {
          applyIncomingMessages(account, incoming, result.resetAccount)
        }
      } catch (error) {
        errors.push(`${account.name}：${String((error as any)?.message ?? error)}`)
      } finally {
        completed += 1
        setStatus(`已同步 ${completed}/${current.length} 个账号`)
      }
    }

    if (targetAccountId) {
      const targetAccount = current.find(a => a.id === targetAccountId)
      const restAccounts = current.filter(a => a.id !== targetAccountId)
      
      const promises: Promise<void>[] = []
      if (targetAccount) promises.push(syncAccount(targetAccount))
      if (restAccounts.length) promises.push(...restAccounts.map(account => syncAccount(account)))
      
      await Promise.race([
        Promise.all(promises),
        new Promise<void>(resolve => setTimeout(resolve, 20000))
      ])
    } else {
      await Promise.race([
        Promise.all(current.map(account => syncAccount(account))),
        new Promise<void>(resolve => setTimeout(resolve, 20000))
      ])
    }
    setStatus(errors.length ? errors.join("；") : "同步完成")
    setLoading(false)
    inboxRefreshInFlight = false
    setSyncVersion(value => value + 1)
  }

  // 处理来自通知点击的启动参数或 onResume 事件
  async function handleNotificationTarget(params: {
    accountId?: string
    messageId?: string
    from?: string
    to?: string
    subject?: string
    preview?: string
    date?: string
    verificationCode?: string
    body?: string
    html?: string
    autoOpen?: boolean
    provider?: Provider
  }) {
    lastNotificationHandledAt = Date.now()
    if (!params.accountId && !params.messageId && !params.subject && !params.preview) return
    const allAccounts = accounts.length ? accounts : loadAccounts()
    const oldSnapshot = loadMessageSnapshot()

    // 关键防重检查：检查当前快照中是否已经存在一封真实邮件（无论属于哪个账号）与本次通知内容完全吻合！
    // 例如：用户用 QQ 邮箱发信给 Gmail，Gmail 已经同步回真实邮件，随后又收到转发通知；
    // 此时绝对不能新建任何占位符，而是直接复用已有真实邮件并清洗残留占位符！
    const alreadyExistingRealMsg = oldSnapshot.find(m =>
      !m.isPlaceholder &&
      !m.id.startsWith("notif-") &&
      isMessageMatch(
        { id: m.id, subject: m.subject, from: m.from, date: m.date, preview: m.preview },
        params.messageId,
        params.subject,
        params.from,
        params.date,
        params.preview
      )
    )

    if (alreadyExistingRealMsg) {
      // 真实邮件已经存在，清理所有匹配该邮件的残留占位符并更新快照
      const cleaned = oldSnapshot.filter(m =>
        m.id === alreadyExistingRealMsg.id ||
        !(
          (m.isPlaceholder || m.id.startsWith("notif-")) &&
          isMessageMatch(
            { id: m.id, subject: m.subject, from: m.from, date: m.date, preview: m.preview },
            alreadyExistingRealMsg.id,
            alreadyExistingRealMsg.subject,
            alreadyExistingRealMsg.from,
            alreadyExistingRealMsg.date,
            alreadyExistingRealMsg.preview
          )
        )
      )
      if (cleaned.length !== oldSnapshot.length) {
        saveMessageSnapshot(cleaned)
        setMessages(cleaned)
      }
      if (params.autoOpen !== false && !activeMessageId) {
        openMessage(alreadyExistingRealMsg)
      }
      return
    }

    const resolvedAccount = resolveNotificationAccount(params.accountId, params.from, params.to, allAccounts, params.provider)
    const targetAccountId = resolvedAccount?.id || params.accountId || allAccounts[0]?.id || "default"
    const targetMessageId = params.messageId || `notif-${Date.now()}`

    // 1. 如果有通知，我们为了能做到“瞬间跳转”，必须先强行往本地塞入一个“临时邮件”（占位符）
    // 这样接下来的 autoOpen 才能瞬间在本地找到它并跳进详情页。
    if (resolvedAccount) {
      const placeholderSubject = (!params.subject || params.subject === "无主题") ? "(无主题)" : params.subject
      const placeholderTo = (params.to && !params.to.includes("-push@") && !params.to.includes("122938.xyz") && !params.to.includes("workers.dev"))
        ? params.to
        : (resolvedAccount.address ? (resolvedAccount.address.includes("@") ? `${resolvedAccount.address.split("@")[0]} <${resolvedAccount.address}>` : resolvedAccount.address) : undefined)
      const placeholderMessage: MailMessage = {
        id: targetMessageId,
        accountId: resolvedAccount.id,
        provider: resolvedAccount.provider,
        from: params.from || "新邮件",
        to: placeholderTo,
        subject: placeholderSubject,
        preview: params.preview || params.body?.slice(0, 120) || "正在拉取正文内容…",
        body: params.body || params.preview || "",
        html: params.html || undefined,
        date: params.date || new Date().toISOString(),
        unread: true,
        isPlaceholder: !params.html,
        contentCached: Boolean(params.html),
        verificationCode: params.verificationCode
      }
      if (placeholderMessage.html) {
        saveMessageContent(placeholderMessage)
      }
      // 立刻强制更新内存里的当前快照，供随后的 setTimeout 能同步读到！
      const oldSnapshot = loadMessageSnapshot()
      const newSnapshot = [placeholderMessage, ...oldSnapshot.filter(m => m.id !== targetMessageId)].sort((a, b) => compareMessagesDescending(a, b))
      saveMessageSnapshot(newSnapshot)
      
      // 强行塞入当前列表渲染
      setMessages(newSnapshot)
      
      // 关键：在后台立刻启动针对该账号的极速同步，绝不阻塞！
      setTimeout(() => { refresh(resolvedAccount.id) }, 50)
    }

    // 2. 首屏只取目标邮件的完整正文；整箱同步不能阻塞详情页打开
    if (resolvedAccount) {
      setLoading(false)
      setStatus("")
      // 先用本地快照和正文缓存立即打开；只有本地确实没有完整正文时才访问服务器。
      void (async () => {
        try {
          const targetId = params.messageId || targetMessageId
          const cached = loadMessageSnapshot().find(item =>
            !item.isPlaceholder &&
            item.accountId === resolvedAccount.id &&
            isMessageMatch(
              { id: item.id, subject: item.subject, from: item.from, date: item.date, preview: item.preview },
              targetId, params.subject, params.from, params.date, params.preview,
            ),
          )
          const cachedFull = cached ? loadMessageContent(cached) : undefined
          if (cachedFull && isMessageContentFull(cachedFull)) {
            cachedFull.unread = false
            setMessages(items => items.map(item => item.id === targetMessageId ? cachedFull : item))
            broadcastRealMessageToDetail([cachedFull])
            if (params.autoOpen !== false && !activeMessageId) openMessage(cachedFull)
            return
          }

          const direct = await fetchSingleMessage(resolvedAccount, targetId, params.subject, params.from, params.date, params.preview, true)
          if (direct) {
            direct.unread = false
            saveMessageContent(direct)
            setMessages(items => {
              const merged = [...items.filter(item => !(
                item.accountId === resolvedAccount.id && (
                  item.id === direct.id ||
                  item.id === targetMessageId ||
                  isMessageMatch({ id: item.id, subject: item.subject, from: item.from, date: item.date, preview: item.preview }, direct.id, direct.subject, direct.from, direct.date, direct.preview)
                )
              )), direct]
              const sorted = merged.sort((a, b) => compareMessagesDescending(a, b))
              scheduleMessageSnapshot(sorted, 0)
              return sorted
            })
            broadcastRealMessageToDetail([direct])
            if (params.autoOpen !== false && !activeMessageId) openMessage(direct)
          }
        } finally {
          setLoading(false)
          setStatus("")
        }
      })()
    } else {
      setTimeout(() => refresh(), 100)
    }

    // 3. 如果要求 autoOpen，尝试立即从本地缓存中打开（优先打开完整邮件，若为占位符也秒开以便用户先看摘要并等待就地升级）
    if (params.autoOpen !== false) {
      // 不管三七二十一，直接同步找一下
      const currentList = loadMessageSnapshot()
      let msg = currentList.find(m => (params.messageId && m.id === params.messageId) || (params.subject && isMessageMatch({ id: m.id, subject: m.subject, from: m.from, date: m.date, preview: m.preview }, params.messageId, params.subject, params.from, params.date, params.preview)))
      // 增加兜底：如果是刚生成的占位符，如果没有任何可比对的条件才降级使用
      if (!msg && params.subject && params.from) msg = currentList.find(m => m.isPlaceholder && m.subject === params.subject && m.from === params.from)
      // 如果按主题匹配不到，找找刚刚塞入的任何属于该账号的占位符（只限于占位符找占位符）
      if (!msg) msg = currentList.find(m => m.isPlaceholder && m.accountId === resolvedAccount?.id && Math.abs(Date.now() - new Date(m.date).getTime()) < 15000)

      if (msg) {
        openMessage(msg)
      } else {
        // 如果同步没找到（由于极端并发），开个非常短的延迟再试一次
        setTimeout(() => {
          const freshList = loadMessageSnapshot()
          let msg2 = freshList.find(m => (params.messageId && m.id === params.messageId) || (params.subject && isMessageMatch({ id: m.id, subject: m.subject, from: m.from, date: m.date, preview: m.preview }, params.messageId, params.subject, params.from, params.date, params.preview)))
          if (!msg2 && params.subject && params.from) msg2 = freshList.find(m => m.isPlaceholder && m.subject === params.subject && m.from === params.from)
          if (!msg2) msg2 = freshList.find(m => m.isPlaceholder && m.accountId === resolvedAccount?.id && Math.abs(Date.now() - new Date(m.date).getTime()) < 5000)
          if (msg2) {
            openMessage(msg2)
          }
        }, 50)
      }
    }
  }

  useEffect(() => {
    // 监听冷启动通过 URL scheme / Notification 传入的参数
    const query = Script.queryParameters as Record<string, any> | undefined
    const notifObj = (Notification as any)?.current || (Script as any).notificationInfo
    const parsed = parseNotificationPayload(query, notifObj)

    if (parsed) {
      handleNotificationTarget({
        ...JSON.parse(JSON.stringify(parsed)),
        autoOpen: false, // 通知只进入收件箱，正文在后台预取
      })
      if (parsed.messageId) {
        try { (Notification as any).removeDelivereds([parsed.messageId]) } catch {}
      }
    }

    // 监听热启动（已打开或在后台时）点入通知
    let resumeListener: any
    if (typeof (Script as any).onResume === "function") {
      resumeListener = (Script as any).onResume((info: any) => {
        const resumeQuery = info?.queryParameters as Record<string, any> | undefined
        const resumeNotif = info?.notificationInfo || info?.notification
        const rParsed = parseNotificationPayload(resumeQuery, resumeNotif)
        if (rParsed) {
          handleNotificationTarget({
            ...JSON.parse(JSON.stringify(rParsed)),
            autoOpen: false, // 通知只进入收件箱，正文在后台预取
          })
          if (rParsed.messageId) {
            try { (Notification as any).removeDelivereds([rParsed.messageId]) } catch {}
          }
        }
      })
    }

    return () => {
      if (resumeListener && typeof resumeListener.remove === "function") {
        resumeListener.remove()
      }
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (accounts.length) {
      if (Date.now() - lastNotificationHandledAt >= 1500) {
        refresh()
      }
      return () => { cancelled = true }
    }
    setStatus("正在检查 iCloud 账号备份")
    restoreAccountsFromICloud(true).then(restored => {
      if (cancelled) return
      if (!restored.length) {
        setStatus("当前显示演示数据")
        return
      }
      setAccounts(restored)
      setMessages(loadMessageSnapshot().length ? loadMessageSnapshot() : [])
      setStatus(`已从 iCloud 恢复 ${restored.length} 个账号，正在同步邮件`)
      if (Date.now() - lastNotificationHandledAt >= 1500) {
        setTimeout(refresh, 0)
      }
    }).catch(error => {
      if (!cancelled) setStatus(`iCloud 自动恢复失败：${String((error as any)?.message ?? error)}`)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const handleScenePhase = (phase: "active" | "inactive" | "background") => {
      if (phase === "active") {
        if (Date.now() - lastNotificationHandledAt < 1000) return
        refresh()
      }
    }
    AppEvents.scenePhase.addListener(handleScenePhase)
    return () => AppEvents.scenePhase.removeListener(handleScenePhase)
  }, [accounts, messages])
  async function loadMore() {
    if (loading || loadingMore) return
    const current = loadAccounts().filter(item => item.enabled && (item.provider !== "gmail" || isGmailAuthorized(item.id)) && (item.provider !== "microsoft" || isMicrosoftAuthorized(item.id)) && (!["qq", "netease163", "netease126", "yeah"].includes(item.provider) || imapGatewayConfigured()) && accountHasMore[item.id] !== false)
    if (!current.length) return
    setLoadingMore(true)
    const nextHasMore = { ...accountHasMore }
    const errors: string[] = []
    
    // 恢复全局并发超时保护，因为云端即将更新为并发版
    await Promise.race([
      Promise.all(current.map(async account => {
        try {
          const oldest = messages.filter(item => item.accountId === account.id).sort((a, b) => compareMessagesAscending(a, b))[0]
          const result = await fetchOlderAccountMessages(account, oldest)
          nextHasMore[account.id] = result.hasMore
          if (result.messages.length) {
            setMessages(items => {
              const merged = [...items, ...result.messages]
              const unique = [...new Map(merged.map(item => [`${item.accountId}:${item.id}`, item])).values()]
                .sort((a, b) => compareMessagesDescending(a, b))
              scheduleMessageSnapshot(unique)
              return unique
            })
          }
        } catch (error) {
          nextHasMore[account.id] = true
          errors.push(`${account.name}：${String((error as any)?.message ?? error)}`)
        }
      })),
      new Promise<void>(resolve => setTimeout(resolve, 20000))
    ])
    
    setAccountHasMore(nextHasMore)
    if (errors.length) setStatus(errors.join("；"))
    setLoadingMore(false)
  }

  function copyVerificationCode() {
    if (!verificationToast?.verificationCode) return
    const code = verificationToast.verificationCode
    Pasteboard.setString(code)
    try { HapticFeedback.notificationSuccess() } catch {}
    setStatus(`验证码 ${code} 已复制到剪贴板`)
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
    try { (Notification as any).removeDelivereds([message.id]) } catch {}
    try {
      await deleteMessage(account, message.id)
    } catch (error) {
      const errorMsg = String((error as any)?.message ?? error)
      if (
        errorMsg.includes("404") ||
        errorMsg.toLowerCase().includes("not found") ||
        errorMsg.includes("HTTP 404") ||
        errorMsg.includes("邮件缓存已过期") ||
        errorMsg.includes("MAILBOX_CHANGED") ||
        errorMsg.includes("UID 无效") ||
        errorMsg.includes("超时") ||
        errorMsg.includes("Timeout")
      ) {
        // 保持本地删除状态，不强行恢复
        setStatus("邮件已在本地删除")
      } else {
        setMessages(items => {
          const restored = [...new Map([...items, message].map(item => [`${item.accountId}:${item.id}`, item])).values()]
            .sort((a, b) => compareMessagesDescending(a, b))
          scheduleMessageSnapshot(restored)
          return restored
        })
        if (errorMsg.includes("403") || errorMsg.includes("Insufficient Permission") || errorMsg.includes("401")) {
          setStatus("Gmail 权限不足：请在「管理邮箱账号」中重新登录以授予删除权限")
        } else {
          setStatus(`删除失败，邮件已恢复：${errorMsg}`)
        }
      }
    }
  }

  function openMessage(message: MailMessage) {
    if (activeMessageId) {
      // 避免重复打开，但如果是占位符替换成真实的，允许放行并更新 activeMessageId
      if (activeMessageId === message.id) return
      // 如果当前是无主题占位符，且新来的 message 是匹配的真实邮件，我们不阻拦它
    }
    setActiveMessageId(message.id) // 用原始 message.id 锁定，防止后面 fullMessage 变形导致解锁失败

    // 点击打开邮件的一瞬间，立即在本地状态中将该邮件标记为已读（蓝点瞬间消除，零等待！）
    if (message.unread) {
      const messageKey = `${message.accountId}:${message.id}`
      pendingReadMessageKeys.add(messageKey)
      setMessages(items => {
        const updated = items.map(item =>
          item.accountId === message.accountId && (
            item.id === message.id ||
            isMessageMatch({ id: item.id, subject: item.subject, from: item.from, date: item.date, preview: item.preview }, message.id, message.subject, message.from, message.date, message.preview)
          ) ? { ...item, unread: false } : item
        )
        scheduleMessageSnapshot(updated)
        return updated
      })
    }

    let fullMessage = loadMessageContent(message)
    const accountId = fullMessage.accountId
    const messageId = fullMessage.id

    // 只要当前邮件还是临时通知对象或缺少完整 html，立刻从本地真实快照中检索是否已有后台同步拉回的完整邮件！
    const needsRealResolution = fullMessage.isPlaceholder || fullMessage.id.startsWith("notif-") || !fullMessage.html
    if (needsRealResolution) {
      try {
        const currentSnapshot = loadMessageSnapshot()
        // 去掉 messages 里的假占位符和临时通知干扰，直接到真实快照里找
        const candidates = currentSnapshot.filter(m => !m.isPlaceholder && !m.id.startsWith("notif-"))
        const realOne = candidates.find(item =>
          item.accountId === fullMessage.accountId &&
          (
            item.id === fullMessage.id ||
            isMessageMatch(
              { id: item.id, subject: item.subject, from: item.from, date: item.date, preview: item.preview },
              fullMessage.id,
              fullMessage.subject,
              fullMessage.from,
              fullMessage.date,
              fullMessage.preview
            )
          )
        )
        // 防抖：必须时间差不能太大，而且不能是被删除过的
        if (realOne) {
          const tTime = new Date(fullMessage.date || "").getTime()
          const cTime = new Date(realOne.date || "").getTime()
          if (!Number.isFinite(tTime) || !Number.isFinite(cTime) || Math.abs(tTime - cTime) < 24 * 3600 * 1000) {
            const loadedReal = loadMessageContent(realOne)
            if (loadedReal.html || (loadedReal.body && loadedReal.body.length >= (fullMessage.body?.length || 0))) {
              fullMessage = loadedReal
            }
          }
        }
      } catch {}
    }

    if (fullMessage.verificationCode !== message.verificationCode) {
      setMessages(items => {
        const updated = items.map(item => item.accountId === accountId && item.id === messageId ? { ...item, verificationCode: fullMessage.verificationCode } : item)
        scheduleMessageSnapshot(updated)
        return updated
      })
    }
    const targetAccount = accounts.find(item => item.id === accountId) || loadAccounts().find(item => item.id === accountId)
    Navigation.present(
      <NavigationStack>
        <MessageDetail
          message={fullMessage}
          account={targetAccount}
          onMessageUpdated={updated => setMessages(items => {
            const list = items.map(item =>
              item.accountId === accountId && (
                item.id === messageId ||
                item.id === updated.id ||
                isMessageMatch({ id: item.id, subject: item.subject, from: item.from, date: item.date, preview: item.preview }, messageId, message.subject, message.from, message.date, message.preview)
              ) ? updated : item
            )
            scheduleMessageSnapshot(list)
            return list
          })}
          onRead={() => setMessages(items => {
            const updated = items.map(item =>
              item.accountId === accountId && (
                item.id === messageId ||
                isMessageMatch({ id: item.id, subject: item.subject, from: item.from, date: item.date, preview: item.preview }, messageId, message.subject, message.from, message.date, message.preview)
              ) ? { ...item, unread: false } : item
            )
            // 修改这里：让列表立刻按状态刷新排序，未读蓝点消失后通常在列表中位置不变，但需要确保 React 渲染出无蓝点状态
            scheduleMessageSnapshot(updated)
            return [...updated]
          })}
          onReadFailed={error => {
            const errorMsg = String((error as any)?.message ?? error)
            // 绝不因为网络抖动、缓存过期或服务器暂时无响应而把已读邮件重新恢复为蓝点！
            if (errorMsg.includes("403") || errorMsg.includes("Insufficient Permission") || errorMsg.includes("401")) {
              setStatus("Gmail 权限不足：请在「管理邮箱账号」中重新登录以授予读取/修改权限")
            }
          }}
          onDeleted={() => setMessages(items => {
            const updated = items.filter(item => item.accountId !== accountId || item.id !== messageId)
            scheduleMessageSnapshot(updated)
            return updated
          })}
          onDeleteFailed={error => {
            const errorMsg = String((error as any)?.message ?? error)
            if (
              errorMsg.includes("404") ||
              errorMsg.toLowerCase().includes("not found") ||
              errorMsg.includes("HTTP 404") ||
              errorMsg.includes("邮件缓存已过期") ||
              errorMsg.includes("MAILBOX_CHANGED") ||
              errorMsg.includes("UID 无效") ||
              errorMsg.includes("超时") ||
              errorMsg.includes("Timeout")
            ) {
              return
            }
            setMessages(items => {
              const restored = [...new Map([...items, message].map(item => [`${item.accountId}:${item.id}`, item])).values()]
                .sort((a, b) => compareMessagesDescending(a, b))
              scheduleMessageSnapshot(restored)
              return restored
            })
            if (errorMsg.includes("403") || errorMsg.includes("Insufficient Permission") || errorMsg.includes("401")) {
              setStatus("Gmail 权限不足：请在「管理邮箱账号」中重新登录以授予删除权限")
            } else {
              setStatus(`删除失败，邮件已恢复：${errorMsg}`)
            }
          }}
          onClose={() => setActiveMessageId(null)}
        />
      </NavigationStack>,
    ).catch(console.error)
  }

  return (
    <NavigationStack>
      <List navigationTitle="收件箱" refreshable={refresh} searchable={{ value: searchText, onChanged: setSearchText, prompt: "搜索发件人、主题或正文", presented: { value: searchPresented, onChanged: setSearchPresented } }} searchToolbarBehavior="minimize" toolbar={{
        topBarLeading: <Button title="账号" systemImage="person.crop.circle" action={() => Navigation.present(<NavigationStack><AccountsView onChanged={refresh} /></NavigationStack>)} />,
        topBarTrailing: <Button title="刷新" systemImage="arrow.clockwise" action={refresh} disabled={loading} />,
      }} overlay={verificationToast ? {
        alignment: "top",
        content: <HStack
          spacing={8}
          alignment="center"
          padding={{ horizontal: 18, vertical: 10 }}
          glassEffect={{ glass: UIGlass.clear().tint("rgba(126,92,255,0.12)").interactive(), shape: { type: "rect", cornerRadius: 28, style: "continuous" } }}
          glassEffectTransition="materialize"
          shadow={{ color: "rgba(91,112,255,0.20)", radius: 24, y: 9 }}
          offset={{ x: 0, y: 12 }}
        >
          <Button
            action={copyVerificationCode}
            buttonStyle="plain"
          >
            <VStack alignment="center" spacing={2}>
              <Text font="caption2" foregroundStyle="secondaryLabel">最新验证码 · 点击复制</Text>
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
            </VStack>
          </Button>
          <Button
            action={() => setVerificationToast(null)}
            buttonStyle="plain"
            padding={{ leading: 6 }}
          >
            <Image systemName="xmark.circle.fill" foregroundStyle="tertiaryLabel" font="subheadline" />
          </Button>
        </HStack>,
      } : activeSearch && filteredMessages.length === 0 ? <ContentUnavailableView title="未找到邮件" systemImage="magnifyingglass" description="尝试其他发件人、主题或关键词" /> : !loading && messages.length === 0 ? <ContentUnavailableView title="暂无邮件" systemImage="tray" description="下拉刷新或检查账号配置" /> : undefined}>
        <Section footer={activeSearch ? <Text>找到 {filteredMessages.length} 封邮件</Text> : loadingMore ? undefined : <Text>{status}</Text>}>
          {loading && messages.length === 0 ? <HStack><ProgressView /><Text foregroundStyle="secondaryLabel">正在同步邮件</Text></HStack> : null}
          {filteredMessages.map(message => (
            <Button
              key={`${message.accountId}-${message.id}`}
              action={() => openMessage(message)}
              buttonStyle="plain"
              frame={{ maxWidth: "infinity" }}
              contentShape={{ kind: "interaction", shape: "rect" }}
              trailingSwipeActions={["cloudmail", "gmail", "microsoft", "qq", "netease163", "netease126", "yeah"].includes(message.provider) ? {
                allowsFullSwipe: true,
                actions: [<Button title={message.provider === "gmail" ? "垃圾箱" : "删除"} systemImage="trash" role="destructive" action={() => removeFromInbox(message)} />],
              } : undefined}
            >
              <HStack alignment="top" spacing={8} padding={{ vertical: 1 }} frame={{ maxWidth: "infinity" }}>
                <VStack spacing={3} frame={{ width: 18 }}>
                  <Image systemName={providerIcon(message.provider)} foregroundStyle={providerColor(message.provider)} font="caption" />
                  {message.unread ? <Image systemName="circle.fill" foregroundStyle="systemBlue" font="caption2" /> : null}
                </VStack>
                <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity" }}>
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
          {!activeSearch && syncVersion > 0 && Object.values(accountHasMore).some(Boolean) ? (
            <HStack
              key={`load-older-${syncVersion}-${messages[messages.length - 1]?.accountId || "empty"}-${messages[messages.length - 1]?.id || "empty"}`}
              spacing={8}
              frame={{ maxWidth: "infinity" }}
              padding={{ vertical: 12 }}
              onAppear={() => {
                if (!loading && !loadingMore) loadMore()
              }}
            >
              {loadingMore ? <ProgressView /> : null}
              <Text font="caption" foregroundStyle="secondaryLabel">{loadingMore ? "正在加载更早邮件" : "继续加载更早邮件"}</Text>
            </HStack>
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
