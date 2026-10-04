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
import { DEFAULT_PROVIDER, findProvider, providerIds } from '../providers/index.js'
import { splitModelName, type ProviderCredential } from '../providers/types.js'
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
  provider: string,
): Promise<Candidate | undefined> {
  const result = await pool.pick({ realm, provider, model, exclude, now })
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
  /**
   * ExecutionContext（可选，便于单测）。
   *
   * ⚠️ 用途是 `waitUntil`：把「流结束后才发生的记账」托住，
   * 否则响应一结束 Worker 就会取消它。
   */
  ctx?: ExecutionContext,
): Promise<GatewayResult> {
  // ① 解析并准备请求体（一次性，不随换号重复）
  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return { response: jsonError(400, '请求体必须是合法 JSON', 'invalid_request_error') }
  }

  const rawModel =
    typeof (rawBody as Record<string, unknown>).model === 'string'
      ? ((rawBody as Record<string, unknown>).model as string)
      : ''

  // ⚠️ 多供应商路由：`provider/model` 前缀决定去哪家。
  // 无前缀时回落到默认供应商（保持既有用户兼容 —— 他们已经在用裸模型名）。
  const routed = splitModelName(rawModel, providerIds(), DEFAULT_PROVIDER)
  const providerId = routed.provider
  const model = routed.model

  // 非 WorkBuddy 的供应商走独立的 Provider 接口（协议差异极大，
  // 不能把分支塞进下面这段 WorkBuddy 专用逻辑里）。
  if (providerId !== DEFAULT_PROVIDER) {
    return await handleProviderChat({ providerId, model, rawBody, request, env, realm, ctx, tried: [] })
  }

  // ⚠️ **必须把请求体里的 model 改写成去前缀的裸名**（实测踩到的真实缺陷，
  // 且必须在 `prepareChatBody` **之前**做 —— 它会连 `model` 一起复制）。
  //
  // 客户端发 `workbuddy/deepseek-v4-flash` 时，若不改写，上游收到带前缀的名字，
  // 回应：`model [workbuddy/deepseek-v4-flash] service info not found`。
  //
  // 后果比「报错」严重得多：该错误被归类为 `model_unavailable`（11102），
  // 于是**给这个模型写了 6 小时的模型级冷却** —— 一个纯粹由我方前缀引起的
  // 失败，被记成了「上游没有这个模型」。此后所有**裸名**请求都会因为这个
  // 冷却而选不到号，对外表现为「没有可用账号」，与真实原因毫无关系。
  //
  // 故这是「一个前缀写错 → 整个模型被拉黑 6 小时」的放大器，必须在这里切断。
  const upstreamBody =
    model !== rawModel && rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? { ...(rawBody as Record<string, unknown>), model }
      : rawBody

  let prepared: string
  try {
    prepared = sanitizeChatBody(prepareChatBody(upstreamBody).body)
  } catch (error) {
    return {
      response: jsonError(400, error instanceof Error ? error.message : String(error), 'invalid_request_error'),
    }
  }

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
    // ⚠️ 限定默认供应商：池里可能同时有 cline 等家的账号，
    // 拿它们的凭据去打 WorkBuddy 端点必然 401（看起来像「凭据坏了」）。
    const candidate = await pickCandidate(pool, realm, model, tried, now, DEFAULT_PROVIDER)
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

    const startedAt = Date.now()
    return {
      response: streamResponse(upstream.body, {
        onFirstChunk: () => {
          // 首帧到达即算成功（清熔断/降权）
          const okTask = pool.noteSuccess(candidate.uid, Date.now()).catch(() => {})
          if (ctx !== undefined) ctx.waitUntil(okTask)
          else void okTask
        },
        onFinish: (usage) => {
          // 记账用量（面板的「用量」视图靠它）
          //
          // ⚠️ 这里**不能**静默吞错误：第一版写成 `.catch(() => {})`，
          // 结果线上「对话成功但用量恒为 0」，且没有任何日志可查
          // （正是本项目一直在警告的「静默失败」形态）。
          const record = {
            at: Date.now(),
            uid: candidate.uid,
            model,
            input: usage?.input ?? 0,
            output: usage?.output ?? 0,
            ok: true,
            ms: Date.now() - startedAt,
          }
          const task = pool.recordUsage(record).catch((error: unknown) => {
            console.error(
              '[usage] 记录用量失败：',
              error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            )
          })
          // ⚠️ 必须 waitUntil：否则响应流结束的瞬间这个 promise 会被取消
          if (ctx !== undefined) ctx.waitUntil(task)
          else void task
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
  hooks: {
    onFirstChunk: () => void
    onError: (message: string) => void
    /** 流结束时回调，带上从流里解析到的 usage（用于面板用量统计）。 */
    onFinish?: (usage: { input: number; output: number } | undefined) => void
  },
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
      // 从流里抓 usage（末帧带 include_usage=true 时会有）
      let usage: { input: number; output: number } | undefined

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
              // 只在字面量含 usage 时才解析（省 CPU）
              if (frame.data.includes('"usage"')) {
                try {
                  const parsed = JSON.parse(frame.data) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
                  const u = parsed.usage
                  if (u !== undefined && typeof u.prompt_tokens === 'number') {
                    usage = { input: u.prompt_tokens, output: u.completion_tokens ?? 0 }
                  }
                } catch {
                  // usage 解析失败不影响转发
                }
              }
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
        hooks.onFinish?.(usage)
      } catch (error) {
        const msg = `流传输中断：${error instanceof Error ? error.message : String(error)}`
        hooks.onError(msg)
        hooks.onFinish?.(undefined)
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


/**
 * 非 WorkBuddy 供应商的对话处理。
 *
 * ## 为什么要单独一条路径，而不是复用上面那段
 *
 * 上面那段是 **WorkBuddy 专用**的：它依赖 `/v2/chat/completions` 这个固定路径、
 * 四套客户端指纹、`prepareChatBody` 的 4 处必改、以及 WorkBuddy 特有的错误码表。
 * 把这些塞进一个「通用」循环里，只会让 WorkBuddy 的逻辑被稀释、
 * 而其它供应商仍要写一堆 `if (provider === ...)`。
 *
 * ⇒ 供应商差异**全部**收敛到 `Provider` 接口（见 `src/providers/types.ts`），
 * 这里只做「选号 → 调接口 → 记账 → 换号」这件与供应商无关的事。
 */
async function handleProviderChat(input: {
  providerId: string
  model: string
  rawBody: unknown
  request: Request
  env: Env
  realm: string
  ctx?: ExecutionContext
  tried: string[]
}): Promise<GatewayResult> {
  const { providerId, model, rawBody, request, env, realm, ctx } = input

  const provider = findProvider(providerId)
  if (provider === undefined) {
    return { response: jsonError(404, `未知供应商「${providerId}」`, 'unknown_provider') }
  }
  if (!provider.capabilities.chat) {
    // ⚠️ 显式说明**为什么**不可用，而不是笼统报错
    return {
      response: jsonError(
        501,
        `供应商「${provider.name}」当前不支持对话。` +
          (provider.capabilities.loginBlockedReason ?? ''),
        'provider_chat_unsupported',
      ),
    }
  }

  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
  // ⚠️ 与 WorkBuddy 路径同理：请求体里的 `model` 必须换成**去前缀**的裸名。
  // 各 provider 的 `chat()` 会把它直接放进上游请求，带前缀会被上游判为
  // 「没有这个模型」—— 而这个错误又会被记成模型级冷却（见上面的长注释）。
  const body =
    rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? { ...(rawBody as Record<string, unknown>), model }
      : (rawBody as Record<string, unknown>)
  const tried = input.tried
  let lastError: { status: number; message: string } | undefined

  for (let attempt = 0; attempt <= MAX_ROTATE; attempt += 1) {
    const now = Date.now()
    // ⚠️ 供应商过滤交给 `pick()` 做（`provider` 字段），
    // **不要**在这里「先选中再筛掉」—— 那会让「池里有账号但当前供应商没账号」
    // 表现为「pick 返回了号、却被我丢掉」，最终误报「没有可用账号」（实测踩到）。
    const picked = await pool.pick({ realm, provider: providerId, model, exclude: tried, now })
    if (picked === undefined) break
    tried.push(picked.uid)

    const credential = (await pool.getCredential(picked.uid)) as ProviderCredential | undefined
    if (credential === undefined) {
      lastError = { status: 500, message: '账号缺少凭据' }
      continue
    }

    const startedAt = Date.now()
    // ⚠️ 续期只试一次（见下方 401 分支的说明）。
    let refreshed = false
    let upstream: Response
    try {
      upstream = await provider.chat(credential, { model, body, signal: request.signal })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lastError = { status: 502, message }
      // 传输层失败：换号可能有用（也可能是本地出口抖动）
      continue
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')

      // ⚠️ **401/403 先尝试续期，而不是直接判失败**（实测踩到）。
      //
      // 上游令牌都有寿命（实测本地凭据过期 5–7 小时），过期后所有请求 401。
      // 若不续期，账号用一天就废；而用户看到的是「凭据坏了」，
      // 完全想不到「只是该续期了」。
      //
      // 只试**一次**（`refreshed` 标记）：续期后仍 401 说明 refresh token 也废了，
      // 再试只是无谓地打上游。
      if ((upstream.status === 401 || upstream.status === 403) && provider.refresh !== undefined && !refreshed) {
        try {
          refreshed = true
          const fresh = await provider.refresh(credential, AbortSignal.timeout(30_000))
          await pool.putCredential(picked.uid, fresh, Date.now())
          // ⚠️ 重放请求（用新凭据）。这里直接用 continue 会重新选号，
          // 但我们要的是**同一个号**换新令牌重试 —— 故显式再发一次。
          const retry = await provider.chat(fresh, { model, body, signal: request.signal })
          if (retry.ok && retry.body !== null) {
            const startedAt2 = Date.now()
            return {
              response: streamResponse(retry.body, {
                onFirstChunk: () => {
                  const t = pool.noteSuccess(picked.uid, Date.now()).catch(() => {})
                  if (ctx !== undefined) ctx.waitUntil(t)
                },
                onError: (message) => {
                  const t = pool
                    .applyFailure({ uid: picked.uid, kind: 'breaker', now: Date.now(), reason: message.slice(0, 200) })
                    .catch(() => {})
                  if (ctx !== undefined) ctx.waitUntil(t)
                },
                onFinish: (usage) => {
                  const t = pool
                    .recordUsage({
                      at: Date.now(), uid: picked.uid, model: `${providerId}/${model}`,
                      input: usage?.input ?? 0, output: usage?.output ?? 0, ok: true,
                      ms: Date.now() - startedAt2,
                    })
                    .catch(() => {})
                  if (ctx !== undefined) ctx.waitUntil(t)
                },
              }),
            }
          }
        } catch (error) {
          // 续期失败（refresh token 也废了）→ 落回正常失败路径，
          // 并把这个号标成需要重新登录（软冷却，避免每请求都试一次续期）。
          console.error(
            `[refresh] ${providerId} 续期失败：`,
            error instanceof Error ? error.message : String(error),
          )
        }
      }

      const rotate = provider.shouldRotate?.(upstream.status, text) ?? (upstream.status === 429 || upstream.status === 402)
      await pool
        .applyFailure({
          uid: picked.uid,
          kind: upstream.status === 429 ? 'soft' : upstream.status === 402 ? 'hard' : 'breaker',
          now: Date.now(),
          ...(model !== '' ? { model } : {}),
          reason: `${providerId} http=${upstream.status}: ${text.slice(0, 160)}`,
        })
        .catch(() => {})
      lastError = { status: upstream.status >= 500 ? 502 : upstream.status, message: text.slice(0, 300) || `http=${upstream.status}` }
      if (!rotate) break
      continue
    }

    if (upstream.body === null) {
      lastError = { status: 502, message: '上游返回空 body' }
      continue
    }

    return {
      response: streamResponse(upstream.body, {
        onFirstChunk: () => {
          const t = pool.noteSuccess(picked.uid, Date.now()).catch(() => {})
          if (ctx !== undefined) ctx.waitUntil(t)
        },
        onError: (message) => {
          const t = pool
            .applyFailure({ uid: picked.uid, kind: 'breaker', now: Date.now(), reason: message.slice(0, 200) })
            .catch(() => {})
          if (ctx !== undefined) ctx.waitUntil(t)
        },
        onFinish: (usage) => {
          const record = {
            at: Date.now(),
            uid: picked.uid,
            // ⚠️ 用量里记**带前缀**的模型名：否则多供应商下的同名模型会混在一起
            model: `${providerId}/${model}`,
            input: usage?.input ?? 0,
            output: usage?.output ?? 0,
            ok: true,
            ms: Date.now() - startedAt,
          }
          const t = pool.recordUsage(record).catch((error: unknown) => {
            console.error('[usage] 记录用量失败：', error instanceof Error ? error.message : String(error))
          })
          if (ctx !== undefined) ctx.waitUntil(t)
          else void t
        },
      }),
    }
  }

  return {
    response: jsonError(
      lastError?.status ?? 503,
      lastError === undefined
        ? `供应商「${provider.name}」没有可用账号（请先在面板导入该供应商的凭据）`
        : `供应商「${provider.name}」请求失败：${lastError.message}`,
      'provider_error',
    ),
  }
}
