/**
 * 四套客户端指纹头族（**纯函数**，不碰网络、不碰存储）。
 *
 * ## 为什么这个模块必须是纯函数
 *
 * AGENTS.md §5 的分层纪律：Go 侧这些是纯 map 构造，最适合用单测锁死形状。
 * 上游改判据时**只改这一部分**，执行逻辑不动。
 *
 * ## 四套指纹的由来（AGENTS.md §6.1）
 *
 * 任务计分都走 `POST /v2/report`，但**不同任务认不同客户端指纹**：
 *
 * | 指纹 | Base | 判别性字段 |
 * |---|---|---|
 * | CLI | `www.codebuddy.cn` | `agentName:"default"`, `agentType:"conversation"`, `mode:"craft"` |
 * | 桌面 | `copilot.tencent.com` | `ideName/ideType:"WorkBuddy"`, `extName:"workbuddy-desktop"` |
 * | Web | `www.workbuddy.cn` | `x-client-platform: web`, `pageURL`/`elementId` |
 * | mp | `www.codebuddy.cn` | `ideType:"WorkBuddy_MP"`, `platform:"mini_program"` |
 */

/**
 * 客户端版本号（写进 UA 与 `X-IDE-Version`）。
 *
 * ## ⚠️ 为什么从 `5.5.4` 改成 `5.5.6`（实测依据）
 *
 * 原值 5.5.4 是照抄 Go 侧 `headers.go:61-67` 的**默认值**，而那个默认值是**旧的**：
 *
 * 1. AGENTS.md §6.1 记录的**桌面端实测 UA** 是 `WorkBuddy/5.5.6`；
 * 2. 本仓库自己的 `realtime.ts:222` 在**同一个端点**
 *    （`/v2/chat/completions`）上写的是 `'X-IDE-Version': '5.5.6'`
 *    —— 同一个仓库里两个版本号本身就是不一致。
 *
 * ⚠️ 版本号是上游判定**渠道是否被认可**的输入之一（`11128
 * "Illegal API invocation from an unapproved channel"`）。
 * 旧版本可能被划入「不认可的渠道」，而这与账号本身是否有效**无关**。
 *
 * ⚠️ 这里**不编造**更新的版本号：只对齐到**本仓库内已有依据**的那个值
 * （桌面端实测 + realtime 一致）。若上游继续升版，应重新实测后再改。
 */
export const CLIENT_VERSION = '5.5.6'
export const CLI_VERSION = '2.137.1'
/** 桌面端实测 UA（`desktop.go:43`）。 */
export const DESKTOP_VERSION = '5.5.6'
export const DESKTOP_CLI_VERSION = '2.137.1'

/** CN CLI 三段式 UA（`headers.go:61-67`）。 */
export function cliUserAgent(): string {
  return `WorkBuddy/${CLIENT_VERSION} WorkBuddy/${CLIENT_VERSION} CLI/${CLI_VERSION}`
}

/**
 * **国际版**（workbuddy.ai）的三段式 UA。
 *
 * ## 🔴 与国内版的差别只在中间那段：`WorkBuddy AI`
 *
 * ```
 * 国内版: WorkBuddy/5.5.2 WorkBuddy/5.5.2    CLI/5.5.2
 * 国际版: WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2
 *                         ^^^^^^^^^^^ 多了 " AI"
 * ```
 *
 * ⚠️ 这不是装饰：**上游据此判定「渠道是否被认可」**，用错形态会回
 * `11128 Illegal API invocation from an unapproved channel`
 *（而 `displayMsg` 把它**伪装成「安全策略拦截」**，极易误判成账号被封）。
 *
 * 依据：参考实现 `src/product.ts:70` 的 `WORKBUDDY_UA_INTL`
 *（`deepseek-harness-codearts`）。
 */
