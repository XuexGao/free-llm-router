/**
 * 上游 HTTP 客户端与**错误分类**（决定「换号」还是「罚号」）。
 *
 * ## 这个模块为什么关键
 *
 * Go 侧有 13 种 `ErrKind`、12 层判定优先级（`internal/upstream/client.go:489-596`）。
 * 分类错误的后果是不对称的：
 * - 把「临时限流」当「账号死亡」→ **误杀健康账号**（Go 侧真实事故：
 *   13 个 disabled 号 refresh 全部成功，全是历史误判的受害者）；
 * - 把「账号死亡」当「临时限流」→ 反复打无效号，放大风控。
 *
 * ## 两条必须守住的判据（来自实测）
 *
 * 1. **WAF 判据只看 `403 + 无业务信封`**（`client.go:337-340`）。
 *    实测 APISIX 对「缺凭据」回的是 **401**，web 域甚至回 **302** ——
 *    把 401/302 也当 WAF 会产生**假警报**（本项目出口验证探针就踩过这个坑）。
 * 2. **12153 单次不算死亡**：连续 3 次才禁用（`state.go:27-40`）。
 */

import type { HeaderMap } from './headers.js'

/** 上游业务信封（所有端点统一形态）。 */
export interface Envelope<T = unknown> {
  code: number
  msg: string
  data?: T
}

/**
 * 错误类别。
 *
 * ⚠️ 命名与 Go 的 `ErrKind` 有意保持可对照（便于查 Go 侧注释），
 * 但只保留第一版需要的子集（AGENTS.md §3.2 的范围裁剪）。
 */
export type ErrorKind =
  | 'network' // 网络层失败（连接重置/DNS/TLS）—— 可重试，不罚号
  | 'server' // 上游 5xx —— 可重试，喂熔断
  | 'rate_limited' // 429 / 6004 —— 换号 + 冷却；6004 是**模型级**
  | 'model_unavailable' // 11102：该后端无此模型 —— (账号,模型) 负缓存
  | 'credit_exhausted' // 402 / 14018 —— 硬冷却至次日 04:00
  | 'waf_blocked' // HTTP 403 且无业务信封 —— **可能是 IP 级**（会触发 IP 级判定）
  /**
   * **渠道指纹**被上游拒绝（业务码 `11128`，`unapproved channel`）。
   *
   * ⚠️ 与 `waf_blocked` 的**关键区别**（实测缺陷：我一度把两者混为一类）：
   * - `waf_blocked` 是 **HTTP 403 + 无业务信封** —— 典型的 WAF 拦截形态，
   *   有可能是**出口 IP 级**（多个账号会同时命中）⇒ 需要 IP 级判定；
   * - `channel_blocked` 是**正常的业务码响应**（`{"code":11128,...}`），
   *   只说明**这个请求的指纹**不被认可 —— **与出口 IP、与账号都无关**。
   *
   * ⇒ 混为一类会导致：每个账号的 11128 都被记成「IP 级 403 命中」，
   * 很快凑够阈值 ⇒ **误报「出口 IP 被 WAF 拦截」并全局停服**。
   *（`WAF_IP_THRESHOLD = 2`，而用户有 3 个账号，极易触发。）
   */
  | 'channel_blocked'
  | 'request_illegal' // 11140 —— 强信号，直接禁用账号
  | 'session_dead' // 12153 —— **连续 3 次**才禁用
  | 'context_exceeded' // 11115 —— 不罚号、不轮转
  | 'image_invalid' // 11135 —— 不罚号、不轮转
  | 'auth_error' // 401 —— 续期凭据后重试
  | 'not_found' // 404 —— 路径不存在（可能需换 fallback 路径）
  | 'already_done' // 幂等命中（如签到 10001）—— 视为成功
  | 'unsupported' // 能力不支持（如 workbuddy 无签到）—— 跳过，不算失败
  | 'unknown'

/** 上游错误。`detail` 保留**原文片段**，便于定位（AGENTS.md §7.2 禁止静默失败）。 */
export class UpstreamError extends Error {
  readonly kind: ErrorKind
  readonly httpStatus: number
  readonly code: number | undefined
  readonly detail: string

  constructor(input: {
    kind: ErrorKind
    httpStatus: number
    code?: number
    message: string
    detail: string
  }) {
    super(input.message)
    this.name = 'UpstreamError'
    this.kind = input.kind
    this.httpStatus = input.httpStatus
    this.code = input.code
    this.detail = input.detail
  }
}

