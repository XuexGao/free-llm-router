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
export function cliCommonHeaders(input: { uid: string; machineId: string; sessionId: string }): HeaderMap {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: 'https://www.codebuddy.cn',
    Referer: 'https://www.codebuddy.cn/',
    'User-Agent': cliUserAgent(),
    'X-CodeBuddy-Request': '1',
    'Accept-Language': 'zh-CN',
    'X-Machine-ID': input.machineId,
    'X-Session-ID': input.sessionId,
  }
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
}): HeaderMap {
  const headers: HeaderMap = {
    ...cliCommonHeaders(input),
    Accept: 'application/json, text/event-stream',
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Version': CLIENT_VERSION,
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
