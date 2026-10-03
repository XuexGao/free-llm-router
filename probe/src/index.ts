/**
 * WorkBuddy 出口 IP / WAF 前置验证探针
 *
 * ## 为什么需要这个探针
 *
 * 设计文档 §2.6 标记了本项目**最高风险**：Go 参考实现（`workbuddy2api-panel`）在
 * `internal/server/wafip.go` 里记录了真实的 **IP 级 WAF 拦截** —— 60 秒内 2 个不同账号
 * 接连命中 403 即判定「出口 IP 被封」。Cloudflare Workers 从**共享 IP 段**出网，
 * 且 Free 计划**无法指定出口 IP**。
 *
 * ⇒ 若上游对 CF 网段有额外关照，整个项目在启动前就已不成立。
 * ⇒ 因此**先验证、再开发**。本探针就是那道闸门。
 *
 * ## 探针只做只读请求，不消耗任何配额
 *
 * 用的是**设备授权初始化**端点（`POST /v2/plugin/auth/state?platform=CLI`）：
 *   - 无需凭据、无需账号；
 *   - 只返回一个待授权的 state + authUrl，**不签发 token**、不写任何服务端状态；
 *   - 这正是本项目登录流程第一步要发的请求，故验证结果**可直接代表真实链路**。
 *
 * 另有两条**无凭据的只读**探测（billing / web 域），用于确认其它 host 是否也被拦。
 * 它们必然返回鉴权错误（我们没有 token）—— 但**「鉴权错误」与「WAF 拦截」是两种
 * 完全不同的信号**，正是要区分的。
 *
 * ## 判据（关键）
 *
 * | 形态 | 判定 |
 * |---|---|
 * | HTTP 200 + `{code:0,...}` | ✅ 通 |
 * | HTTP 4xx/5xx 但带 `{code,msg}` 业务信封 | ✅ 通（上游真的在应答，只是拒绝了我们） |
 * | HTTP 403 **且无业务信封**（HTML/空体/纯文本） | ❌ **WAF 拦截** —— 项目不可行 |
 * | 网络层错误（连接重置/DNS/TLS） | ⚠️ 不确定，需重试判断 |
 *
 * 第 3 行是 Go 侧 `ErrWafBlock` 的判据，本探针严格照抄。
 *
 * ## 用法
 *
 *   GET /                → 说明
 *   GET /probe           → 跑一轮全部目标（默认 3 次，串行，带间隔）
 *   GET /probe?rounds=5  → 指定轮数（1-10）
 *   GET /probe?only=cn   → 只测 CN chat 域
 */

/** 与 Go 侧 `clientUA` / 官方客户端一致的 UA（`internal/upstream/headers.go:61-67`）。 */
const CLIENT_UA = 'WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1'

/** 设备授权初始化端点（只读、零配额、无需凭据）。 */
const CN_BASE = 'https://copilot.tencent.com'
const BILLING_BASE = 'https://www.codebuddy.cn'
const WEB_BASE = 'https://www.workbuddy.cn'

/** 单个探测的超时。上游实测数百毫秒到 10s（国际版曾达 7.5s）。 */
const PROBE_TIMEOUT_MS = 15_000

/** 轮次之间的间隔：串行 + 间隔，避免本探针自己触发风控。 */
const ROUND_GAP_MS = 1_200

/**
 * 探测目标。
 *
 * `expectEnvelope` 表示「预期上游会返回业务信封」——用于把
 * 「上游拒绝我们」与「WAF 拦我们」区分开。
 */
interface ProbeTarget {
  id: string
  label: string
  url: string
  method: 'GET' | 'POST'
  base: string
  body?: string
  /** 是否需要凭据（负向探针用 false，其 401/403 属预期）。 */
  needsAuth: boolean
}

