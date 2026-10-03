/**
 * Worker 入口：路由 + 鉴权 + Cron 扇出。
 *
 * ## 职责边界（重要）
 *
 * 这里**只做三件事**：
 * 1. 路由与鉴权；
 * 2. 把状态操作**转发**给 DO（账号池 / 任务执行器）；
 * 3. Cron 触发时**只负责扇出**（唤起各账号的 TaskRunner DO），**不做实际任务工作**。
 *
 * ⚠️ 第 3 条是硬纪律：Free 计划 Cron 只有 **10ms CPU**
 * （AGENTS.md §8.2.1），在这里做任何实际工作都会超限。
 *
 * ## 为什么上游请求不放在 DO 里
 *
 * DO 的每次调用都消耗 10ms CPU 预算。把上游 fetch 放进 DO 会把
 * 「I/O 等待」与「状态修改」耦合，破坏「一次调用 = 一步」的纪律。
 * 故：**Worker 发起上游请求，DO 只管状态**。
 */

import { TaskRunnerDO, type RunContext, type TaskStep } from './taskrunner/TaskRunnerDO.js'
import { AccountPoolDO } from './pool/AccountPoolDO.js'
import { planByName } from './taskrunner/plans.js'
import { resolveUpstream, type Env } from './env.js'
import { cliChatHeaders } from './upstream/headers.js'
import { isValidUid, LOGIN_STATE_TTL_MS, pollLogin, startLogin } from './upstream/auth.js'
import type { LoginCredential } from './upstream/auth.js'
import { parseAuthDocument, parseAuthPayload } from './upstream/import.js'
import { handleChatCompletions } from './gateway/server.js'
import { listModels, pickCredential } from './gateway/models.js'
import { jsonError } from './gateway/http.js'
import { panelAsset, securityHeaders } from './panel/index.js'

// DO 类必须从入口导出，否则 wrangler 找不到绑定目标。
export { AccountPoolDO, TaskRunnerDO }

/** JSON 响应助手，统一 no-store（避免缓存鉴权结果）。 */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * 常量时间字符串比较。
 *
 * ⚠️ 用摘要 + `timingSafeEqual` 而不是 `===`：`===` 会在首个不同字节处短路，
 * 泄漏「已匹配多少前缀」的时序信息，足以逐字节爆破密钥
 * （Go 侧 `internal/httpauth` 同口径，连缺头也走一次比较以保持耗时形状）。
 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  // 先各自摘要成定长，避免「长度不同」本身泄漏信息
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ])
  const va = new Uint8Array(ha)
  const vb = new Uint8Array(hb)
  let diff = 0
  for (let i = 0; i < va.length; i += 1) diff |= (va[i] ?? 0) ^ (vb[i] ?? 0)
  return diff === 0
}

/** 校验 Bearer 密钥。未配置 `API_KEY` 时**拒绝一切**（fail-closed，不 fail-open）。 */
async function authorized(request: Request, env: Env): Promise<boolean> {
  const expected = env.API_KEY
  // ⚠️ fail-closed：没配密钥就是配置错误，不能静默放行。
  if (expected === undefined || expected === '') return false

  const header = request.headers.get('authorization') ?? ''
  const prefix = 'Bearer '
  const provided = header.startsWith(prefix) ? header.slice(prefix.length) : ''
  // 即使 provided 为空也执行比较，保持耗时形状
  return await constantTimeEqual(provided, expected)
}

