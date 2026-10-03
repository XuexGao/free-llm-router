/**
 * 网关与账号池的接线：**选号 → 转发 → 记账 → 失败换号**。
 *
 * ## 为什么必须接线（这是架构的核心价值，不是可选优化）
 *
 * 没有接线的网关是「裸代理」：一个账号 429 或余额耗尽，**整个服务立刻不可用**，
 * 而且不会恢复 —— 因为没有任何地方记录「这个号暂时别用」。
 *
 * 接线后形成闭环（对应 Go 侧的 `handler.chatCompletions` 轮转 + `applyErrorPolicy`）：
 *
 * ```
 * pick(排除已试) → 转发 → 成功则 noteSuccess（清熔断）
 *                       ↘ 失败则 applyFailure（按类别落到正确维度）+ 换下一个号
 * ```
 *
 * ## 两个必须守住的纪律
 *
 * 1. **`tried` 集合跨重试保留**：否则会在两个账号之间无限来回
 *    （Go 侧 `account-pool.ts:905-914` 记录过这个缺陷）。
 * 2. **按错误类别罚正确的维度**（AGENTS.md §6.7）：
 *    - `6004` 是**模型级**限流 → 罚 `model`，不罚账号（切模型即可用）；
 *    - `11140` 是强信号 → 直接禁用账号；
 *    - `12153` 要**连续 3 次**才禁用；
 *    - `11115`/`11135` 是**请求的问题**，不罚号、也不换号。
 */

import { resolveUpstream, type Env } from '../env.js'
import { classify, type ErrorKind } from '../upstream/client.js'
import { cliChatHeaders, deriveDeviceId } from '../upstream/headers.js'
import { prepareChatBody, sanitizeChatBody } from './payload.js'
import { detectErrorFrame, doneFrame, errorFrame, parseSseLine, sseHeaders, translateFrame } from './stream.js'
import { jsonError } from './http.js'
import type { LoginCredential } from '../upstream/auth.js'
import type { AccountPoolDO } from '../pool/AccountPoolDO.js'

/** 单次请求最多换号次数（Go 侧 `MaxRotate` 默认 3）。 */
export const MAX_ROTATE = 3

/** 上游错误类别 → 账号池的惩罚维度。 */
export function mapErrorToPunishment(kind: ErrorKind): {
  punish: boolean
  dimension: 'soft' | 'hard' | 'breaker' | 'degrade' | 'session_dead' | 'model'
  /** 该错误是否值得**换号重试**。 */
  rotate: boolean
} {
  switch (kind) {
    // 限流：可能是账号级（14017）或模型级（6004）—— 调用方用错误码进一步区分
    case 'rate_limited':
      return { punish: true, dimension: 'soft', rotate: true }
    // 该后端无此模型：模型级负缓存，换号**可能**有用（不同号挂不同后端）
    case 'model_unavailable':
      return { punish: true, dimension: 'model', rotate: true }
    // 余额耗尽：硬冷却到次日 04:00，换号有用
    case 'credit_exhausted':
      return { punish: true, dimension: 'hard', rotate: true }
    // WAF：账号级软冷却；但可能是 IP 级（详见 AGENTS.md §2.6），换号**无用**
    case 'waf_blocked':
      return { punish: true, dimension: 'soft', rotate: false }
    // 请求非法：强信号，直接禁用；换号无用（同样的非法请求）
    case 'request_illegal':
      return { punish: true, dimension: 'breaker', rotate: false }
    // session 死亡：连续 3 次才禁用；换号有用
    case 'session_dead':
      return { punish: true, dimension: 'session_dead', rotate: true }
    // 5xx：喂熔断；换号有用
    case 'server':
      return { punish: true, dimension: 'breaker', rotate: true }
    // 鉴权失败：续期凭据后重试，**不罚号**（换号可能有用）
    case 'auth_error':
      return { punish: false, dimension: 'soft', rotate: true }
    // 参数类：**不换号**（换号会重放同样的非法请求，放大风控）
    case 'context_exceeded':
    case 'image_invalid':
      return { punish: false, dimension: 'soft', rotate: false }
    // 网络层：抖动量，不构成「这个号坏了」的证据；也不该立刻换号（可能是本地出口抖动）
    case 'network':
      return { punish: false, dimension: 'soft', rotate: false }
    case 'not_found':
    case 'already_done':
    case 'unsupported':
    case 'unknown':
      return { punish: false, dimension: 'soft', rotate: false }
  }
}

/** 从业务码里再细分 6004（模型级）与 14017（账号级）。 */
function refineModelScoped(kind: ErrorKind, bodyText: string): { dimension: 'soft' | 'model'; code: number | undefined } {
  if (kind !== 'rate_limited') return { dimension: 'soft', code: undefined }
  // 6004 = 模型级限流（切模型即可用，不该罚整个账号）
  const m = /"code"\s*:\s*(\d+)/.exec(bodyText)
  const code = m === null ? undefined : Number.parseInt(m[1] ?? '', 10)
  if (code === 6004) return { dimension: 'model', code }
  return { dimension: 'soft', code }
}