const TARGETS: ProbeTarget[] = [
  {
    id: 'cn-auth-state',
    label: 'CN 设备授权初始化（本项目登录第一步，零配额）',
    url: `${CN_BASE}/v2/plugin/auth/state?platform=CLI`,
    method: 'POST',
    base: CN_BASE,
    body: JSON.stringify({}),
    needsAuth: false,
  },
  {
    id: 'cn-billing',
    label: 'CN billing 域只读探测（无凭据，预期返回鉴权错误）',
    url: `${BILLING_BASE}/v2/billing/meter/get-user-resource`,
    method: 'POST',
    base: BILLING_BASE,
    body: JSON.stringify({}),
    needsAuth: true,
  },
  {
    id: 'cn-web',
    label: 'CN web 域只读探测（领奖权威域，无凭据 ⇒ 预期鉴权拒绝）',
    // GET /console/account 是 web 域的**只读**资料接口（Go 侧 FetchAccountProfile 用它）。
    // ⚠️ 刻意不用领奖端点：那是写操作，即便无凭据也不该由探针去打。
    url: `${WEB_BASE}/console/account`,
    method: 'GET',
    base: WEB_BASE,
    needsAuth: true,
  },
]

/**
 * 各 host 对应的 Origin/Referer 基础域。
 *
 * ⚠️ 必须与 Go 侧一致：CN chat 域的出站 Origin 是**登录站** `www.codebuddy.cn`
 * （`internal/panel/login.go` 的 originRefererCN），而不是请求 host 本身；
 * web 域则用自己的域。搞错会让风控看到不一致的跨域组合。
 */
const ORIGIN_BY_BASE: Record<string, string> = {
  [CN_BASE]: 'https://www.codebuddy.cn',
  [BILLING_BASE]: 'https://www.codebuddy.cn',
  [WEB_BASE]: 'https://www.workbuddy.cn',
}

/**
 * 构造与 Go 实现一致的出站头（`internal/panel/login.go:54-64` 的 commonHeaders）。
 *
 * ⚠️ 必须**逐字对齐**：风控按头族识别客户端，少了 `X-Requested-With` 或 Origin
 * 都可能得到与生产不同的结果，那这个探针就失去意义了。
 */
function buildHeaders(base: string): Record<string, string> {
  const origin = ORIGIN_BY_BASE[base] ?? 'https://www.codebuddy.cn'
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': CLIENT_UA,
  }
}

type Verdict = 'ok' | 'auth_rejected' | 'waf_blocked' | 'network_error' | 'unexpected'

interface ProbeAttempt {
  round: number
  httpStatus: number | null
  verdict: Verdict
  /** 上游业务码（能解析出信封时才有）。 */
  code: number | null
  msg: string | null
  /** 响应体片段（截断，便于人工判断）。 */
  snippet: string
  contentType: string | null
  cfRay: string | null
  elapsedMs: number
  error?: string
}

interface ProbeResult {
  target: ProbeTarget
  ip: string | null
  attempts: ProbeAttempt[]
  summary: {
    ok: number
    auth_rejected: number
    waf_blocked: number
    network_error: number
    unexpected: number
  }
  /** 该目标的最终判定。 */
  verdict: Verdict
}

/** 解析 `{code,msg,data}` 信封；解析不出返回 null（= 非业务响应，可能被 WAF 拦）。 */
function parseEnvelope(text: string): { code: number; msg: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const v = JSON.parse(trimmed) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const obj = v as Record<string, unknown>
    // 上游 code 恒为数字；宽松接受字符串数字。
    const rawCode = obj.code
    const code = typeof rawCode === 'number' ? rawCode : typeof rawCode === 'string' ? Number(rawCode) : NaN
    if (!Number.isFinite(code)) return null
    return { code, msg: typeof obj.msg === 'string' ? obj.msg : '' }
  } catch {
    return null
  }
}

/**
 * 判定一次响应。
 *
 * 核心是那条**WAF 判据**：403 且**没有业务信封** ⇒ 拦在网关层，不是业务拒绝。
 * 这条直接对应 Go 的 `ErrWafBlock`；`needsAuth=false` 的目标更加明确——
 * 它本来就不需要凭据，任何 403 都只能是网关层拦的。
 */
