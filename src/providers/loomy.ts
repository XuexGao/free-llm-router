/**
 * Loomy（讯飞办公助手）供应商适配器。
 *
 * ## 协议速览
 *
 * | 用途 | 端点 | 认证 |
 * |---|---|---|
 * | 对话 | `POST {apiBase}/chat/completions` | `Authorization: Bearer` |
 * | 模型目录 | `GET {apiBase}/models` | 小写 `token` 头 |
 * | 余额（只读） | `GET {apiBase}/points/records` | 小写 `token` 头 |
 * | 签到（写） | `POST {apiBase}/points/first-login` | 小写 `token` 头 |
 * | 登录（短信/绑定手机） | `POST {accountBase}/login/...` | **HMAC-SHA1 签名** |
 *
 * ## 三个必须记住的坑（逐条来自实测）
 *
 * 1. **两套认证头**：chat 端点只认 `Authorization: Bearer`，业务端点只认小写
 *    `token`；带错的那个会得到 **HTTP 200** + `{"code":"100002","desc":"缺少 token"}`
 *    （`deepseek-harness-codearts/src/loomy.ts:210-213`）。故 `loomyChatHeaders`
 *    两个都发（`:220-229`），`loomyBusinessHeaders` 只发 `token`。
 * 2. **业务失败恒返回 HTTP 200**，成败只能读 body 的 `code`
 *    （`src/loomy.ts:83-85`）。只看状态码会把「登录已失效」误判成成功 ——
 *    这正是本文件在 chat 路径上要额外 peek 一次 JSON 体的原因。
 * 3. **没有 refresh 端点**：`session` 是登录时声明 14 天得来的，过期只能重新登录
 *    （`src/loomy.ts:196-205`）。故 `extras.refreshable` 恒为 `false` ——
 *    这是**诚实标记**，不是遗漏。⇒ 本适配器**不实现** `refresh()`
 *    （见文件中「刻意不实现 refresh()」一节）。
 *
 * ## 登录为什么可以在 Workers 上跑
 *
 * 微信扫码走**纯 HTTP 长轮询**（`src/loomy-wechat.ts:11-29`）：
 * 拉授权页 → 正则提取 uuid → 长轮询 `long.open.weixin.qq.com/connect/l/qrconnect`
 * 拿到 `code`。官方那条 404 回调页**完全不参与**（它只是微信域名白名单的占位）。
 * 短信登录同样是三个 POST。⇒ **不需要 `127.0.0.1` 监听**，Workers 上可行。
 * ⚠️ 参考项目里那个 `createServer` 只是**承载二维码 HTML 页**的展示壳
 *    （`src/loomy-wechat-login.ts:161-175`）；在 Workers 里这一页应当由本服务
 *    自己的面板渲染，而不是由供应商适配器起服务器。
 */

import {
  ProviderError,
  type CheckinResult,
  type ChatRequest,
  type Provider,
  type ProviderBalance,
  type ProviderCredential,
  type ProviderModel,
} from './types.js'
import { md5Base64, md5Hex } from './md5.js'

// ── 协议常量 ────────────────────────────────────────────────────────

/** 业务基址（推理 / 模型列表 / 积分）。 */
export const LOOMY_API_BASE = 'https://loomyad.xunfei.cn/api/v1'

/** 讯飞账号（CAccount）基址 —— 仅登录用。 */
export const LOOMY_ACCOUNT_BASE = 'https://account.xfinfr.com'

/** 业务成功码。 */
export const LOOMY_OK_CODE = '000000'

/**
 * 登录失效码。
 *
 * ⚠️ 收到它**不得重试**：重试只会用同一份死凭据再打一次上游。
 * 正确处置是标记凭据失效并提示重新登录。
 */
export const LOOMY_AUTH_ERROR_CODE = '100002'

/** 参数错误码（如未知 task key）。 */
export const LOOMY_BAD_REQUEST_CODE = '100001'

/** 请求超时（毫秒）。与 Loomy 客户端一致（`src/loomy.ts:45`）。 */
export const LOOMY_REQUEST_TIMEOUT_MS = 60_000

/**
 * 登录会话有效期（秒）= 14 天。
 *
 * 依据 `account-service.js:391` 的 `expire: 14 * 24 * 3600`
 * （`src/loomy-oauth.ts:39`）。⚠️ 这只是向服务端**声明**的有效期，
 * 响应里不带到期时间戳，故凭据的 `expiresAt` 由本地按此推算。
 */
export const LOOMY_SESSION_TTL_SECONDS = 1_209_600

/** 短信验证码有效期（秒）。 */
export const LOOMY_SMS_CODE_TTL_SECONDS = 300

/**
 * 讯飞账号 AccessKey。
 *
 * ⚠️ 与参考项目同值（`src/loomy-product.ts:124-126`，取自客户端 `.env.prod`）。
 * 它**只**用于讯飞账号端点（`account.xfinfr.com`）的 HMAC-SHA1 签名，
 * 与业务/推理端点（用的是用户登录后的 `session`）无关，
 * 故它不构成任何用户数据的泄露面。
 */
export const LOOMY_ACCESS_KEY_ID = '2thryby66wxi53sk'
/** 讯飞账号 AccessKeySecret（HMAC-SHA1 的密钥）。 */
export const LOOMY_ACCESS_KEY_SECRET = 'zsak6eadrbawz683wf5r3m2snrwj868r'
/** 讯飞 appId（账号请求体 `base.appid`）。 */
export const LOOMY_APP_ID = 'GM3LOOMY'

/** 微信开放平台「网站应用」AppID（客户端 `.env.prod` 的 `LOOMY_WECHAT_APP_ID`）。 */
export const LOOMY_WECHAT_APP_ID = 'wx18d60be432287cf8'

/**
 * 微信授权回调地址。
 *
 * ⚠️ **必须是这个官方地址**：微信校验 `redirect_uri` 域名白名单，
 * 换成任意其它域名会得到「redirect_uri 参数错误」（`src/loomy-wechat.ts:24-29`）。
 * 它实测返回 **404**，但链路**不需要**它可达 —— `code` 是从长轮询拿的。
 */
export const LOOMY_WECHAT_REDIRECT_URI = 'https://loomy.xunfei.cn/oauth/wechat/callback'

/** 微信长轮询超时（毫秒）。微信侧约 25 秒无状态变化才返回，故给足余量。 */
export const LOOMY_WECHAT_POLL_TIMEOUT_MS = 40_000

/**
 * 微信扫码长轮询状态。
 *
 * ⚠️ **语义以微信授权页内嵌 JS（`switch(window.wx_errcode)`）为准**，那是官方源码：
 * `405` = 已确认（`wx_code` 就在这一帧）、`404` = 已扫码待确认、`408` = 待扫码、
 * `403` = 用户取消、`402` = 二维码失效。
 *
 * ⚠️ **真实缺陷（用户报障「扫码后显示已扫码，但没有后续跳转」）**：
 * 早期把 **404 当「已确认」、405 当「待确认」，恰好读反**
 * （`src/loomy-wechat.ts:64-70`）—— 于是确认后仍在等一个「带 code 的 404」，
 * 永远等不到。
 */
export const LOOMY_WECHAT_POLL_STATUS = Object.freeze({
  waiting: 'waiting',
  scanned: 'scanned',
  confirmed: 'confirmed',
  cancelled: 'cancelled',
  expired: 'expired',
  error: 'error',
} as const)

/** 扫码请求统一带的浏览器 UA（微信对空 UA / 爬虫 UA 可能拒绝）。 */
const WECHAT_UA
  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ── 请求头（两套认证，见文件头第 1 条） ──────────────────────────────

/**
 * 业务端点请求头（`/models`、`/points/*`）。
 *
 * ⚠️ 这些端点**只认小写 `token` 头**，带 `Authorization: Bearer` 会被判
 * 「缺少 token」（`src/loomy.ts:207-215`）。故这里**刻意不加** Authorization。
 */
export function loomyBusinessHeaders(token: string): Record<string, string> {
  return { Accept: 'application/json', token }
}

/**
 * chat 端点请求头。
 *
 * ⚠️ **两个头都发**：`/chat/completions` 只认 `Authorization: Bearer`，
 * 但官方客户端在 session 模式下也是两个都发（`src/loomy.ts:217-231`），
 * 保持一致可避免上游将来改判据。
 * ⚠️ `Bearer ` 前缀**必需**：实测无前缀同样回 `100002 缺少 token`。
 */