/** 路由处理。 */
async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname

  // ── 免鉴权：存活探针（不含任何敏感信息） ──
  if (path === '/healthz') {
    return json({ ok: true, service: 'workbuddy-serverless' })
  }

  // ── 管理面板静态资源（**免鉴权**，但统统加安全响应头） ──
  // ⚠️ 为什么页面可以免鉴权：它不含任何敏感信息（不知道有哪些账号、也不知道 token）。
  // 真正的数据都在 /admin/* 与 /v1/* 后面，一律要 Bearer 密钥。
  // 页面把口令存 localStorage、每个请求带 Authorization 头 ——
  // 刻意不用 cookie（cookie 会自动附带，需要额外 CSRF 防护；Authorization 头不会）。
  const asset = panelAsset(path)
  if (asset !== undefined) {
    return new Response(asset.body, {
      status: 200,
      headers: { ...securityHeaders(), 'content-type': asset.contentType },
    })
  }

  // 老的 /panel 前缀（无尾斜杠）重定向到带斜杠，避免相对路径解析错误
  if (path === '/panel') {
    return new Response(null, { status: 302, headers: { location: '/panel/' } })
  }

  // ── 其余一律鉴权 ──
  if (!(await authorized(request, env))) {
    return json({ error: { message: 'Missing or invalid API key', type: 'authentication_error' } }, 401)
  }

  // ── 登录：发起（返回授权 URL 给前端/用户） ──
  if (path === '/admin/login/start' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { realm?: string }
    const realm = body.realm ?? 'cn'
    const bases = resolveUpstream(env)
    try {
      const { state, authUrl } = await startLogin({ chatBase: bases.chat, realm })
      const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
      await pool.saveLoginSession(state, { realm, createdAt: Date.now() }, Date.now() + LOGIN_STATE_TTL_MS)
      return json({ ok: true, state, authUrl, realm, expiresInMs: LOGIN_STATE_TTL_MS })
    } catch (error) {
      return json(
        { error: { message: error instanceof Error ? error.message : String(error), type: 'login_start_failed' } },
        502,
      )
    }
  }

  // ── 登录：轮询（用户完成授权后返回凭据并落盘加密） ──
  if (path === '/admin/login/poll' && request.method === 'GET') {
    const state = url.searchParams.get('state')
    if (state === null || state === '') return json({ error: { message: 'state 必填' } }, 400)

    const now = Date.now()
    // 会话存在哪个 realm 的分片里：先试 cn，再试 global。
    // ⚠️ 这是刻意的简化：两个 realm 各查一次比维护一张全局索引表便宜，
    // 且账号数少（1–3 个）时开销可忽略。
    for (const realm of ['cn', 'global']) {
      const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
      const session = (await pool.getLoginSession(state, now)) as { realm: string; createdAt: number } | undefined
      if (session === undefined) continue

      const bases = resolveUpstream(env)
      let credential
      try {
        credential = await pollLogin({ chatBase: bases.chat, realm: session.realm, state })
      } catch (error) {
        return json(
          { error: { message: error instanceof Error ? error.message : String(error), type: 'login_poll_failed' } },
          502,
        )
      }

      // 还没完成授权：不是错误，继续轮询
      if (credential === undefined) return json({ done: false, message: '等待授权中' })

      // 安全边界：uid 会被用作 storage key，必须校验
      if (!isValidUid(credential.uid)) {
        return json(
          { error: { message: '上游返回的 uid 含非法字符，已拒绝入库', type: 'invalid_uid' } },
          502,
        )
      }

      // 落盘：先建账号条目（清掉旧号遗留的惩罚态），再加密存凭据
      await pool.createAccount(
        { uid: credential.uid, nickname: credential.nickname, realm: session.realm },
        now,
      )
      await pool.revive(credential.uid, now) // 全新登录 = 人工恢复口径
      await pool.putCredential(credential.uid, credential, now)
      await pool.removeLoginSession(state)

      // ⚠️ 只回非敏感字段：**绝不回 token**
      return json({
        done: true,
        uid: credential.uid,
        nickname: credential.nickname,
        realm: session.realm,
        encrypted: true,
      })
    }

    return json({ error: { message: 'unknown or expired state（请重新发起登录）', type: 'unknown_state' } }, 404)
  }

  // ── 删除账号（连带凭据；不可逆，故要求显式确认字段） ──
  if (path === '/admin/accounts/remove' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { uid?: string; realm?: string; confirm?: boolean }
    if (typeof body.uid !== 'string' || body.uid === '') {
      return json({ error: { message: 'uid 必填' } }, 400)
    }
    // ⚠️ 删除不可逆，要求显式 confirm —— 防手滑把账号删了
    if (body.confirm !== true) {
      return json(
        { error: { message: '删除不可逆，需在请求体里带 "confirm": true', type: 'confirm_required' } },
        400,
      )
    }
    const realm = body.realm ?? 'cn'
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    await pool.removeCredential(body.uid)
    await pool.removeAccount(body.uid)
    return json({ ok: true, removed: body.uid, realm })
  }

  // ── IP 级 WAF 护栏状态（面板要能看出「是不是 IP 被拦了」） ──
  if (path === '/admin/waf' && request.method === 'GET') {
    const realm = url.searchParams.get('realm') ?? 'cn'
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const status = await pool.wafGateStatus(Date.now())
    return json({ realm, ...status, windowMs: 60_000, threshold: 2 })
  }

  // ── 人工解除 IP 级拦截 ──
  // ⚠️ gate 是**保守的推测**（也可能是账号级问题被误判）。必须留人工纠正入口，
  // 否则用户只能干等 60 秒（或误以为服务坏了）。
  if (path === '/admin/waf/clear' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { realm?: string }
    const realm = body.realm ?? 'cn'
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    await pool.clearWafGate()
    return json({ ok: true, realm, note: '已解除 IP 级拦截（若实际是账号级问题，相关账号仍处于各自的冷却中）' })
  }

  // ── 账号导入（兼容 Go 的 auths/*.json 双形态） ──
  if (path === '/admin/import' && request.method === 'POST') {
    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return json({ error: { message: '请求体必须是合法 JSON', type: 'invalid_json' } }, 400)
    }

    let entries: Array<{ raw: unknown; source?: string }>
    try {
      entries = parseAuthPayload(payload)
    } catch (error) {
      return json(
        { error: { message: error instanceof Error ? error.message : String(error), type: 'invalid_payload' } },
        400,
      )
    }

    const now = Date.now()
    const imported: Array<{ uid: string; nickname: string; realm: string; expiresAt: number }> = []
    const skipped: Array<{ reason: string; source?: string }> = []

    for (const entry of entries) {
      // 逐条独立：单条坏文件不应影响其他条
      let credential: LoginCredential
      try {
        credential = parseAuthDocument(entry.raw, entry.source)
      } catch (error) {
        skipped.push({
          reason: error instanceof Error ? error.message : String(error),
          ...(entry.source === undefined ? {} : { source: entry.source }),
        })
        continue
      }

      // 安全边界：uid 会被用作 storage key
      if (!isValidUid(credential.uid)) {
        skipped.push({
          reason: `uid 含非法字符，已拒绝：${credential.uid.slice(0, 32)}`,
          ...(entry.source === undefined ? {} : { source: entry.source }),
        })
        continue
      }

      const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(credential.realm))
      try {
        await pool.createAccount(
          { uid: credential.uid, nickname: credential.nickname, realm: credential.realm },
          now,
        )
        await pool.revive(credential.uid, now)
        await pool.putCredential(credential.uid, credential, now)
      } catch (error) {
        // 典型：未配置 CREDENTIAL_KEY → 明确报错而不是静默明文落盘
        skipped.push({
          reason: error instanceof Error ? error.message : String(error),
          ...(entry.source === undefined ? {} : { source: entry.source }),
        })
        continue
      }

      imported.push({
        uid: credential.uid,
        nickname: credential.nickname,
        realm: credential.realm,
        expiresAt: credential.expiresAt,
      })
    }

    // ⚠️ 只回 uid/nickname 等非敏感字段，**绝不回 token**
    return json({ ok: imported.length > 0, imported, skipped })
  }

  // ── 凭据状态（**不回 token**，只回是否已存 + 脱敏提示） ──
  if (path === '/admin/credentials' && request.method === 'GET') {
    const realm = url.searchParams.get('realm') ?? 'cn'
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const uids = await pool.listCredentialUids()
    return json({ realm, count: uids.length, uids })
  }

  // ── 账号池状态 ──
  if (path === '/admin/pool' && request.method === 'GET') {
    const realm = url.searchParams.get('realm') ?? 'cn'
    const stub = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const counts = await stub.counts(realm, Date.now())
    return json({ realm, counts })
  }

  // ── 账号列表 ──
  if (path === '/admin/accounts' && request.method === 'GET') {
    const realm = url.searchParams.get('realm') ?? 'cn'
    const stub = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const accounts = await stub.listAccounts(realm, Date.now())
    // ⚠️ 只回可展示字段，**绝不回凭据**
    return json({
      realm,
      accounts: accounts.map((a) => ({
        uid: a.uid,
        nickname: a.nickname,
        disabled: a.disabled,
        reason: a.reason,
        credits: a.credits,
        coolKind: a.coolKind,
        until: a.until,
        lastCheckinDay: a.lastCheckinDay,
        // ⚠️ 这几个字段是**验证记账是否发生**的唯一观测口。
        // 不暴露它们就无法确认「网关成功/失败后有没有真的更新池状态」——
        // 而记账失效是静默的（冷却/熔断形同虚设，但表面一切正常）。
        successCount: a.successCount,
        errTotal: a.errTotal,
        lastSuccess: a.lastSuccess,
        lastErr: a.lastErr,
        fails: a.fails,
        breakerUntil: a.breakerUntil,
        softStreak: a.softStreak,
        modelCooldowns: Object.keys(a.modelCooldowns),
      })),
    })
  }

  // ── 手动触发某账号的任务（调试/面板用） ──
  if (path === '/admin/tasks/run' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as {
      uid?: string
      realm?: string
      plan?: 'daily' | 'growth'
      includeRealChat?: boolean
    }
    if (typeof body.uid !== 'string' || body.uid === '') {
      return json({ error: { message: 'uid 必填' } }, 400)
    }
    const realm = body.realm ?? 'cn'
    const planName = body.plan ?? 'daily'

    // 取账号 + **解密凭据**（任务动作需要 accessToken，否则必然 401）
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const account = await pool.getAccount(body.uid)
    if (account === undefined) {
      return json({ error: { message: `账号不存在：${body.uid}` } }, 404)
    }

    const credential = (await pool.getCredential(body.uid)) as LoginCredential | undefined
    if (credential === undefined) {
      return json(
        { error: { message: `账号 ${body.uid} 没有凭据，请先通过 /admin/login/start 登录`, type: 'no_credential' } },
        409,
      )
    }

    const result = await startRun(env, {
      uid: account.uid,
      nickname: account.nickname,
      realm: account.realm,
      accessToken: credential.accessToken,
      plan: planName,
      ...(body.includeRealChat === undefined ? {} : { includeRealChat: body.includeRealChat }),
    })
    return json(result)
  }

  // ── 任务运行状态查询 ──
  if (path === '/admin/tasks/status' && request.method === 'GET') {
    const uid = url.searchParams.get('uid')
    if (uid === null || uid === '') return json({ error: { message: 'uid 必填' } }, 400)
    const stub = env.TASK_RUNNER.get(env.TASK_RUNNER.idFromName(uid))
    const status = await stub.status(uid)
    return json({ uid, status: status ?? null })
  }

  // ── 把任务步骤入队并唤起 alarm（**Worker 只转发，不执行**） ──
  if (path === '/admin/tasks/start' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as {
      uid?: string
      realm?: string
      plan?: 'daily' | 'growth'
      includeRealChat?: boolean
    }
    if (typeof body.uid !== 'string' || body.uid === '') {
      return json({ error: { message: 'uid 必填' } }, 400)
    }
    const realm = body.realm ?? 'cn'
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const account = await pool.getAccount(body.uid)
    if (account === undefined) {
      return json({ error: { message: `账号不存在：${body.uid}` } }, 404)
    }
    const credential = (await pool.getCredential(body.uid)) as LoginCredential | undefined
    if (credential === undefined) {
      return json(
        { error: { message: `账号 ${body.uid} 没有凭据，请先登录`, type: 'no_credential' } },
        409,
      )
    }
    const result = await startRun(env, {
      uid: body.uid,
      nickname: account.nickname,
      realm: account.realm,
      accessToken: credential.accessToken,
      plan: body.plan ?? 'daily',
      ...(body.includeRealChat === undefined ? {} : { includeRealChat: body.includeRealChat }),
    })
    return json(result)
  }

  // ── OpenAI 兼容：模型列表 ──
  if (path === '/v1/models' && request.method === 'GET') {
    const realm = url.searchParams.get('realm') ?? 'cn'
    const picked = await pickCredential(env, realm)
    if (picked === undefined) {
      return jsonError(
        503,
        '没有可用账号（请先通过 /admin/login/start 登录或 /admin/import 导入凭据）',
        'no_available_account',
      )
    }
    try {
      const models = await listModels(
        { uid: picked.uid, accessToken: picked.credential.accessToken },
        env,
      )
      return json({ object: 'list', data: models })
    } catch (error) {
      return jsonError(
        502,
        `模型目录拉取失败：${error instanceof Error ? error.message : String(error)}`,
        'upstream_error',
      )
    }
  }

  // ── OpenAI 兼容：对话（**流式 SSE 透传**） ──
  if (path === '/v1/chat/completions' && request.method === 'POST') {
    const realm = url.searchParams.get('realm') ?? 'cn'
    const result = await handleChatCompletions(request, env, realm)
    // ⚠️ 流式响应必须**原样返回** —— 不要在这里包装或缓冲，
    // 那会破坏逐字输出并可能超出 CPU 预算。
    return result.response
  }

  return json({ error: { message: 'not found', path } }, 404)
}