/** 选号 + 取凭据。 */
interface Candidate {
  uid: string
  credential: LoginCredential
}

/** 走账号池选号（**排除已试过的**，跨重试保留）。 */
async function pickCandidate(
  pool: DurableObjectStub<AccountPoolDO>,
  realm: string,
  model: string,
  exclude: string[],
  now: number,
): Promise<Candidate | undefined> {
  const result = await pool.pick({ realm, model, exclude, now })
  if (result === undefined) return undefined
  const credential = (await pool.getCredential(result.uid)) as LoginCredential | undefined
  if (credential === undefined || credential.accessToken === '') return undefined
  return { uid: result.uid, credential }
}

/** 网关处理结果。 */
export interface GatewayResult {
  response: Response
}

/**
 * 处理 `/v1/chat/completions`：**选号 → 转发 → 记账 → 失败换号**。
 */
export async function handleChatCompletions(
  request: Request,
  env: Env,
  realm = 'cn',
): Promise<GatewayResult> {
  // ① 解析并准备请求体（一次性，不随换号重复）
  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return { response: jsonError(400, '请求体必须是合法 JSON', 'invalid_request_error') }
  }

  let prepared: string
  try {
    prepared = sanitizeChatBody(prepareChatBody(rawBody).body)
  } catch (error) {
    return {
      response: jsonError(400, error instanceof Error ? error.message : String(error), 'invalid_request_error'),
    }
  }

  const model =
    typeof (rawBody as Record<string, unknown>).model === 'string'
      ? ((rawBody as Record<string, unknown>).model as string)
      : ''

  const bases = resolveUpstream(env)
  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))

  // ⚠️ `tried` 必须**跨重试保留**，否则会在两个账号之间无限来回
  // （Go 侧 account-pool.ts:905-914 记录过这个缺陷）。
  const tried: string[] = []
  let lastError: { status: number; message: string; kind: string } | undefined

  // ⚠️ IP 级 WAF 拦截的**前置检查**：激活期内直接失败，**连一个号都不试**。
  // 理由：轮转会把一次客户端请求放大成 N 次撞同一堵墙，反而加重风控
  // （Go 侧实测：3 个账号 1 秒内全部 403）。判据与窗口见 AccountPoolDO 的常量注释。
  if (await pool.wafGateActive(Date.now())) {
    return {
      response: jsonError(
        503,
        '出口 IP 疑似被上游 WAF 拦截（短时间内多个账号接连 403），已暂停轮转以避免加重风控。稍后自动恢复。',
        'waf_ip_blocked',
      ),
    }
  }

  for (let attempt = 0; attempt <= MAX_ROTATE; attempt += 1) {
    const now = Date.now()
    const candidate = await pickCandidate(pool, realm, model, tried, now)
    if (candidate === undefined) {
      // 没有可用账号了：若之前有过失败，报最后一次的真实原因（更有信息量）
      if (lastError !== undefined) {
        return {
          response: jsonError(lastError.status, `所有可用账号均失败，最后一次：${lastError.message}`, lastError.kind),
        }
      }
      return {
        response: jsonError(
          503,
          '没有可用账号（请先登录/导入凭据；若已导入，检查是否全部处于冷却或禁用状态）',
          'no_available_account',
        ),
      }
    }
    tried.push(candidate.uid)

    // ② 构造出站请求
    const machineId = await deriveDeviceId(candidate.uid, 'machine')
    const sessionId = await deriveDeviceId(candidate.uid, 'session')
    const conversationRequestId = crypto.randomUUID().replaceAll('-', '')

    let upstream: Response
    try {
      upstream = await fetch(`${bases.chat}/v2/chat/completions`, {
        method: 'POST',
        headers: cliChatHeaders({
          uid: candidate.uid,
          machineId,
          sessionId,
          accessToken: candidate.credential.accessToken,
          conversationRequestId,
        }),
        body: prepared,
        signal: request.signal,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const { punish } = mapErrorToPunishment('network')
      // 网络层：**不罚号**（抖动量不构成「这个号坏了」的证据）
      void punish
      lastError = { status: 502, message, kind: 'network' }
      continue // 换号重试
    }

    // ③ 上游错误：分类 → 记账 → 决定是否换号
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      const { kind, msg } = classify(upstream.status, text)
      const mapped = mapErrorToPunishment(kind)
      const { dimension } = refineModelScoped(kind, text)

      // ⚠️ WAF 403 需要**双记账**：
      // ① 账号级软冷却（下方 applyFailure）—— 让这个号暂时别用；
      // ② **IP 级判定**（noteWaf）—— 若短窗内多个不同号都命中，说明是出口 IP 被拦，
      //    此时继续轮转毫无意义（撞的是同一堵墙），必须 fail-fast。
      if (kind === 'waf_blocked') {
        const ipBlocked = await pool.noteWaf(candidate.uid, Date.now()).catch(() => false)
        if (ipBlocked) {
          lastError = {
            status: 503,
            message: '出口 IP 疑似被 WAF 拦截（短窗内多个账号接连 403）',
            kind: 'waf_ip_blocked',
          }
          break // 不再轮转下一个号
        }
      }

      // 记账（按类别落到正确维度）
      if (mapped.punish) {
        await pool
          .applyFailure({
            uid: candidate.uid,
            kind: kind === 'rate_limited' ? dimension : mapped.dimension === 'model' ? 'model' : mapped.dimension,
            now: Date.now(),
            ...(model !== '' ? { model } : {}),
            ...(msg !== '' ? { reason: `${kind}: ${msg}`.slice(0, 200) } : {}),
          })
          .catch(() => {
            // 记账失败不该让回复失败：这是可观测性问题，不是正确性问题
          })
      }

      lastError = {
        status: upstream.status >= 500 ? 502 : upstream.status,
        message: `${kind}: ${msg || text.slice(0, 160)}`,
        kind,
      }

      if (!mapped.rotate) break // 不该换号（参数错/WAF/网络已单独处理）
      continue // 换号重试
    }

    // ④ 成功：按上游流**逐帧透传**，同时判断是否需要记账
    if (upstream.body === null) {
      lastError = { status: 502, message: '上游返回空 body', kind: 'unknown' }
      continue
    }

    return {
      response: streamResponse(upstream.body, {
        onFirstChunk: () => {
          // 首帧到达即算成功（清熔断/降权）
          void pool.noteSuccess(candidate.uid, Date.now()).catch(() => {})
        },
        onError: (message) => {
          // 流**内**错误：无法改 HTTP 状态码了，但要记账
          void pool
            .applyFailure({ uid: candidate.uid, kind: 'breaker', now: Date.now(), reason: message.slice(0, 200) })
            .catch(() => {})
        },
      }),
    }
  }

  // 所有轮转都失败
  return {
    response: jsonError(
      lastError?.status ?? 502,
      lastError === undefined ? '所有账号均失败' : `所有账号均失败，最后一次：${lastError.message}`,
      lastError?.kind ?? 'upstream_error',
    ),
  }
}