/** 已知业务码 → 错误类别。数值来自 Go 侧实测。 */
const CODE_KIND: Record<number, ErrorKind> = {
  6004: 'rate_limited',
  11102: 'model_unavailable',
  14018: 'credit_exhausted',
  14017: 'rate_limited',
  11140: 'request_illegal',
  12153: 'session_dead',
  11115: 'context_exceeded',
  11135: 'image_invalid',
  // ⚠️ **11128 不是 `request_illegal`**（实测缺陷，用户报「账号是好的但就是用不了」）。
  //
  // 上游原文：`Illegal API invocation from an unapproved channel` /
  // `The request was blocked by security policy.`
  //
  // 关键区别：
  // - `11140`（真正的 request_illegal）是**这个账号发了非法请求** ⇒ 该罚账号；
  // - `11128` 是**请求的渠道指纹不被认可** ⇒ 与账号无关，罚账号是错的。
  //
  // ⚠️ 而且 11128 还是上游**反探测机制自身的错误码**（AGENTS.md §6.6）：
  // 请求体里出现裸 `11128` 就会触发它。也就是说这个码**既表示拦截、又是拦截条件**。
  //
  // ⚠️ 归类为 **`channel_blocked`（不是 `waf_blocked`）**：
  // 两者都要「软冷却 + 不换号」，但 `waf_blocked` 还会触发**IP 级判定**
  //（`noteWaf`）—— 而 11128 与出口 IP **无关**，用它触发 IP 判定会**误报全局封锁**。
  // 这正是「有的软件能用、有的不能」的原因：凑够 2 个账号就整体停服 60 秒。
  11128: 'channel_blocked',
  // 幂等命中：签到已领（视为成功）
  10001: 'already_done',
  1001: 'already_done',
  14051: 'already_done',
}

/** 判定响应体是否为「业务信封」形态。 */
export function parseEnvelope(text: string): Envelope | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const value = JSON.parse(trimmed) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const obj = value as Record<string, unknown>
    const raw = obj.code
    const code = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
    if (!Number.isFinite(code)) return undefined
    return {
      code,
      msg: typeof obj.msg === 'string' ? obj.msg : '',
      data: obj.data,
    }
  } catch {
    return undefined
  }
}

/**
 * WAF 判据：**HTTP 403 且响应体无业务信封**。
 *
 * ⚠️ 逐字照抄 Go 的 `IsWafBlocked`（`client.go:337-340`）。
 * 两个最容易被误加的判据：
 * - **401 不是 WAF**（实测 APISIX 对缺 Authorization 就是 401）；
 * - **302 不是 WAF**（web 域 `/console/account` 对未授权回 302 跳登录）。
 * 把它们当 WAF 会让「凭据过期」看起来像「IP 被封」，排查方向完全错。
 */
export function isWafBlocked(httpStatus: number, bodyText: string): boolean {
  return httpStatus === 403 && parseEnvelope(bodyText) === undefined
}

/**
 * 分类一次响应。
 *
 * 判定顺序即语义（Go 侧 12 层优先级的精简版，保留了顺序敏感的部分）：
 * 1. WAF（403 无信封）—— 必须**最先**判，否则会被通用 4xx 分支吃掉；
 * 2. 5xx → `server`；
 * 3. 信封里的业务码 → 对应类别；
 * 4. 401/403（有信封或非 403）→ `auth_error`；
 * 5. 404 → `not_found`；
 * 6. 其余 → 按状态码粗分。
 */
export function classify(httpStatus: number, bodyText: string): { kind: ErrorKind; code?: number; msg: string } {
  // ── 1. WAF：必须最先判 ──
  if (isWafBlocked(httpStatus, bodyText)) {
    return { kind: 'waf_blocked', msg: 'WAF blocked (403 without business envelope)' }
  }

  const envelope = parseEnvelope(bodyText)

  // ── 2. 5xx ──
  if (httpStatus >= 500) {
    return { kind: 'server', code: envelope?.code, msg: envelope?.msg ?? `upstream ${httpStatus}` }
  }

  // ── 3. 业务码（有信封时优先按码判） ──
  if (envelope !== undefined) {
    const mapped = CODE_KIND[envelope.code]
    if (mapped !== undefined) {
      return { kind: mapped, code: envelope.code, msg: envelope.msg }
    }
    if (envelope.code === 0) {
      return { kind: 'unknown', code: 0, msg: envelope.msg }
    }
    // 有信封但码未知：按 HTTP 状态兜底（0 码以外的业务错误）
    if (httpStatus === 401 || httpStatus === 403) {
      return { kind: 'auth_error', code: envelope.code, msg: envelope.msg }
    }
    if (httpStatus === 429) {
      return { kind: 'rate_limited', code: envelope.code, msg: envelope.msg }
    }
    return { kind: 'unknown', code: envelope.code, msg: envelope.msg }
  }

  // ── 4. 无信封：按状态码 ──
  if (httpStatus === 401 || httpStatus === 403) {
    return { kind: 'auth_error', msg: `upstream ${httpStatus}` }
  }
  if (httpStatus === 404) {
    return { kind: 'not_found', msg: 'upstream 404' }
  }
  if (httpStatus === 429) {
    return { kind: 'rate_limited', msg: 'upstream 429' }
  }
  if (httpStatus === 402) {
    return { kind: 'credit_exhausted', msg: 'upstream 402' }
  }
  if (httpStatus >= 400) {
    return { kind: 'unknown', msg: `upstream ${httpStatus}` }
  }

  return { kind: 'unknown', msg: `unexpected status ${httpStatus}` }
}