export function loomyChatHeaders(token: string): Record<string, string> {
  return {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    token,
  }
}

// ── 讯飞账号（CAccount）HMAC-SHA1 签名 ──────────────────────────────

/** 签名所需参数。 */
export interface LoomySignOptions {
  method: string
  path: string
  queryParams?: Record<string, string>
  /** **已序列化**的请求体字符串（与发送时用的必须是同一个）。 */
  body?: string
  contentType?: string
}

/** RFC3986 转义（`encodeURIComponent` + 补转 `! ' ( ) *`）。依据 `sign.js:23-42`。 */
function escapeRfc3986(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
}

/**
 * 构建 ESCAPED_PATH（`sign.js:47-58`）：补前导 `/`、剥末尾 `/`（长度 > 1 时）、
 * 按 `/` 切段后逐段转义再拼回。
 */
function buildEscapedPath(rawPath: string): string {
  let clean = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  if (clean.length > 1 && clean.endsWith('/')) clean = clean.slice(0, -1)
  return clean.split('/').map((seg) => (seg.length > 0 ? escapeRfc3986(seg) : '')).join('/')
}

/**
 * 构建 ESCAPED_QUERY_STRING（`sign.js:63-79`）：`key=value` 用 `&` 连接，
 * **不排序**（保持传入顺序），两者都转义。
 */
function buildEscapedQueryString(queryParams: Record<string, string> | undefined): string {
  if (queryParams === undefined) return ''
  const entries = Object.entries(queryParams)
  if (entries.length === 0) return ''
  return entries.map(([key, value]) => `${escapeRfc3986(key)}=${escapeRfc3986(String(value))}`).join('&')
}

/**
 * 计算 `Content-MD5`（base64）。
 *
 * ⚠️ 空 body 返回**空串**而**不是**空串的 md5 —— 与客户端 `sign.js:13-18` 一致
 * （`src/loomy-sign.ts:35-43`）。
 * ⚠️ WebCrypto 没有 MD5，故用本项目的 `md5.ts`（纯 TS，已用 RFC 1321 向量锁死）。
 */
export function loomyContentMd5(body: string): string {
  if (body.length === 0) return ''
  return md5Base64(new TextEncoder().encode(body))
}

/**
 * 构建待签名字符串（9 段，`\n` 连接）。
 *
 * ```
 * {METHOD}\n{ESCAPED_PATH}\n{ESCAPED_QUERY}\n{Content-MD5}\n
 * {Content-Type}\n{Date}\n{Nonce}\n{SignedHeaders}\n{CanonicalizedHeaders}
 * ```
 *
 * ⚠️ 后两段**恒为空串**（我们不发任何 `x-*` 头），故最终字符串**以两个换行结尾**。
 * 这是 `join('\n')` 在 9 个元素上的自然结果，**不要「顺手」去掉尾随换行** ——
 * 去掉会让签名不匹配（`src/loomy-sign.ts:102-116`）。
 */
export function buildLoomySigningString(
  options: LoomySignOptions & { date: string; nonce: string },
): string {
  const contentType = options.contentType ?? ''
  return [
    options.method.toUpperCase(),
    buildEscapedPath(options.path),
    buildEscapedQueryString(options.queryParams),
    loomyContentMd5(options.body ?? ''),
    contentType,
    options.date,
    options.nonce,
    '',
    '',
  ].join('\n')
}

/** 字节 → Base64（不依赖 `Buffer`，只用 Web 标准 `btoa`）。 */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * 生成完整的讯飞账号请求头。
 *
 * `Date` 用 UTC 字符串、`Nonce` 用 UUID（与客户端 `sign.js:207-208` 一致）。
 *
 * ⚠️ **返回的 `body` 必须与签名时的 `options.body` 是同一个字符串**：
 * 调用方应先把 body `JSON.stringify` 一次，签名与发送共用该字符串 ——
 * 二次序列化会改变字节（键序/空格），签名随即失效
 * （`src/loomy-sign.ts:124-127`）。
 *
 * ⚠️ 认证头前缀是 **`account {ak}:{sig}`**，**不是** `Bearer`
 * （`src/loomy-sign.ts:135,139`）。
 *
 * ## 为什么是 async
 *
 * HMAC-SHA1 走 WebCrypto（`crypto.subtle.sign`），它是异步 API。
 * 这是**唯一**能在 Workers 里做 HMAC 的途径（`node:crypto` 不可用）。
 */
export async function loomyAuthHeaders(
  options: LoomySignOptions & { accessKeyId?: string; accessKeySecret?: string },
): Promise<Record<string, string>> {
  const date = new Date().toUTCString()
  const nonce = crypto.randomUUID()
  const contentType = options.contentType ?? 'application/json'
  const body = options.body ?? ''

  const stringToSign = buildLoomySigningString({ ...options, contentType, body, date, nonce })
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(options.accessKeySecret ?? LOOMY_ACCESS_KEY_SECRET),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(stringToSign))

  const headers: Record<string, string> = {
    Authorization: `account ${options.accessKeyId ?? LOOMY_ACCESS_KEY_ID}:${toBase64(new Uint8Array(signature))}`,
    Date: date,
    Nonce: nonce,
    'Content-Type': contentType,
  }
  const md5 = loomyContentMd5(body)
  if (md5.length > 0) headers['Content-MD5'] = md5
  return headers
}

// ── 业务信封 ────────────────────────────────────────────────────────

/** 业务响应信封。 */
export interface LoomyEnvelope<T> {
  ok: boolean
  code: string
  message: string
  data: T | undefined
}

/**
 * 解析 Loomy 的业务信封。
 *
 * ⚠️ Loomy 的业务失败**恒返回 HTTP 200**，成败只能读 body 的 `code`
 * （`src/loomy.ts:80-85`）。只看状态码会把「登录已失效」误判成成功。
 */
export function parseLoomyEnvelope<T>(payload: unknown): LoomyEnvelope<T> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, code: '', message: '响应不是 JSON 对象', data: undefined }
  }
  const record = payload as Record<string, unknown>
  const code = typeof record.code === 'string' ? record.code : ''
  const message = typeof record.desc === 'string' && record.desc.length > 0
    ? record.desc
    : (typeof record.message === 'string' ? record.message : '')
  if (code !== LOOMY_OK_CODE) {
    return {
      ok: false,
      code,
      message: message.length > 0 ? message : `业务错误 ${code || '(缺少 code)'}`,
      data: undefined,
    }
  }
  return { ok: true, code, message, data: record.data as T }
}

/** 把 `code` 映射成可读的失败说明（含「该怎么办」）。 */
function describeLoomyCode(code: string, message: string): string {
  if (code === LOOMY_AUTH_ERROR_CODE) {
    return `登录已失效（${code}${message === '' ? '' : ` ${message}`}）：Loomy 没有续期端点，请重新登录`
  }
  return message.length > 0 ? `上游业务错误 ${code}：${message}` : `上游业务错误 ${code}`
}

/**
 * 发一次业务请求，返回**原始解析后的 JSON**（不拆信封）。
 *
 * ⚠️ 与 {@link loomyBusinessRequest} 分开是必要的：模型目录的解析函数
 * {@link parseLoomyModels} 要能同时认「业务信封」与「裸数组」两种形状，
 * 而那只有在拿到原始 body 时才判断得了。若先拆一次信封再传进去，
 * 「裸数组」那条兜底分支就成了**永不执行的死代码** ——
 * 上游换壳时会得到一个静默的空目录（`listModels` 会因此报「目录为空」，
 * 但真正的原因是解析器的兜底分支根本没被走到）。
 *
 * @throws {ProviderError} 网络失败或响应不是 JSON。
 */