/**
 * 把一次运行入队并唤起 alarm。
 *
 * ⚠️ 这里**不等待任务完成** —— 只做入队 + 排 alarm，立刻返回。
 * 实际执行发生在 TaskRunnerDO 的 `alarm()` 里（每次一步）。
 */
async function startRun(
  env: Env,
  input: {
    uid: string
    nickname: string
    realm: string
    accessToken: string
    plan: 'daily' | 'growth'
    /** ⚠️ 显式开启才会跑「需要真实对话」的任务（会消耗配额）。 */
    includeRealChat?: boolean
  },
): Promise<{ ok: boolean; queued: number; note?: string }> {
  const steps: TaskStep[] = planByName(input.plan, {
    ...(input.includeRealChat === undefined ? {} : { includeRealChat: input.includeRealChat }),
  })
  const context: RunContext = {
    uid: input.uid,
    nickname: input.nickname,
    realm: input.realm,
    accessToken: input.accessToken,
  }
  const stub = env.TASK_RUNNER.get(env.TASK_RUNNER.idFromName(input.uid))
  await stub.start(input.uid, steps, context, Date.now())
  return {
    ok: true,
    queued: steps.length,
    note: input.accessToken === '' ? '未提供 accessToken，需要凭据的动作会失败（凭据存储见第 4 步）' : undefined,
  }
}