export function cliUserAgentIntl(): string {
  // ⚠️ **三段都用国际版自己的版本号 5.5.2**（与 `X-IDE-Version` 一致）。
  //
  // 参考实现逐字是 `WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2`
  //（`product.ts:70`），三段**同值**。
  // 我一度写成 `WorkBuddy/5.5.6 … CLI/2.137.1`（混了国内版段），
  // 那与 `X-IDE-Version: 5.5.2` **自相矛盾** —— 同一请求里两个版本号，
  // 正是「渠道指纹」最容易露馅的地方。
  return `WorkBuddy/${CLIENT_VERSION_INTL} WorkBuddy AI/${CLIENT_VERSION_INTL} CLI/${CLIENT_VERSION_INTL}`
}

/**
 * **国内版**（CodeBuddy，`copilot.tencent.com`）的 UA。
 *
 * ## 🔴 与国际版是**完全不同的格式**（实测缺陷：我一度把国际版的值套到国内版）
 *
 * ```
 * 国内版: CodeBuddyIDE/1.106.1
 * 国际版: WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2
 * ```
 *
 * ⚠️ 国内版**不是**三段式、也**不含 `WorkBuddy`** —— 它是 IDE 客户端的形态。
 * 依据：参考实现 `src/product.ts:309` / `src/buddy.ts:89` 的
 * `userAgent: 'CodeBuddyIDE/1.106.1'`。
 *
 * ⚠️ 三个归属头（`X-IDE-Name` / `X-IDE-Type` / `X-Product`）在国内版也要发
 * **`CodeBuddy`**（`product.ts:311` 的 `attributionName`），不是 `WorkBuddy`。
 * 发错会让后台「使用端」归因错误（参考实现对此有专门注释：
 * 早年误发 `SaaS` 导致后台归因不到产品）。
 */
export const CODEBUDDY_USER_AGENT = 'CodeBuddyIDE/1.106.1'

/** 国内版的客户端版本号（`X-IDE-Version`）。 */
export const CODEBUDDY_CLIENT_VERSION = '1.106.1'

/**
 * 国际版的客户端版本号。
 *
 * ⚠️ 参考实现国际版用 **5.5.2**（`src/product.ts:484`），而国内版 CodeBuddy 用
 * `clientVersion: '1.106.1'` / `cliVersion: '2.137.1'`。
 * 我们此前对两个变体都用同一组国内版版本号 —— 那也是渠道指纹不匹配的来源之一。
 */
export const CLIENT_VERSION_INTL = '5.5.2'

/** 桌面端 UA（`desktop.go:43`）。 */
export function desktopUserAgent(): string {
  return `WorkBuddy/${DESKTOP_VERSION} WorkBuddy/${DESKTOP_VERSION} CLI/${DESKTOP_CLI_VERSION}`
}

/** billing 域的单段 UA（`headers.go:88`）。 */
export function billingUserAgent(): string {
  return `WorkBuddy/${CLIENT_VERSION}`
}