async function loomyBusinessRaw(
  credential: ProviderCredential,
  path: string,
  init: { method: string; body?: string },
  signal: AbortSignal,
): Promise<unknown> {
  const headers: Record<string, string> = loomyBusinessHeaders(credential.accessToken)
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'

  let response: Response
  try {
    response = await fetch(`${LOOMY_API_BASE}${path}`, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      // ⚠️ 用调用方的 signal 优先（客户端断开即取消），但叠加一个超时上限：
      // 上游偶发挂住时不能让 Worker 一直占着连接。
      signal: AbortSignal.any([signal, AbortSignal.timeout(LOOMY_REQUEST_TIMEOUT_MS)]),
    })
  } catch (error) {
    throw new ProviderError({
      provider: 'loomy',
      message: `请求 Loomy 失败（${path}）：${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    })
  }

  try {
    return await response.json()
  } catch {
    throw new ProviderError({
      provider: 'loomy',
      httpStatus: response.status,
      message: `Loomy 响应不是 JSON（${path}，HTTP ${response.status}）`,
      retryable: response.status === 429 || response.status === 402,
    })
  }
}

/**
 * 发一次业务请求并拆信封。
 *
 * @throws {ProviderError} 网络失败、非 2xx、业务码非 `000000`。
 */
async function loomyBusinessRequest<T>(
  credential: ProviderCredential,
  path: string,
  init: { method: string; body?: string },
  signal: AbortSignal,
): Promise<T> {
  const parsed = await loomyBusinessRaw(credential, path, init, signal)
  const envelope = parseLoomyEnvelope<T>(parsed)
  if (!envelope.ok) {
    throw new ProviderError({
      provider: 'loomy',
      message: `Loomy ${path} 失败：${describeLoomyCode(envelope.code, envelope.message)}`,
      // ⚠️ 业务码层面的失败**不换号**：它是请求/会话本身的问题
      // （如 `100002` 登录失效 —— 换号由 `shouldRotate` 单独判定）。
      retryable: false,
    })
  }
  return envelope.data as T
}

// ── 凭据解析 ────────────────────────────────────────────────────────

/** 从任意形状里读字符串（camelCase / snake_case 都认）。 */
function pickString(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

/** 读毫秒时间戳（接受数字或数字字符串）；非法返回 0（= 未知）。 */
function pickTimestamp(source: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const raw = source[key]
    const value = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN)
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}

/** 32 位小写 hex —— 讯飞 `session` 的固定形态（18 位 `userid` 的判别特征同源）。 */
const LOOMY_USERID_HINT = /^\d{15,20}$/
/** 32 位小写 hex（讯飞 session）。 */
const LOOMY_SESSION_HINT = /^[0-9a-f]{32}$/
/** 11 位大陆手机号。 */
const LOOMY_PHONE_HINT = /^1\d{10}$/

/**
 * 解析 Loomy 凭据。
 *
 * ## 认得的形状（宽容）
 *
 * 扁平 / 嵌套 `{auth:{...}}` / 数组首项 都认；camelCase 与 snake_case 都认
 * （DSH 的 `.credentials.yaml` 用 `user_id` / `access_token`）。
 *
 * ## 判别性（严格）
 *
 * ⚠️ 必须能把它和别家区分开，否则 `parseCredentialAnywhere` 的「逐家试」
 * 会把别家的凭据认成 Loomy（或反之）。故要求**同时**满足：
 *
 * 1. 有 token 字段（`access_token` / `accessToken` / `session` / `token`）；
 * 2. **且** 命中 Loomy 的判别特征之一 —— token 是 32 位小写 hex（讯飞 session）、
 *    有 15–20 位数字 `userid`、或有 11 位手机号。
 *
 * 第 2 条不是洁癖：只看「有 access_token」会把 Raccoon 的 JWT 凭据也吞下来。
 *
 * ## uid 的口径（**这里必须无歧义**）
 *
 * `uid` 会被用作 DO 存储的 key，**必须对同一账号恒为同一个值**。
 *
 * - 有 `userid` → 直接用（18 位数字串，讯飞侧稳定）；
 * - 否则 → **从 token 确定性派生** `loomy-<sha256(userid|token) 前 16 hex>`。
 *   ⚠️ 不能直接拿 token 当 uid：它是 32 位 hex，虽然稳定，
 *   但把凭据本体写进存储 key 会让「日志/面板展示 uid」这条路径泄漏凭据。
 *   派生值是单向的，且同一 token 恒得同一 uid。
 * ⚠️ **绝不用手机号当唯一 uid** —— 同一手机号可以对应多个讯飞账号，
 *   那会把两个账号合并成一条记录。
 */
/**
 * 判定一份**原始凭据对象**是否具备 Loomy 的判别特征。
 *
 * ⚠️ **必须与 `parseCredential` 共用这一个函数**，不能各写一份 ——
 * 两处判据一旦分叉，就会出现「`matchesShape` 说是我、`parseCredential` 说不是」
 * 这种自相矛盾的组合，而症状是「自动识别选中了 Loomy，导入却报错」。
 *
 * 判据（见 `parseCredential` 的注释）：有 token 字段，**且**满足
 * 「32 位 hex session / 15–20 位 userid / 11 位手机号」之一。
 *
 * @param input 任意原始输入（可以是整个导入对象）。
 */
export function looksLikeLoomyCredential(input: unknown): boolean {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false
  let source = input as Record<string, unknown>
  // ⚠️ 与 `parseCredential` 同样先展开嵌套包装层（否则嵌套形永远判不出来）。
  for (const wrapper of ['credential', 'credentials', 'auth']) {
    const inner = source[wrapper]
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
      source = { ...source, ...(inner as Record<string, unknown>) }
      break
    }
  }
  const accessToken = pickString(source, 'access_token', 'accessToken', 'session', 'token')
  if (accessToken === '') return false
  const userid = pickString(source, 'userid', 'user_id', 'userId')
  const phone = pickString(source, 'phone', 'mobile', 'phone_number')
  return LOOMY_SESSION_HINT.test(accessToken)
    || LOOMY_USERID_HINT.test(userid)
    || LOOMY_PHONE_HINT.test(phone)
}

function parseCredential(input: unknown): ProviderCredential {
  const fail = (message: string): never => {
    throw new ProviderError({ provider: 'loomy', message })
  }

  if (input === null || typeof input !== 'object') {
    fail('Loomy 凭据必须是一个 JSON 对象')
  }
  const root = Array.isArray(input) ? input[0] : input
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    fail('Loomy 凭据必须是一个 JSON 对象（不能是空数组）')
  }
  let source = root as Record<string, unknown>
  // 嵌套形：`{ auth: {...}, account: {...} }`（DSH 插件就是这一形态）
  for (const wrapper of ['credential', 'credentials', 'auth']) {
    const inner = source[wrapper]
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
      // ⚠️ 内层**优先**，外层只作兜底（`{...outer, ...inner}` 的顺序不能反）
      source = { ...source, ...(inner as Record<string, unknown>) }
      break
    }
  }

  const accessToken = pickString(source, 'access_token', 'accessToken', 'session', 'token')
  if (accessToken === '') {
    fail('缺少访问令牌：请提供 Loomy 的 `access_token`（讯飞 session）字段')
  }

  const userid = pickString(source, 'userid', 'user_id', 'userId')
  const phone = pickString(source, 'phone', 'mobile', 'phone_number')
  // ⚠️ 判据**复用** `looksLikeLoomyCredential`（与 `matchesShape` 同一份），
  // 避免两处判据分叉 —— 那会导致「自动识别选中了 Loomy，导入却报错」。
  if (!looksLikeLoomyCredential(source)) {
    fail(
      '这不像是 Loomy 凭据：`access_token` 不是 32 位十六进制的讯飞 session，'
      + '且没有 15–20 位 `userid` 或 11 位手机号可用于识别账号。'
      + '请在面板粘贴 Loomy 登录后的凭据。',
    )
  }

  const nickname = pickString(source, 'nickname', 'name', 'user_name')
  const expiresAt = pickTimestamp(source, 'expires_at', 'expiresAt')

  // ⚠️ uid 必须稳定且不泄漏凭据（见上方注释）
  //
  // ⚠️ `hasUserid` 原先是在上面算 `looksLikeLoomy` 时顺带得到的局部变量；
  // 改用共享判据 `looksLikeLoomyCredential` 后它不再存在，故这里**重新算一次**
  //（`LOOMY_USERID_HINT` 是纯正则，重新测一次没有成本，且口径完全一致）。
  const hasUserid = LOOMY_USERID_HINT.test(userid)
  const uid = hasUserid ? userid : deriveLoomyUid(accessToken, phone)

  return {
    provider: 'loomy',
    uid,
    accessToken,
    // ⚠️ Loomy 没有 refresh 端点（`src/loomy.ts:196-205`），恒为空串
    refreshToken: '',
    expiresAt,
    nickname: nickname === '' ? (phone !== '' ? `Loomy ${phone}` : `Loomy ${userid || uid}`) : nickname,
    extras: {
      ...(phone === '' ? {} : { phone }),
      ...(userid === '' ? {} : { userid }),
      // 诚实标记：供面板显示「凭证过期，请重新登录」而不是假装能续期
      refreshable: 'false',
    },
  }
}

/**
 * 从 token（与手机号，若提供）确定性派生一个**不含凭据本体**的 uid。
 *
 * ⚠️ **必须同步**：`Provider.parseCredential` 的签名是同步的，故这里用
 * 本项目的纯 TS MD5（`md5.ts`）而不是 `crypto.subtle.digest`（异步）。
 * MD5 在这里只做「确定性短标识」，不是安全边界 —— uid 本身不是秘密，
 * 我们只需要它**单向**（不能从 uid 反推 token）且**稳定**。
 *
 * 取 16 个 hex 字符（64 bit）—— 对「一个人的几个账号」这个规模，
 * 碰撞概率可以忽略。
 */
function deriveLoomyUid(accessToken: string, phone: string): string {
  const digest = md5Hex(new TextEncoder().encode(`${phone}\u0000${accessToken}`))
  return `loomy-${digest.slice(0, 16)}`
}

// ── 模型目录 ────────────────────────────────────────────────────────

/**
 * 从展示名抽出倍率。
 *
 * ## 为什么要抽（这是显示层的硬需求）
 *
 * Loomy 的倍率**没有独立字段**，就写在 `name` 字符串末尾的括号里
 * （实测搜 `credit`/`multiplier`/`price`/`factor`/`rate` 全部 0 命中），
 * 且三种括号风格混用（`src/loomy.ts:16-18`）：
 * `MiniMax M3 （x4.0）` / `Qwen 3.8 Max (x12.0)` / `GLM 5.3 Flash(x0.8)`。
 *
 * 本函数**幂等**：`splitLoomyRate(loomyDisplayName(x))` 与 `splitLoomyRate(x)`
 * 结果一致（`src/loomy.ts:106-124`），故重复规范化不会累积 ` · `。
 */
export function splitLoomyRate(rawName: string): { name: string; rate: string } {
  const original = typeof rawName === 'string' ? rawName.trim() : ''
  if (original.length === 0) return { name: '', rate: '' }

  // 形态 1：末尾括号（全角/半角都认）
  const bracketed = original.match(/^(.*?)\s*[（(]\s*(x\s*[\d.]+)\s*[)）]\s*$/i)
  if (bracketed !== null) {
    const name = String(bracketed[1] ?? '').trim()
    const rate = String(bracketed[2] ?? '').replace(/\s+/g, '').toLowerCase()
    if (name.length > 0) return { name, rate }
    return { name: original, rate: '' }
  }
  // 形态 2：已规范化的 `{name} · x1.0`
  const normalized = original.match(/^(.*?)\s*·\s*(x\s*[\d.]+)\s*$/i)
  if (normalized !== null) {
    const name = String(normalized[1] ?? '').trim()
    const rate = String(normalized[2] ?? '').replace(/\s+/g, '').toLowerCase()
    if (name.length > 0) return { name, rate }
  }
  return { name: original, rate: '' }
}

/**
 * 最终展示名：`MiniMax M3 · x4.0`。
 *
 * ⚠️ 倍率必须拼进 `name`（**不是** `description`）：模型切换菜单只渲染 `name`，
 * `description` 仅用于详情弹窗（`src/loomy.ts:150-156`）。
 * 无倍率时不追加分隔符，避免出现「模型名 · 」这种孤立分隔符。
 */
export function loomyDisplayName(rawName: string): string {
  const { name, rate } = splitLoomyRate(rawName)
  return rate.length > 0 ? `${name} · ${rate}` : name
}

/**
 * 是否为可对话的 chat 模型。
 *
 * ⚠️ 判据是 `type === 'chat'`。**不要**改用 `input_modalities` ——
 * 实测 5 个 chat 模型的输入模态含 `image`（能看图），那是输入多模态，
 * 与「是不是生图模型」无关（`src/loomy.ts:162-174`）。
 */
export function isLoomyChatModel(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
  const record = entry as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  return id.length > 0 && record.type === 'chat'
}

/** 把 `capabilities.input_modalities` 读成小写字符串数组。 */
function readInputModalities(entry: Record<string, unknown>): string[] {
  const capabilities = entry.capabilities
  if (typeof capabilities !== 'object' || capabilities === null) return []
  const raw = (capabilities as Record<string, unknown>).input_modalities
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase())
}

/**
 * 把远端 `GET /models` 的响应解析成统一模型目录。
 *
 * ⚠️ 响应是业务信封 `{code:'000000', data:[...]}`，但也兼容裸数组 ——
 * 上游换壳时不必改代码。
 */
export function parseLoomyModels(payload: unknown): ProviderModel[] {
  const envelope = parseLoomyEnvelope<unknown>(payload)
  const list = envelope.ok
    ? (Array.isArray(envelope.data) ? envelope.data : [])
    : (Array.isArray(payload) ? payload : [])

  const models: ProviderModel[] = []
  for (const item of list) {
    if (!isLoomyChatModel(item)) continue
    const entry = item as Record<string, unknown>
    const id = String(entry.id)
    const rawName = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id
    const contextWindow = Number(entry.context_length)
    models.push({
      id,
      name: loomyDisplayName(rawName),
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0,
      // Loomy 的目录里没有「单次输出上限」字段 ⇒ 如实给 0（未知），
      // 编造数值会让客户端算出错误的预算。
      maxOutput: 0,
      supportsImage: readInputModalities(entry).includes('image'),
      // ⚠️ 恒 false：Loomy 没有「免费模型」概念，只有**倍率**
      //（`GLM 5.3 Flash · x0.8` 是便宜，不是免费）。编造 isFree 会误导面板。
      isFree: false,
    })
  }
  return models
}

/**
 * 拉取模型目录。
 *
 * ⚠️ 用 **raw**（不拆信封）而不是 `loomyBusinessRequest`：`parseLoomyModels`
 * 要能同时认「业务信封」与「裸数组」两种形状，拆过一道它就只看得到一种了。
 * 代价是这里必须**自己**把信封层的失败报出来 —— 否则一份 `100002 登录失效`
 * 会被 `parseLoomyModels` 解析成空数组，最终报成「目录为空」，
 * 用户看到的原因与真实原因毫无关系。
 */
async function listModels(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderModel[]> {
  const payload = await loomyBusinessRaw(credential, '/models', { method: 'GET' }, signal)

  // 形态 ①：业务信封 —— 失败必须在这里就抛（带上业务码与原文）
  const envelope = parseLoomyEnvelope<unknown>(payload)
  const isEnvelope = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    && typeof (payload as Record<string, unknown>).code === 'string'
  if (isEnvelope && !envelope.ok) {
    throw new ProviderError({
      provider: 'loomy',
      message: `Loomy 模型目录失败：${describeLoomyCode(envelope.code, envelope.message)}`,
    })
  }

  const models = parseLoomyModels(payload)
  if (models.length === 0) {
    // ⚠️ 空目录必须显式失败，不能返回空数组「冒充成功」——
    // 那会让面板显示「该账号没有模型」，而真实原因可能是上游改了响应形状。
    throw new ProviderError({
      provider: 'loomy',
      message: 'Loomy 模型目录为空：上游响应形状可能已变化（期望 data[] 且条目 type === "chat"）',
    })
  }
  return models
}

// ── 对话 ────────────────────────────────────────────────────────────

/**
 * 准备出站请求体。
 *
 * ⚠️ **网关传给供应商的是「未清洗」的原始 body**：`handleChatCompletions`
 * 里的 `prepareChatBody`（WorkBuddy 专用的 4 处必改）**只用于 WorkBuddy 那条
 * 路径**，非默认供应商拿到的是 `rawBody`。故这一层必须自己补：
 *
 * 1. `model` 必须换成**去掉 `provider/` 前缀**后的值 —— body 里那份还带着前缀，
 *    原样发上游会 404 / 回落到默认模型；
 * 2. `stream` 必须为 `true` —— 本网关只做流式透传，非流式请求会破坏下游的
 *    SSE 转换假设。
 *
 * 另外做一次**工具配对清理**（`gateway/payload.ts` 的纯函数）：
 * 孤儿 `tool` 消息会让上游对之后每条消息都返 400，而客户端在中断/重试时
 * 很容易产生它们。这是 OpenAI 规范层面的合法性修复，与供应商无关。
 */
export function prepareLoomyBody(body: Record<string, unknown>, model: string): string {
  const out: Record<string, unknown> = { ...body, model, stream: true }
  if (Array.isArray(out.messages)) {
    out.messages = cleanupToolPairing(out.messages)
  }
  return JSON.stringify(out)
}

/**
 * 清理孤儿 `tool` 消息与不完整 `tool_calls`（与 `gateway/payload.ts` 同实现）。
 *
 * 在这里内联一份而不是 import 网关的模块：供应商层**只依赖 `types.ts`**
 * 能让「这层能否跑在 Workers 上」一眼可见（`types.ts:21-27` 的移植纪律）。
 * 逻辑本身是 OpenAI 规范的最小修复，很短。
 */
function cleanupToolPairing(messages: unknown[]): unknown[] {
  const declared = new Set<string>()
  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') continue
    const msg = raw as Record<string, unknown>
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue
    for (const call of msg.tool_calls) {
      if (call === null || typeof call !== 'object') continue
      const id = (call as Record<string, unknown>).id
      if (typeof id === 'string' && id !== '') declared.add(id)
    }
  }

  const out: unknown[] = []
  let changed = false
  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') {
      out.push(raw)
      continue
    }
    const msg = raw as Record<string, unknown>
    if (msg.role === 'tool') {
      const id = msg.tool_call_id
      if (typeof id !== 'string' || id === '' || !declared.has(id)) {
        changed = true
        continue
      }
    }
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      const kept = (msg.tool_calls as unknown[]).filter((call) => {
        if (call === null || typeof call !== 'object') return false
        const fn = (call as Record<string, unknown>).function
        if (fn === null || typeof fn !== 'object') return false
        const name = (fn as Record<string, unknown>).name
        // 名称为空的 tool_call 会让整条会话报废（且上游不指出是哪个字段）
        return typeof name === 'string' && name !== ''
      })
      if (kept.length !== msg.tool_calls.length) {
        changed = true
        if (kept.length === 0) delete msg.tool_calls
        else msg.tool_calls = kept
      }
    }
    out.push(msg)
  }
  return changed ? out : messages
}

/**
 * 从非 SSE 响应体里抽取业务错误。
 *
 * @returns 可读错误说明；不是错误时返回 `undefined`。
 */
function readLoomyErrorBody(text: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>

  // OpenAI 风格错误体
  const error = record.error
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  // Loomy 业务信封
  const code = record.code
  if (typeof code === 'string' && code !== LOOMY_OK_CODE) {
    return describeLoomyCode(code, typeof record.desc === 'string' ? record.desc : '')
  }
  return undefined
}

/**
 * 发起对话，返回**上游原始 `Response`**（由网关逐帧透传）。
 *
 * ## ⚠️ 为什么这里要 peek 一次 body
 *
 * Loomy 的失败**恒返回 HTTP 200**：token 不对时回
 * `{"code":"100002","desc":"缺少 token"}`，而状态码是 200
 * （`src/loomy.ts:83-85`）。若直接把这个 Response 交给网关的 SSE 转换器，
 * 它会当成「上游流里没有内容」—— 用户看到的是**干净地停止、没有任何报错**，
 * 而真实原因是登录已失效。这是本项目 `AGENTS.md §7.2`「失败必须显式」
 * 明确禁止的形态。
 *
 * ## ⚠️ 什么情况下**不**能 peek
 *
 * 只在 `content-type` 明确是 `application/json` 时才读取 —— 那种响应体是
 * 完整的短 JSON。**绝不对 `text/event-stream` 响应做 `await text()`**：
 * 那会把整条流缓冲进内存（Free 计划只有 10ms CPU，且会让客户端干等）。
 * content-type 缺失或未知时**原样返回**，把判断交给网关。
 */
async function chat(credential: ProviderCredential, request: ChatRequest): Promise<Response> {
  const body = prepareLoomyBody(request.body, request.model)

  let response: Response
  try {
    response = await fetch(`${LOOMY_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: loomyChatHeaders(credential.accessToken),
      body,
      signal: request.signal,
    })
  } catch (error) {
    throw new ProviderError({
      provider: 'loomy',
      message: `Loomy 对话请求失败：${error instanceof Error ? error.message : String(error)}`,
      // 传输层抖动：换号可能有用（也可能是本地出口问题）
      retryable: true,
    })
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new ProviderError({
      provider: 'loomy',
      httpStatus: response.status,
      message: `Loomy 对话失败（HTTP ${response.status}）：${text.slice(0, 300) || '(空响应)'}`,
      retryable: response.status === 429 || response.status === 402,
    })
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    // ⚠️ 非流式：可以安全读取。用 clone 是为了**不消费**原响应 ——
    // 万一它是合法的非流式 OpenAI 响应（如客户端发了 stream:false），
    // 网关仍能拿到完整 body。
    const text = await response.clone().text().catch(() => '')
    const detail = readLoomyErrorBody(text)
    if (detail !== undefined) {
      throw new ProviderError({
        provider: 'loomy',
        httpStatus: 200,
        message: `Loomy 对话失败（HTTP 200 业务错误）：${detail}`,
        // ⚠️ 限流 / 余额耗尽值得换号；登录失效（100002）也换号 ——
        // 同一份死凭据重试无意义，而池里另一个账号可能仍然可用。
        retryable: true,
      })
    }
  }

  return response
}