/**
 * 任务时点表（UTC+8）。
 *
 * ⚠️ **为什么时点在代码里而不是 cron 表达式里**：账户 Free 计划的 cron 配额只有
 * **5 个**，实测已被其他 Worker 占去 4 个，本项目只能用 **1 个**（每小时触发）。
 * 因此用「每小时唤醒 + 按 UTC+8 小时分发」的形态。
 *
 * 时点沿用 Go 侧默认（`scheduler.go`）：签到 9/21、活跃上报 10。
 * 改时点只改这张表，**不需要重新部署 wrangler 配置**。
 */
const SCHEDULE_UTC8: Record<number, 'daily' | 'growth'> = {
  9: 'daily', // 签到
  10: 'growth', // 活跃上报 / 任务扫描
  21: 'daily', // 签到（第二趟）
}

/** 取当前 UTC+8 小时。用固定偏移，不依赖 `Intl`/本机时区（Workers 恒 UTC）。 */
function hourUtc8(now: number): number {
  const CST_OFFSET = 8 * 60 * 60 * 1000
  return new Date(now + CST_OFFSET).getUTCHours()
}

/**
 * Cron 扇出：**只唤起，不执行**。
 *
 * ⚠️ Free 计划 Cron CPU 只有 10ms（AGENTS.md §8.2.1），故这里只做：
 * 判断时点 → 列账号 → 对每个账号调一次 `start()`（入队 + 排 alarm）→ 立即返回。
 * **任何实际的上游请求都发生在 DO 的 alarm 里。**
 */