/**
 * 把上游 body 逐帧转换成给客户端的 SSE 流。
 *
 * ⚠️ **绝不缓冲**：不 `await response.text()`，否则 Free 计划的 10ms CPU
 * 会在长回答上超限，且客户端失去逐字输出。
 */
function streamResponse(
  upstreamBody: ReadableStream<Uint8Array>,
  hooks: { onFirstChunk: () => void; onError: (message: string) => void },
): Response {
  let notified = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()
      const reader = upstreamBody.getReader()
      let buffer = ''
      let sawChunk = false
      let sawDone = false

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          // ⚠️ `{stream:true}` 必需：多字节字符可能跨 chunk，否则解码出乱码
          buffer += decoder.decode(value, { stream: true })

          let nl = buffer.indexOf('\n')
          while (nl >= 0) {
            const line = buffer.slice(0, nl)
            buffer = buffer.slice(nl + 1)
            const frame = parseSseLine(line)

            if (frame.kind === 'done') {
              sawDone = true
              controller.enqueue(encoder.encode(doneFrame()))
            } else if (frame.kind === 'chunk' && frame.data !== undefined) {
              if (!notified) {
                notified = true
                hooks.onFirstChunk()
              }
              // 只在**可能**是错误帧时才解析（正常帧原样转发，省 CPU）
              if (frame.data.includes('"error"') || frame.data.includes('"statusCodeValue"') || frame.data.includes('"stackTrace"') || frame.data.includes('"code"')) {
                const errMsg = tryDetectError(frame.data)
                if (errMsg !== undefined) {
                  hooks.onError(errMsg)
                  controller.enqueue(encoder.encode(errorFrame(errMsg)))
                  nl = buffer.indexOf('\n')
                  continue
                }
              }
              sawChunk = true
              controller.enqueue(encoder.encode(translateFrame(frame.data)))
            } else if (frame.kind === 'error') {
              // ⚠️ 非预期形状必须让客户端看到（不静默丢）
              controller.enqueue(encoder.encode(errorFrame(frame.error ?? '非预期帧')))
            }
            nl = buffer.indexOf('\n')
          }
        }

        // 流结束但从未产生内容 → 明确报「疑似截断」，而不是假装模型没话说
        if (!sawChunk && !sawDone) {
          const msg = '上游流在产生任何内容前结束（疑似被截断）'
          hooks.onError(msg)
          controller.enqueue(encoder.encode(errorFrame(msg)))
        }
        if (!sawDone) controller.enqueue(encoder.encode(doneFrame()))
      } catch (error) {
        const msg = `流传输中断：${error instanceof Error ? error.message : String(error)}`
        hooks.onError(msg)
        controller.enqueue(encoder.encode(errorFrame(msg)))
        controller.enqueue(encoder.encode(doneFrame()))
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // 忽略
        }
        controller.close()
      }
    },
  })

  return new Response(stream, { status: 200, headers: sseHeaders() })
}

/** 尝试解析并识别错误帧（失败返回 undefined）。 */
function tryDetectError(data: string): string | undefined {
  try {
    const parsed = JSON.parse(data) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return detectErrorFrame(parsed as Record<string, unknown>)
  } catch {
    return `无法解析的上游帧：${data.slice(0, 160)}`
  }
}