// ── 余额 ────────────────────────────────────────────────────────────

/** 两个积分池的明细。 */
export interface LoomyCreditDetail {
  /** 永久积分（`balance`）。 */
  permanent: number
  /** 每日赠送池余额（`dailyBalance` = `dailyQuota` - `dailyConsumed`）。 */
  daily: number
  /** 永久 + 每日（`availableBalance`）。 */
  total: number
}

/** 把任意值读成有限数字；非法返回 `undefined`（不编造 0）。 */
function readNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 查询两个积分池（**只读**）。
 *
 * ⚠️ 用 `points/records` 而**不是** `first-login`：后者是**写**端点，
 * 在「打开面板」这类高频路径上调用会意外触发签到
 * （`src/loomy-credits.ts:115-121`）。
 *
 * ## 两个池为什么必须分开报告
 *
 * - **永久积分**：注册奖励 5000 + 新手任务 10000（不过期）；
 * - **每日赠送池**：每天 5000，**消耗后不回补**，次日重置。
 *
 * 实测（`src/loomy-credits.ts:10-16`）：
 * `balance: 15000` / `dailyBalance: 4992` / `availableBalance: 19992`。
 * 合并成一个数字会让用户看不出「哪部分今天会作废」。
 */
async function balance(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderBalance> {
  const data = await loomyBusinessRequest<Record<string, unknown>>(
    credential,
    '/points/records?pageNo=1&pageSize=1&recordType=all',
    { method: 'GET' },
    signal,
  )

  const permanent = readNumber(data?.balance)
  if (permanent === undefined) {
    // ⚠️ `balance` 是核心字段：没有它就说明响应形状不对。
    // 返回 0 会让面板显示「余额为 0」——那是把「查不到」伪装成「没有」。
    throw new ProviderError({
      provider: 'loomy',
      message: 'Loomy 余额响应缺少 `balance` 字段：无法确认额度（不返回 0 以免误报为「已用尽」）',
    })
  }
  const daily = readNumber(data?.dailyBalance) ?? 0
  const total = readNumber(data?.availableBalance) ?? permanent + daily

  return {
    total,
    // ⚠️ 每日赠送池**当天结束即作废**，故它整额都是「即将过期」。
    // 这不是估算：`dailyBalance` 的定义就是「今天还能用、明天不累积」。
    expiring: daily,
    // 服务端不返回每日池的重置时刻（`dailyCycleDate` 只在写端点里给），
    // 故给 0 = 未知。编造一个「今天 24:00」会在跨时区时给出错误的时刻。
    earliestExpiry: 0,
    packages: [
      { name: '永久积分', amount: permanent, expiry: 0 },
      { name: '每日赠送（当天有效，消耗后不回补）', amount: daily, expiry: 0 },
    ],
  }
}

// ── 签到 ────────────────────────────────────────────────────────────

/**
 * 「签到」= 触发每日赠送额度。
 *
 * ## ⚠️ 语义必须说清（这一点很容易写错）
 *
 * 它**不是**「+5000 积分」，而是**触发每日额度重置**：
 * `dailyBalance = dailyQuota - dailyConsumed`，**消耗后不回补**
 * （`src/loomy-credits.ts:195-206`）。
 *
 * ## 幂等判据
 *
 * 是响应体的 `alreadyProcessed`，**不是 HTTP 状态码**（重复调用同样返回 200）。
 * 故已处理映射成 `alreadyDone: true` 而**不是**「成功领取」——
 * 后者会让用户以为每天都真的加了额度。
 *
 * ⚠️ `dailyQuota` **只在 `first-login` 的响应里**（`points/records` 不返回它），
 * 故**不要硬编码 5000** —— 额度会随活动变化。
 */
async function checkin(credential: ProviderCredential, signal: AbortSignal): Promise<CheckinResult> {
  const data = await loomyBusinessRequest<Record<string, unknown>>(
    credential,
    '/points/first-login',
    { method: 'POST', body: '{}' },
    signal,
  )

  const dailyQuota = readNumber(data?.dailyQuota)
  const dailyBalance = readNumber(data?.dailyBalance)
  const dailyConsumed = readNumber(data?.dailyConsumed)
  const alreadyProcessed = data?.alreadyProcessed === true

  if (alreadyProcessed) {
    return {
      alreadyDone: true,
      gained: 0,
      detail: dailyQuota === undefined
        ? '今日每日额度已初始化（幂等命中，未重复发放）'
        : `今日每日额度已初始化：${dailyBalance ?? 0}/${dailyQuota}（消耗后不回补）`,
    }
  }

  // 首次处理：`gained` 是**本次可用的每日额度**，即 dailyQuota - dailyConsumed。
  // 服务端不给这个差值，故现算；两者都缺时回 0（不编造）。
  const gained = dailyQuota !== undefined && dailyConsumed !== undefined
    ? Math.max(0, dailyQuota - dailyConsumed)
    : (dailyQuota ?? 0)

  return {
    alreadyDone: false,
    gained,
    detail: dailyQuota === undefined
      ? '已触发今日每日赠送额度（服务端未回报 quota，具体数额未知）'
      : `已触发今日每日赠送额度：可用 ${gained}/${dailyQuota}（消耗后不回补，次日重置）`,
  }
}

// ── 供应商导出 ──────────────────────────────────────────────────────

export const loomyProvider: Provider = {
  id: 'loomy',
  name: 'Loomy（讯飞）',
  capabilities: {
    /**
     * ✅ 登录可在 Workers 完成。
     *
     * 依据：微信扫码是**纯 HTTP 长轮询**（拉授权页 → 正则取 uuid →
     * 轮询 `long.open.weixin.qq.com/connect/l/qrconnect`），短信登录是三个 POST，
     * 两者都**不需要 `127.0.0.1` 监听**（`src/loomy-wechat.ts:11-29`）。
     * ⚠️ 参考项目的 `createServer` 只在承载二维码 HTML 展示页
     * （`src/loomy-wechat-login.ts:161-175`），那部分应由本服务面板承担。
     */
    /**
     * ✅ **短信验证码登录已接线**（`/admin/providers/login/start` + `/login/loomy/sms`）。
     *
     * ## ⚠️ 它为什么在 Workers 上可行（与 loomy 的微信扫码相反）
     *
     * 短信路径是**纯 HTTP 三步**（发码 → 用户输入 → 校验），
     * `loomy-oauth.ts` 里 `127.0.0.1` 出现 **0 次**（实测 grep）——
     * 不需要任何本地回调监听。
     *
     * ⚠️ 而**微信扫码**那条需要本地服务器承载弹窗页
     *（`loomy-wechat-login.ts:11-13`：`127.0.0.1:随机端口` 上的 `/wechat/qr`
     * 与 `/wechat/poll`），Workers 拉不起本地端口 ⇒ **那条不可行**。
     * 故面板上 loomy 只提供**短信**一种方式。
     *
     * 依据：参考实现 `deepseek-harness-codearts/src/loomy-oauth.ts:6-7,131-186`。
     */
    login: true,
    listModels: true,
    chat: true,
    balance: true,
    /** ✅ `POST /points/first-login`（`src/loomy-credits.ts:208`）。 */
    checkin: true,
  },
  /**
   * 对象凭据的判别式（自动识别时用）。
   *
   * ## 🔴 为什么必须有它
   *
   * 用户报「我在本地登录了 lobsterai，你推送上去试试」时实测发现：
   * **没有 `matchesShape` 的供应商在自动识别里永远轮不到** ——
   * `parseCredentialAnywhere` 的循环会把「`matchesShape === undefined`」
   * 当成「字段形状不属于该供应商」而**直接跳过**（`index.ts:170-176`）。
   * LobsterAI 就是这样被判成了 Raccoon（两者 `user_id` 都是纯数字）。
   * Loomy 是同一型缺陷的下一个受害者。
   *
   * ⚠️ 判据**复用** `looksLikeLoomyCredential`，与 `parseCredential` 同一份。
   */
  matchesShape: looksLikeLoomyCredential,
  parseCredential,
  listModels,
  chat,
  balance,
  checkin,
  // ⚠️ **刻意不提供 `refresh`**：Loomy 没有任何续期端点，`session` 过期只能
  // 重新登录。完整依据与行为影响见本文件上方「刻意不实现 refresh()」一节。
  // 不在这里写一个「探测型 refresh」是**遵守 `Provider.refresh` 的契约**
  //（它必须返回新凭据）—— 详情见该节末尾对参考实现的对照说明。
  /**
   * 429（限流）与 402（余额耗尽）值得换号 —— 这是 `Provider` 的缺省语义。
   * 另外补上 401/403 与业务码 `100002`：Loomy **没有续期端点**
   * （`src/loomy.ts:196-205`），凭据一旦失效就只能换号，
   * 在同一份死凭据上重试是纯浪费。
   */
  shouldRotate(status, bodyText) {
    if (status === 429 || status === 402) return true
    if (status === 401 || status === 403) return true
    return bodyText.includes(LOOMY_AUTH_ERROR_CODE)
  },
}

// ── 🔴 本供应商**刻意不实现** `refresh()` ──────────────────────────
//
// Loomy **没有任何续期端点**：`session` 是登录时向服务端声明
// `expire: 1209600`（14 天）得来的，响应里既没有 refresh_token、也没有到期
// 时间戳，到期只能**重新短信/扫码登录**（`src/loomy.ts:196-205` 的
// `isLoomyRefreshable` 恒返回 `false`；`src/loomy-auth.ts:1-19` 更把这一点
// 列为「与其余 7 个 provider 的根本差异：不能续期」）。
//
// ⇒ 按 `types.ts` 的「不假装支持」纪律，这里**省略** `refresh()`，
// 而不是编一个「看起来在续期、实际什么都没换」的方法 —— 后者会让网关在 401
// 后白重放一次请求，并把「请重新登录」这条唯一有用的信息淹没在噪声里。
//
// ⚠️ 由此产生的**行为差异**（必须知道）：网关的续期重放分支要求
// `provider.refresh !== undefined`（`gateway/server.ts:582`），故 Loomy 的
// 凭据过期后会**直接**走失败/换号路径，而不是先续期再重放。
// 这正是本家的实际情况：它**没有**可续期的东西，重放一次同样是 401。
//
// 📌 参考实现的对照（`deepseek-harness-codearts/src/loomy-auth.ts:315-341`）：
// 它的 `refresh()` 在 Loomy 上被实现为**有效性探测**（打一次最便宜的只读端点
// `GET /points/records?pageSize=1`），失效时抛 `RefreshTokenExpiredError`，
// 用来把「登录过期」翻译成 UI 上的「凭证过期，请重新登录」。
// 但 `Provider` 接口的 `refresh` 契约是「返回**新凭据**」（`types.ts:178-194`），
// 一个不返回新凭据的探测并不满足该契约 —— 故这里选择省略，并把差异如实报告。

// ── 登录（供面板调用；Provider 接口本身没有登录方法） ────────────────
//
// ⚠️ 为什么这些函数在适配器文件里而不是单独一个模块：它们的**全部**输出
// 都是「一份 `ProviderCredential`」，与 `parseCredential` 必须共用同一套
// uid/expiresAt 口径。分成两个模块会让口径漂移（真实缺陷的同型：
// 「登录存一份、导入存另一份」，导致同一账号出现两条记录）。

/**
 * 构造讯飞账号端点的请求体信封 `{ base, param }`。
 *
 * 依据 `account-service.js:441-450`（`src/loomy-oauth.ts:49-71`）。
 * `traceid` 每次调用重新生成（去掉连字符的 uuid = 32 位 hex）。
 *
 * ⚠️ `ua` **硬编码 macOS**：官方客户端在 Windows 上发的也是这个值，照抄不要改。
 */
export function buildLoomyAccountBody(param: Record<string, unknown>): Record<string, unknown> {
  return {
    base: {
      appid: LOOMY_APP_ID,
      modelid: 'Web',
      version: '1.0.0',
      devid: 'web',
      ua: 'Loomy|Desktop|Electron|macOS',
      traceid: crypto.randomUUID().replaceAll('-', ''),
    },
    param,
  }
}

/**
 * 发一次讯飞账号端点请求并拆信封。
 *
 * ⚠️ body 序列化一次、签名与发送共用 —— 这是签名能通过的前提。
 */
async function postLoomyAccount(
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const serialized = JSON.stringify(body)
  // ⚠️ 签名必须用**这个**字符串（见 loomyAuthHeaders 的注释）
  const headers = await loomyAuthHeaders({ method: 'POST', path, body: serialized, contentType: 'application/json' })

  let response: Response
  try {
    response = await fetch(`${LOOMY_ACCOUNT_BASE}${path}`, {
      method: 'POST',
      headers,
      body: serialized,
      signal: AbortSignal.any([signal, AbortSignal.timeout(LOOMY_REQUEST_TIMEOUT_MS)]),
    })
  } catch (error) {
    throw new ProviderError({
      provider: 'loomy',
      message: `讯飞账号请求失败（${path}）：${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    })
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new ProviderError({
      provider: 'loomy',
      httpStatus: response.status,
      message: `讯飞账号响应不是 JSON（${path}，HTTP ${response.status}）`,
    })
  }

  const envelope = parseLoomyEnvelope<Record<string, unknown>>(parsed)
  if (!envelope.ok) {
    // 账号端点的鉴权错误码与业务端点不同（实测 `020002` 也是登录态问题），
    // 但对本模块而言都是「这次调用失败」——直接把服务端文案透传，
    // 上层据文案区分「验证码错误」与「手机号格式不正确」。
    throw new ProviderError({
      provider: 'loomy',
      httpStatus: response.status,
      message: envelope.message.length > 0 ? envelope.message : `讯飞账号请求失败（${path}）`,
    })
  }
  return envelope.data ?? {}
}

/**
 * 下发短信验证码。
 *
 * @returns `msgid` —— 提交验证码时必须原样带回。
 */
export async function sendLoomySmsCode(phone: string, signal: AbortSignal): Promise<string> {
  const data = await postLoomyAccount(
    '/login/phone/sendMsgCode',
    buildLoomyAccountBody({ ccode: '86', phone, expire: LOOMY_SMS_CODE_TTL_SECONDS }),
    signal,
  )
  const msgid = typeof data.msgid === 'string' ? data.msgid : ''
  if (msgid === '') {
    // ⚠️ 不返回空串：上层会拿它去登录，服务端必然报「msgid 无效」，
    // 用户看到的将是一个与真实原因无关的错误。
    throw new ProviderError({ provider: 'loomy', message: '短信验证码响应缺少 msgid' })
  }
  return msgid
}

/** 一次成功登录的结果。 */
export interface LoomyLoginResult {
  /** 已可直接存池的凭据。 */
  credential: ProviderCredential
  /** 讯飞 session（32 位小写 hex）。 */
  session: string
  /** 讯飞用户 id。 */
  userid: string
}

/**
 * 用短信验证码登录。
 *
 * @throws {ProviderError} 验证码错误/过期、缺少字段、网络失败。
 */
export async function loginLoomyBySmsCode(
  phone: string,
  code: string,
  msgid: string,
  signal: AbortSignal,
): Promise<LoomyLoginResult> {
  const data = await postLoomyAccount(
    '/login/phone/checkCode',
    buildLoomyAccountBody({
      ccode: '86',
      phone,
      mcode: code,
      msgid,
      expire: LOOMY_SESSION_TTL_SECONDS,
    }),
    signal,
  )
  const session = typeof data.session === 'string' ? data.session : ''
  const userid = typeof data.userid === 'string' ? data.userid : ''
  if (session === '') throw new ProviderError({ provider: 'loomy', message: '登录响应缺少 session' })
  if (userid === '') throw new ProviderError({ provider: 'loomy', message: '登录响应缺少 userid' })

  // ⚠️ `expires_at` 由本地按 14 天推算 —— 服务端**只接受**登录请求里的
  // `expire` 参数，响应里不带到期时间（`src/loomy.ts:63-69`）。
  const expiresAt = Date.now() + LOOMY_SESSION_TTL_SECONDS * 1000
  return {
    session,
    userid,
    credential: parseCredential({ access_token: session, userid, phone, expires_at: expiresAt }),
  }
}

/** 微信授权的中间上下文（第 1 步返回）。 */
export interface LoomyWechatBindAuth {
  /** `1` = 讯飞侧已绑手机号（可直接 skip 换 session）；`0` = 需绑定手机号。 */
  bind: 0 | 1
  /** 后续三步都要用的会话标识。 */
  rcode: string
  nickname?: string
}

/**
 * 微信扫码第 1 步：用微信 `code` 换 `rcode`，并得知是否已绑手机号。
 *
 * ⚠️ 微信 `code` 只在**这一步**用一次，后续三步只用 `rcode`
 * （`src/loomy-oauth.ts:182-192`）。
 */
export async function bindLoomyThirdAccount(
  code: string,
  signal: AbortSignal,
): Promise<LoomyWechatBindAuth> {
  const data = await postLoomyAccount(
    '/login/thirdAccount/bind/auth',
    buildLoomyAccountBody({ tcode: { code }, type: 'wx' }),
    signal,
  )
  const rcode = typeof data.rcode === 'string' ? data.rcode : ''
  if (rcode === '') {
    // 没有 rcode 后续三步全做不了 ⇒ 必须在此明确报错，
    // 而不是让流程走到一半才失败。
    throw new ProviderError({ provider: 'loomy', message: '微信授权响应缺少 rcode' })
  }
  // ⚠️ `bind` 缺失时**归为 0**（走绑定流程）：保守方向 ——
  // 若实际已绑，用户最多多填一次手机号；若实际未绑却跳过，
  // 会拿到一个没有手机号的账号。
  const bind: 0 | 1 = data.bind === 1 ? 1 : 0
  const nickname = typeof data.nickname === 'string' && data.nickname.length > 0 ? data.nickname : undefined
  return { bind, rcode, ...(nickname === undefined ? {} : { nickname }) }
}

/** 第 2 步：向待绑定的手机号下发验证码。 */
export async function bindLoomySendMsg(rcode: string, phone: string, signal: AbortSignal): Promise<string> {
  const data = await postLoomyAccount(
    '/login/thirdAccount/bind/sendMsg',
    buildLoomyAccountBody({ rcode, phone, ccode: '86', expire: LOOMY_SMS_CODE_TTL_SECONDS }),
    signal,
  )
  const msgid = typeof data.msgid === 'string' ? data.msgid : ''
  if (msgid === '') throw new ProviderError({ provider: 'loomy', message: '绑定手机号响应缺少 msgid' })
  return msgid
}

/** 第 3 步：验证短信验证码，通过即完成绑定 + 登录。 */
export async function bindLoomyCheckCode(
  rcode: string,
  mcode: string,
  msgid: string,
  signal: AbortSignal,
): Promise<LoomyLoginResult> {
  const data = await postLoomyAccount(
    '/login/thirdAccount/bind/checkCode',
    buildLoomyAccountBody({ rcode, mcode, msgid, expire: LOOMY_SESSION_TTL_SECONDS }),
    signal,
  )
  const session = typeof data.session === 'string' ? data.session : ''
  const userid = typeof data.userid === 'string' ? data.userid : ''
  const phone = typeof data.phone === 'string' ? data.phone : ''
  if (session === '') throw new ProviderError({ provider: 'loomy', message: '绑定登录响应缺少 session' })
  if (userid === '') throw new ProviderError({ provider: 'loomy', message: '绑定登录响应缺少 userid' })
  const expiresAt = Date.now() + LOOMY_SESSION_TTL_SECONDS * 1000
  return {
    session,
    userid,
    credential: parseCredential({ access_token: session, userid, phone, expires_at: expiresAt }),
  }
}

/** 第 4 步（`bind === 1` 时走）：跳过绑定，直接换 session。 */
export async function bindLoomySkip(rcode: string, signal: AbortSignal): Promise<LoomyLoginResult> {
  const data = await postLoomyAccount(
    '/login/thirdAccount/bind/skip',
    buildLoomyAccountBody({ rcode, expire: LOOMY_SESSION_TTL_SECONDS }),
    signal,
  )
  const session = typeof data.session === 'string' ? data.session : ''
  const userid = typeof data.userid === 'string' ? data.userid : ''
  if (session === '') throw new ProviderError({ provider: 'loomy', message: '微信登录响应缺少 session' })
  if (userid === '') throw new ProviderError({ provider: 'loomy', message: '微信登录响应缺少 userid' })
  const expiresAt = Date.now() + LOOMY_SESSION_TTL_SECONDS * 1000
  // 微信路径拿不到手机号，而 uid 优先用 userid（本路径一定有），故可用
  return {
    session,
    userid,
    credential: parseCredential({ access_token: session, userid, expires_at: expiresAt }),
  }
}

// ── 微信扫码（纯 HTTP，无需本地监听） ────────────────────────────────

/** 一次长轮询的结果。 */
export interface LoomyWechatPollResult {
  status: (typeof LOOMY_WECHAT_POLL_STATUS)[keyof typeof LOOMY_WECHAT_POLL_STATUS]
  /** 仅在 `confirmed` 时非空：微信一次性授权码。 */
  code: string
  /** 本次响应的 errcode（诊断用）。 */
  errcode: string
}

/** 拼微信授权页 URL。 */
export function buildLoomyWechatAuthUrl(state: string): string {
  return 'https://open.weixin.qq.com/connect/qrconnect'
    + `?appid=${encodeURIComponent(LOOMY_WECHAT_APP_ID)}`
    + `&redirect_uri=${encodeURIComponent(LOOMY_WECHAT_REDIRECT_URI)}`
    + '&response_type=code'
    + '&scope=snsapi_login'
    + `&state=${encodeURIComponent(state)}`
    + '#wechat_redirect'
}

/** 拼二维码图片地址（前端可直接 `<img src>`）。 */
export function buildLoomyWechatQrImageUrl(uuid: string): string {
  return `https://open.weixin.qq.com/connect/qrcode/${encodeURIComponent(uuid)}`
}

/**
 * 从授权页 HTML 提取二维码 uuid。
 *
 * 实测页面**直接内嵌** uuid，两条路径互为兜底（`src/loomy-wechat.ts:126-152`）：
 * 主路径 `<img class="js_qrcode_img" src="/connect/qrcode/<uuid>">`，
 * 兜底 `.../connect/l/qrconnect?uuid=<uuid>`。
 *
 * ⚠️ **无需执行 JS** —— 这是本方案能脱离浏览器的基础。
 *
 * @returns 提取不到时返回**空串**（由调用方决定是否抛错）。
 */
export function extractLoomyWechatUuid(html: unknown): string {
  if (typeof html !== 'string' || html.length === 0) return ''
  // 字符集下限取 6 而非更长：微信未承诺长度，收紧只会让格式微调时静默失效
  const pattern = /^[A-Za-z0-9_\-=+/]{6,64}$/
  const fromImg = html.match(/\/connect\/qrcode\/([A-Za-z0-9_\-=+/]+)/)
  if (fromImg !== null) {
    const candidate = String(fromImg[1] ?? '')
    if (pattern.test(candidate)) return candidate
  }
  const fromPoll = html.match(/l\/qrconnect\?uuid=([A-Za-z0-9_\-=+/]+)/)
  if (fromPoll !== null) {
    const candidate = String(fromPoll[1] ?? '')
    if (pattern.test(candidate)) return candidate
  }
  return ''
}

/** 拉取微信授权页并提取 uuid。 */
export async function fetchLoomyWechatUuid(state: string, signal: AbortSignal): Promise<string> {
  let response: Response
  try {
    response = await fetch(buildLoomyWechatAuthUrl(state), {
      headers: { 'User-Agent': WECHAT_UA, Referer: 'https://open.weixin.qq.com/' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
  } catch (error) {
    throw new ProviderError({
      provider: 'loomy',
      message: `微信授权页拉取失败：${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    })
  }
  if (!response.ok) {
    throw new ProviderError({ provider: 'loomy', httpStatus: response.status, message: `微信授权页返回 HTTP ${response.status}` })
  }
  const uuid = extractLoomyWechatUuid(await response.text())
  if (uuid === '') {
    // ⚠️ 不返回空串：上层会拿它去轮询，必然一直 waiting，用户看不到任何原因。
    throw new ProviderError({
      provider: 'loomy',
      message: '微信授权页未包含二维码 uuid（页面结构可能已变化）',
    })
  }
  return uuid
}

/**
 * 执行一次微信长轮询。
 *
 * ⚠️ **状态语义以微信授权页内嵌 JS（`switch(window.wx_errcode)`）为准**
 * （官方源码，`src/loomy-wechat.ts:48-71`）：
 *
 * | errcode | 含义 | 返回 |
 * |---|---|---|
 * | 408 | 待扫码（常态） | `waiting` |
 * | 404 | **已扫码待确认**（继续轮询） | `scanned` |
 * | 405 | **已确认**，`wx_code` 就在这一帧 | `confirmed` |
 * | 403 | 用户取消 | `cancelled` |
 * | 402 | 二维码失效 | `expired` |
 *
 * ⚠️ **405 但 `wx_code` 为空时不判成功**：否则会拿空 code 去换 session。
 * ⚠️ 网络异常返回 `error` 状态而**不抛错**：长轮询偶发失败不该终止整个流程，
 * 由调用方的循环决定是否重试。
 */
export async function pollLoomyWechatOnce(
  uuid: string,
  lastErrcode: string,
  signal: AbortSignal,
): Promise<LoomyWechatPollResult> {
  const query = `uuid=${encodeURIComponent(uuid)}`
    + (lastErrcode.length > 0 ? `&last=${encodeURIComponent(lastErrcode)}` : '')
    + `&_=${Date.now()}`
  const url = `https://long.open.weixin.qq.com/connect/l/qrconnect?${query}`

  let body: string
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': WECHAT_UA, Referer: buildLoomyWechatAuthUrl('') },
      signal: AbortSignal.any([signal, AbortSignal.timeout(LOOMY_WECHAT_POLL_TIMEOUT_MS)]),
    })
    body = await response.text()
  } catch (error) {
    return {
      status: LOOMY_WECHAT_POLL_STATUS.error,
      code: '',
      errcode: error instanceof Error ? error.message : 'network',
    }
  }

  const errcode = (body.match(/wx_errcode\s*=\s*(\d+)/) ?? [])[1] ?? ''
  const code = (body.match(/wx_code\s*=\s*'([^']*)'/) ?? [])[1] ?? ''

  if (errcode === '405') {
    // ⚠️ 405 = **已确认**（官方 JS 在此分支用 wx_code 拼回调 URL）
    return code.length > 0
      ? { status: LOOMY_WECHAT_POLL_STATUS.confirmed, code, errcode }
      // 405 却没带 code：异常形态。保守判 scanned（继续轮询），
      // **绝不**拿空 code 去换 session。
      : { status: LOOMY_WECHAT_POLL_STATUS.scanned, code: '', errcode }
  }
  if (errcode === '404') return { status: LOOMY_WECHAT_POLL_STATUS.scanned, code: '', errcode }
  if (errcode === '403') return { status: LOOMY_WECHAT_POLL_STATUS.cancelled, code: '', errcode }
  if (errcode === '402') return { status: LOOMY_WECHAT_POLL_STATUS.expired, code: '', errcode }
  // 408 与未知值一律归 waiting（保守：绝不误判成功）
  return { status: LOOMY_WECHAT_POLL_STATUS.waiting, code: '', errcode }
}