function classify(target: ProbeTarget, status: number, text: string): { verdict: Verdict; code: number | null; msg: string | null } {
  const env = parseEnvelope(text)

  // WAF 判据最高优先级，与 Go 的 IsWafBlocked 逐字一致：
  // **403 且无业务信封**（APISIX 拦截页 HTML / 空体 / 纯文本）。
  // ⚠️ 只看 403：APISIX 对「缺凭据」回的是 401，那是正常的鉴权拒绝，不是 WAF。
  if (status === 403 && !env) {
    return { verdict: 'waf_blocked', code: null, msg: null }
  }

  // 带业务信封的 4xx：上游业务层在正常应答（如 11140 / 11128），属「通」。
  if (env && status >= 400) {
    return { verdict: 'auth_rejected', code: env.code, msg: env.msg }
  }

  // 裸 401/403（无信封）：APISIX 对缺 Authorization 的标准应答。
  // 本探针的负向目标**故意不带凭据**，故这是预期结果，不是异常。
  if ((status === 401 || status === 403) && !env) {
    return { verdict: target.needsAuth ? 'auth_rejected' : 'waf_blocked', code: null, msg: null }
  }

  // 3xx（`redirect: 'manual'` 下可见）：实测 `www.workbuddy.cn/console/account`
  // 对未授权请求回 **302 Found**（跳登录页）而非 401。对需要凭据的目标这是正常的
  // 鉴权拒绝；对无需凭据的目标则说明被网关改写了路径，值得警惕。
  if (status >= 300 && status < 400 && !env) {
    return { verdict: target.needsAuth ? 'auth_rejected' : 'unexpected', code: null, msg: null }
  }

  if (env) {
    if (env.code === 0) return { verdict: 'ok', code: 0, msg: env.msg }
    // 有业务信封但 code != 0：上游在正常应答，只是拒绝。无凭据探针的预期结果。
    return { verdict: target.needsAuth ? 'auth_rejected' : 'ok', code: env.code, msg: env.msg }
  }

  if (status >= 200 && status < 300) {
    // 2xx 但没有信封：本项目登录端点正常应返回 data 信封，故标为 unexpected 供人工看。
    return { verdict: 'unexpected', code: null, msg: null }
  }

  return { verdict: 'unexpected', code: null, msg: null }
}

async function probeOnce(target: ProbeTarget, round: number, ip: string | null): Promise<ProbeAttempt> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

  try {
    const res = await fetch(target.url, {
      method: target.method,
      headers: buildHeaders(target.base),
      body: target.method === 'POST' ? (target.body ?? '') : undefined,
      signal: controller.signal,
      // 不跟随重定向：重定向本身可能就是风控行为，需要看见它。
      redirect: 'manual',
    })

    const text = await res.text()
    const { verdict, code, msg } = classify(target, res.status, text)

    return {
      round,
      httpStatus: res.status,
      verdict,
      code,
      msg,
      snippet: text.slice(0, 300),
      contentType: res.headers.get('content-type'),
      cfRay: res.headers.get('cf-ray'),
      elapsedMs: Date.now() - started,
    }
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return {
      round,
      httpStatus: null,
      verdict: 'network_error',
      code: null,
      msg: null,
      snippet: '',
      contentType: null,
      cfRay: null,
      elapsedMs: Date.now() - started,
      error: message,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 查 Cloudflare 出口 IP（`cdn-cgi/trace` 的 `ip=` 行）。 */
async function resolveEgressIp(): Promise<string | null> {
  try {
    const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
      signal: AbortSignal.timeout(5_000),
    })
    const text = await res.text()
    const line = text.split('\n').find((l) => l.startsWith('ip='))
    return line ? line.slice(3).trim() : null
  } catch {
    return null
  }
}