async function scheduled(event: ScheduledController, env: Env): Promise<void> {
  const now = Date.now()
  const hour = hourUtc8(now)
  const plan = SCHEDULE_UTC8[hour]

  // 非任务时点：直接返回，不产生任何 DO 调用（省配额，也避免无谓的 DO Duration）。
  if (plan === undefined) {
    console.log(`[cron] ${event.cron} UTC+8 ${hour} 时点无任务，跳过`)
    return
  }

  const realm = 'cn'
  const stub = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
  const accounts = await stub.listAccounts(realm, now)

  console.log(`[cron] ${event.cron} UTC+8 ${hour} 时点 → plan=${plan}，扇出 ${accounts.length} 个账号`)

  for (const account of accounts) {
    if (account.disabled) continue
    try {
      await startRun(env, {
        uid: account.uid,
        nickname: account.nickname,
        realm: account.realm,
        accessToken: '',
        plan,
      })
    } catch (error) {
      // 单个账号失败不影响其他账号；如实记录原因（不静默）
      console.error(`[cron] 账号 ${account.uid} 入队失败：`, error instanceof Error ? error.message : String(error))
    }
  }
}

export default {
  fetch: handle,
  scheduled,
}

// 未被使用的导出保留给后续步骤（第 6 步的网关需要），避免 tree-shaking 误删注释里的说明。
export { cliChatHeaders, resolveUpstream }