/** 该错误类别是否「值得换号重试」。 */
export function shouldRotate(kind: ErrorKind): boolean {
  switch (kind) {
    case 'rate_limited':
    case 'model_unavailable':
    case 'credit_exhausted':
    case 'server':
    case 'auth_error':
    case 'session_dead':
    case 'waf_blocked':
      return true
    // ⚠️ 参数类错误**不换号**：换号重试会重放同样的非法请求，放大风控。
    case 'context_exceeded':
    case 'image_invalid':
    case 'request_illegal':
    // ⚠️ 渠道指纹被拒 ⇒ **不换号**：换号撞的是同一套渠道判定，只会放大风控。
    case 'channel_blocked':
    case 'network':
    case 'not_found':
    case 'already_done':
    case 'unsupported':
    case 'unknown':
      return false
  }
}

/** 该错误类别是否应当「罚账号」（改变持久化惩罚状态）。 */
export function shouldPunish(kind: ErrorKind): boolean {
  switch (kind) {
    case 'rate_limited':
    case 'model_unavailable':
    case 'credit_exhausted':
    case 'waf_blocked':
    case 'session_dead':
    case 'request_illegal':
    case 'server':
    // ⚠️ 渠道拦截：**软冷却**（短退避），不是熔断 —— 它不说明账号坏了。
    case 'channel_blocked':
      return true
    case 'network':
    case 'auth_error':
    case 'not_found':
    case 'context_exceeded':
    case 'image_invalid':
    case 'already_done':
    case 'unsupported':
    case 'unknown':
      return false
  }
}

/** 一次上游调用的选项。 */
export interface RequestOptions {
  method: 'GET' | 'POST'
  url: string
  headers: HeaderMap
  body?: string
  /** 超时（毫秒）。默认 30s。 */
  timeoutMs?: number
  /** 外部取消信号（如客户端断开）。 */
  signal?: AbortSignal
}

/** 一次上游调用的结果。 */
export interface UpstreamResponse<T = unknown> {
  ok: boolean
  httpStatus: number
  envelope: Envelope<T> | undefined
  /** 原始响应体（截断到 4KB，仅用于错误诊断）。 */
  raw: string
}

/**
 * 发一次上游请求并解信封。
 *
 * ⚠️ **不 throw**：把分类结果交回调用方，由它决定换号/罚号（Go 侧同口径）。
 * 只有网络层错误会 throw（因为那时没有 HTTP 语义可分类）——
 * 但也包装成 `UpstreamError` 便于统一处理。
 *
 * ⚠️ **响应体大小限制**：`raw` 截断到 4KB。上游错误页可能很大，
 * 全量读入会浪费 10ms CPU 预算且对诊断无益。
 */
export async function callUpstream<T = unknown>(options: RequestOptions): Promise<UpstreamResponse<T>> {
  const timeoutMs = options.timeoutMs ?? 30_000

  // 组合外部信号与超时（AbortSignal.any 在 Workers 可用）
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal])

  let response: Response
  try {
    response = await fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal,
      redirect: 'manual',
    })
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    throw new UpstreamError({
      kind: 'network',
      httpStatus: 0,
      message: `上游请求失败：${message}`,
      detail: message,
    })
  }

  const text = await response.text()
  const raw = text.slice(0, 4096)
  const envelope = parseEnvelope(text) as Envelope<T> | undefined

  // 网络层「成功但业务失败」也走信封：code !== 0 视为 not ok
  const ok = response.status >= 200 && response.status < 300 && (envelope === undefined || envelope.code === 0)

  return { ok, httpStatus: response.status, envelope, raw }
}

/**
 * 发一次请求，**业务失败直接抛 `UpstreamError`**。
 *
 * 便利包装，用于那些「失败就该中断当前步骤」的调用点。
 * 需要按类别分支处理时用 {@link callUpstream} 裸接口。
 */
export async function mustUpstream<T = unknown>(options: RequestOptions): Promise<Envelope<T>> {
  const res = await callUpstream<T>(options)
  if (res.ok && res.envelope !== undefined) {
    return res.envelope
  }

  const { kind, code, msg } = classify(res.httpStatus, res.raw)
  throw new UpstreamError({
    kind,
    httpStatus: res.httpStatus,
    code,
    message: `上游错误（${kind}）：${msg || res.raw.slice(0, 200)}`,
    detail: res.raw,
  })
}