/** 汇总一个目标的多轮结果。任一 round 被 WAF 拦即判该目标 waf_blocked。 */
function summarize(target: ProbeTarget, attempts: ProbeAttempt[], ip: string | null): ProbeResult {
  const summary = { ok: 0, auth_rejected: 0, waf_blocked: 0, network_error: 0, unexpected: 0 }
  for (const a of attempts) summary[a.verdict] += 1

  // WAF 优先：一发即中比网络抖动的解释更强，故最高优先级。
  let verdict: Verdict = 'unexpected'
  if (summary.waf_blocked > 0) verdict = 'waf_blocked'
  else if (summary.ok > 0) verdict = 'ok'
  else if (summary.auth_rejected > 0) verdict = 'auth_rejected'
  else if (summary.network_error === attempts.length) verdict = 'network_error'

  return { target, ip, attempts, summary, verdict }
}

const VERDICT_LABEL: Record<Verdict, string> = {
  ok: '✅ 通',
  auth_rejected: '✅ 通（上游正常拒绝，非 WAF）',
  waf_blocked: '❌ WAF 拦截',
  network_error: '⚠️ 网络层错误',
  unexpected: '⚠️ 未预期响应',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runProbes(rounds: number, only: string | null): Promise<{
  egressIp: string | null
  ranAt: string
  results: ProbeResult[]
  conclusion: string
}> {
  const egressIp = await resolveEgressIp()
  const targets = only ? TARGETS.filter((t) => t.id === only) : TARGETS
  const results: ProbeResult[] = []

  for (const target of targets) {
    const attempts: ProbeAttempt[] = []
    for (let round = 1; round <= rounds; round += 1) {
      attempts.push(await probeOnce(target, round, egressIp))
      if (round < rounds) await sleep(ROUND_GAP_MS)
    }
    results.push(summarize(target, attempts, egressIp))
  }

  const blocked = results.filter((r) => r.verdict === 'waf_blocked')
  const ok = results.filter((r) => r.verdict === 'ok' || r.verdict === 'auth_rejected')

  let conclusion: string
  if (blocked.length > 0) {
    conclusion =
      `❌ 判定：不可行。${blocked.map((b) => b.target.id).join(', ')} 被 WAF 拦截（403 且无业务信封）。` +
      '按设计文档 §9 第 1 步，停止开发并回退到路径①（Go + Fly.io 静态出口 IP）。'
  } else if (ok.length === results.length) {
    conclusion = '✅ 判定：可行。全部目标均得到上游正常响应，未检出 WAF 拦截。可以进入第 2 步（骨架）。'
  } else {
    conclusion = '⚠️ 判定：不确定。存在未预期响应或网络层错误，请人工查看各轮明细后重跑（可提高 rounds）。'
  }

  return { egressIp, ranAt: new Date().toISOString(), results, conclusion }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/' ) {
      return json({
        name: 'workbuddy-egress-probe',
        purpose: 'WorkBuddy 出口 IP / WAF 前置验证（只读、零配额）',
        usage: {
          'GET /probe': '跑一轮全部目标（默认 3 轮，串行 + 1.2s 间隔）',
          'GET /probe?rounds=5': '指定轮数（1-10）',
          'GET /probe?only=cn-auth-state': `只测单一目标。可选：${TARGETS.map((t) => t.id).join(' / ')}`,
        },
        targets: TARGETS.map((t) => ({ id: t.id, label: t.label, url: t.url, method: t.method })),
      })
    }

    if (url.pathname === '/probe') {
      const rawRounds = url.searchParams.get('rounds')
      const parsed = rawRounds === null ? 3 : Number.parseInt(rawRounds, 10)
      // 上限 10：探针本身也可能触发风控，别把自己变成攻击源。
      const rounds = Number.isInteger(parsed) && parsed >= 1 && parsed <= 10 ? parsed : 3
      const only = url.searchParams.get('only')
      if (only !== null && !TARGETS.some((t) => t.id === only)) {
        return json({ error: `unknown target: ${only}`, valid: TARGETS.map((t) => t.id) }, 400)
      }

      const result = await runProbes(rounds, only)
      return json({ ...result, rounds, verdictLabels: VERDICT_LABEL })
    }

    return json({ error: 'not found', see: 'GET /' }, 404)
  },
}