/** Web 域的 Chrome UA（Go 侧 web 事件用）。 */
export function webUserAgent(): string {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`
}

/**
 * 由 uid **稳定派生**一个 36 位 hex 设备标识。
 *
 * `deriveID(uid, salt) = sha256(salt + ":" + uid)` 取前 18 字节 → 36 hex
 * （`desktop.go:51-53`）。**同账号恒同值** —— 模拟固定设备，避免每次请求
 * 都像一台新机器（那本身就是风控信号）。
 *
 * @param salt `machine` / `session` / `webmachine` 等，不同用途用不同 salt。
 */
export async function deriveDeviceId(uid: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${uid}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  // 取前 18 字节 → 36 个 hex 字符
  const bytes = new Uint8Array(digest).subarray(0, 18)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** mp 指纹的 machineId 是**硬编码常量**（Go 侧 `school.go:113-116`）。 */
export const MP_MACHINE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f901234'

/** 外观/主题任务用的固定资源键（Go 侧实测 `theme-tkmw7j`）。 */
export const APPEARANCE_THEME_KEY = 'theme-tkmw7j'

/** 请求头集合（普通对象，便于单测断言与 JSON 序列化）。 */
export type HeaderMap = Record<string, string>

/**
 * CN CLI 通用头（`internal/upstream/headers.go:147-172` 的 `CommonHeaders`）。
 *
 * ⚠️ `X-CodeBuddy-Request: 1` 是**官方客户端风控闸门头，所有 API 请求必带**
 * （Go 侧记为 D1）。少了它上游可能判定为非官方客户端。
 */
export function cliCommonHeaders(input: {
  uid: string
  machineId: string
  sessionId: string
  /**
   * 该请求属于哪个变体（默认国内版 buddy）。
   *
   * ⚠️ **必须按变体切换**（实测缺陷）：国际版端点
   *（`www.workbuddy.ai`）与国内版（`copilot.tencent.com`）**要求不同的渠道指纹**。
   * 用国内版指纹打国际版端点会回
   * `11128 unapproved channel`（伪装成「安全策略拦截」）。
   *
   * ## 参考实现的对照（`deepseek-harness-codearts/src/product.ts`）
   *
   * | 项 | 国内版 CodeBuddy | 国际版 WorkBuddy |
   * |---|---|---|
   * | `apiDomain`/`X-Domain` | `copilot.tencent.com` | `www.workbuddy.ai` |
   * | `productCode`/`X-Product-Code` | `codebuddy` | `workbuddy` |
   * | UA 中段 | `WorkBuddy` | **`WorkBuddy AI`** |
   * | `clientVersion` | `1.106.1` | `5.5.2` |
   */
  variant?: 'buddy' | 'workbuddy'
}): HeaderMap {
  const intl = input.variant === 'workbuddy'
  // ⚠️ `X-Domain` 必须与**实际请求的端点**一致，否则身份与目的地址自相矛盾 ——
  // 参考实现对此有明确注释（`buddy-adapter.ts:1958-1966`）。
  const domain = intl ? 'www.workbuddy.ai' : 'copilot.tencent.com'
  const webOrigin = intl ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn'
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: webOrigin,
    Referer: `${webOrigin}/`,
    // ⚠️ UA 按变体切换（中段 `WorkBuddy AI` 只在国际版出现）
    'User-Agent': intl ? cliUserAgentIntl() : cliUserAgent(),
    'X-CodeBuddy-Request': '1',
    'Accept-Language': 'zh-CN',
    'X-Machine-ID': input.machineId,
    'X-Session-ID': input.sessionId,
    // ⚠️ 以下三个头**原先完全缺失**（实测缺陷），而参考实现必发：
    // 它们共同构成「渠道归属」指纹。
    'X-Domain': domain,
    'X-Product-Code': intl ? 'workbuddy' : 'codebuddy',
  }
}

/**
 * **参考实现口径**的 chat 出站头（`deepseek-harness-codearts`）。
 *
 * ## ⚠️ 为什么需要它与 `cliChatHeaders` 并存（实测对比的结论）
 *
 * 用户报「在 DSH 用参考插件几乎没失败过，而你这里问题一堆」。
 * 逐行对比后发现**两套头的差异很大**：
 *
 * | 头 | 参考实现（不失败） | 我们原先（11128） |
 * |---|---|---|
 * | `Accept` | **`text/event-stream`** | `application/json, text/event-stream` |
 * | `X-Domain` | ✅ `www.workbuddy.ai` | ❌ 缺失 |
 * | `X-Product-Code` | ✅ `workbuddy` | ❌ 缺失 |
 * | `Origin`/`Referer` | ❌ **不发** | ✅ 发（国内域名） |
 * | `X-Requested-With` / `X-CodeBuddy-Request` | ❌ 不发 | ✅ 发 |
 * | `X-Machine-ID` / `X-Session-ID` | ❌ 不发 | ✅ 发 |
 * | `X-Conversation-Request-ID` 等 4 个 | ❌ 不发 | ✅ 发 |
 *
 * 参考实现只发 **11 个**头（`buddy-adapter.ts:1950-1982`）。
 * 我们那批多余的头来自 **Go 侧的实现**（`internal/upstream/headers.go`），
 * 而那套口径在国际版端点上**不被认可** ⇒ `11128 unapproved channel`。
 *
 * ⇒ 这里按**参考实现逐字对齐**：只发它发的那些。
 *
 * @param input 与 `cliChatHeaders` 相同的输入（保留形参以便将来切换）
 */
export function referenceChatHeaders(input: {
  uid: string
  accessToken: string
  variant?: 'buddy' | 'workbuddy'
}): HeaderMap {
  const intl = input.variant === 'workbuddy'
  const headers: HeaderMap = {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    // ⚠️ 与端点一致（参考实现 `buddy-adapter.ts:1969`）
    'X-Domain': intl ? 'www.workbuddy.ai' : 'copilot.tencent.com',
    'X-Product-Code': intl ? 'workbuddy' : 'codebuddy',
    'X-Agent-Purpose': 'conversation',
    // ⚠️ **归属名按变体切换**：国内版是 `CodeBuddy`，国际版是 `WorkBuddy`
    //（参考实现 `product.ts:311` 的 `attributionName`）。
    // 发错会让后台「使用端」归因错误。
    'X-IDE-Name': intl ? 'WorkBuddy' : 'CodeBuddy',
    'X-IDE-Type': intl ? 'WorkBuddy' : 'CodeBuddy',
    'X-IDE-Version': intl ? CLIENT_VERSION_INTL : CODEBUDDY_CLIENT_VERSION,
    'X-Product': intl ? 'WorkBuddy' : 'CodeBuddy',
    // ⚠️ UA 是**完全不同的格式**（不是同一个模板换段）：
    // 国内版 `CodeBuddyIDE/1.106.1`，国际版 `WorkBuddy/… WorkBuddy AI/…`。
    'User-Agent': intl ? cliUserAgentIntl() : CODEBUDDY_USER_AGENT,
  }
  if (input.accessToken !== '') headers.Authorization = `Bearer ${input.accessToken}`
  return headers
}

/** chat 出站头：在 common 之上加鉴权与会话头族（`headers.go:198-268`）。 */
export function cliChatHeaders(input: {
  uid: string
  machineId: string
  sessionId: string
  accessToken: string
  /** `X-Conversation-Request-ID`：轮级聚合主键，**必发**。 */
  conversationRequestId: string
  /** `X-Conversation-ID`：入站透传值，空则不发（不伪造）。 */
  conversationId?: string
  /** 变体（见 `cliCommonHeaders` 的说明）。默认国内版。 */
  variant?: 'buddy' | 'workbuddy'
}): HeaderMap {
  const headers: HeaderMap = {
    ...cliCommonHeaders(input),
    // ⚠️ **必须精确是 `text/event-stream`**（实测缺陷）。
    //
    // 我们此前发的是 `application/json, text/event-stream`（多一个 json 偏好），
    // 而参考实现逐字发 `text/event-stream`（`buddy-adapter.ts:1954`）。
    //
    // ⚠️ 上游会把它当作**渠道指纹**的一部分 —— 对不上就回
    // `11128 Illegal API invocation from an unapproved channel`
    //（伪装成「安全策略拦截」）。这类「多一个字符就不认」的判据在本项目里
    // 出现过多次（如 UA 中段的 ` AI`），故**逐字对齐参考实现**。
    Accept: 'text/event-stream',
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Version': input.variant === 'workbuddy' ? CLIENT_VERSION_INTL : CLIENT_VERSION,
    // ⚠️ `X-Product` 发的是**产品归属名**，不是部署类型 `SaaS`。
    // Go 侧 `product.ts:113-118` 记录过：早年误发 `SaaS` 导致后台归因不到产品。
    'X-Product': 'WorkBuddy',
    // 轮级聚合主键 + 消息级 id
    'X-Conversation-Request-ID': input.conversationRequestId,
    'X-Conversation-Message-ID': randomHex32(),
    'X-Root-Request-ID': input.conversationRequestId,
    'X-Trace-ID': input.conversationRequestId,
  }

  if (input.accessToken !== '') {
    headers.Authorization = `Bearer ${input.accessToken}`
    headers['X-User-Id'] = input.uid
  } else {
    // 缺省字段用 X-No-* 约定（与官方 CLI 一致）
    headers['X-No-Authorization'] = '1'
    headers['X-No-User-Id'] = '1'
  }

  // ⚠️ 只有非空才发：空串会让上游误判为「显式要求空会话」
  if (input.conversationId !== undefined && input.conversationId !== '') {
    headers['X-Conversation-ID'] = input.conversationId
  }

  return headers
}

/**
 * billing 域头（`headers.go:375-400`）—— 签到/余额/CLI 活跃上报用。
 *
 * ⚠️ 与 chat 头的差异：**没有 `X-IDE-*` 归因头**，UA 是单段式。
 * Go 侧记录过「billing 单段 UA 形态」是并发修复的一部分。
 */
export function billingHeaders(input: { uid: string; accessToken: string }): HeaderMap {
  const headers: HeaderMap = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: 'https://www.codebuddy.cn',
    Referer: 'https://www.codebuddy.cn/',
    'User-Agent': billingUserAgent(),
    'X-CodeBuddy-Request': '1',
    'Accept-Language': 'zh-CN',
    'X-Domain': 'www.codebuddy.cn',
    'X-Product': 'SaaS',
  }
  if (input.accessToken !== '') {
    headers.Authorization = `Bearer ${input.accessToken}`
    headers['X-User-Id'] = input.uid
  }
  return headers
}

/**
 * 桌面指纹头（`desktop.go`，用于 `RichMeow_Chat` / 模板 / 画布 / 专家类任务）。
 *
 * ⚠️ 关键差异：`X-Product: SaaS`（**不是** WorkBuddy）。桌面端上报认这个值。
 */
export function desktopHeaders(input: { uid: string; accessToken: string }): HeaderMap {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: 'https://copilot.tencent.com',
    Referer: 'https://copilot.tencent.com/',
    'User-Agent': desktopUserAgent(),
    'X-CodeBuddy-Request': '1',
    'X-Domain': 'copilot.tencent.com',
    'X-Product': 'SaaS',
    'X-User-Id': input.uid,
    'X-No-Enterprise-Id': '1',
    ...(input.accessToken === '' ? {} : { Authorization: `Bearer ${input.accessToken}` }),
  }
}

/**
 * Web 指纹头（`desktop.go:266-294`，用于任务领奖与 `Library_read`）。
 *
 * ⚠️ `x-client-platform: web` 是**领奖权威路径的必需头**
 * （`internal/upstream/tasks.go:228-254`）。
 */
export function webHeaders(input: { uid: string; accessToken: string }): HeaderMap {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'x-client-platform': 'web',
    Origin: 'https://www.workbuddy.cn',
    Referer: 'https://www.workbuddy.cn/',
    'User-Agent': webUserAgent(),
    'X-User-Id': input.uid,
    ...(input.accessToken === '' ? {} : { Authorization: `Bearer ${input.accessToken}` }),
  }
}

/**
 * mp 小程序指纹头（`school.go:62-79`，用于 `Sequential_Tasks_*` 与 `school_season`）。
 *
 * ⚠️ 这些任务**只在 mp 口径下下发**，默认列表不可见。
 */
export function mpHeaders(input: { uid: string; accessToken: string }): HeaderMap {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: 'https://www.codebuddy.cn',
    Referer: 'https://www.codebuddy.cn/',
    'X-Client-Platform': 'mp-weixin',
    'X-Platform': 'wechatmp',
    'X-Client-Product': 'workbuddy-mp',
    'X-User-Id': input.uid,
    ...(input.accessToken === '' ? {} : { Authorization: `Bearer ${input.accessToken}` }),
  }
}

/** 生成 32 位 hex（消息级 ID）。 */
export function randomHex32(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** 生成 UUID v4（`crypto.randomUUID` 在 Workers 可用）。 */
export function randomUuid(): string {
  return crypto.randomUUID()
}
