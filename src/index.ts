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
import type { AccountState } from './pool/state.js'
import type { LoginCredential } from './upstream/auth.js'
import { parseAuthDocument, parseAuthPayload } from './upstream/import.js'
import { handleChatCompletions } from './gateway/server.js'
import { fetchBalance } from './upstream/checkin.js'
import { listTasks } from './upstream/tasks.js'
import { listModels, pickCredential } from './gateway/models.js'
import { jsonError } from './gateway/http.js'
import { bindBuddy, WORKBUDDY_INTL } from './providers/buddy.js'
import {
  DEFAULT_PROVIDER,
  findProvider,
  parseCredentialAnywhere,
  providerCatalog,
  providerIds,
  PROVIDERS,
} from './providers/index.js'
import { splitModelName, type ProviderCredential } from './providers/types.js'
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
/**
 * @param ctx Worker 的 ExecutionContext。
 *
 * ⚠️ **必须有它**：响应流结束后，Worker 会**取消所有未完成的 promise**。
 * 用量记账发生在流结束时（`onFinish`），若不用 `ctx.waitUntil()` 托住，
 * 它会被直接取消 —— 表现为「对话成功但用量恒为 0」，且**没有任何错误日志**
 * （线上实测踩到；这正是本项目一直在警告的静默失败形态）。
 */
/**
 * 调供应商接口，遇到 401/403 **先续期再重试一次**。
 *
 * ## ⚠️ 为什么必须抽出来（实测踩到）
 *
 * 上游令牌有寿命，过期后所有请求 401。本项目原先**从不续期** ——
 * 结果 cline/raccoon/codearts 三个账号的余额查询全报 auth_error，
 * 而它们的模型目录明明拉得到（证明凭据本身没问题，只是 access token 过期）。
 *
 * 续期只试**一次**：续期后仍 401 说明 refresh token 也废了，再试只是白打上游。
 *
 * @returns `{ credential, value }`；续期成功时 `credential` 是新凭据（调用方已落盘）。
 */
async function withRefreshRetry<T>(
  env: Env,
  pool: DurableObjectStub<AccountPoolDO>,
  providerId: string,
  credential: ProviderCredential,
  call: (credential: ProviderCredential) => Promise<T>,
): Promise<{ credential: ProviderCredential; value: T }> {
  try {
    return { credential, value: await call(credential) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // ⚠️ 判据要**宽**，因为各家的鉴权错误文案千差万别：
    // - WorkBuddy: `auth_error` / `upstream 401`
    // - Raccoon:   `code=200003` + `authorization_verify_error`
    // - Cline:     `http=401` + `Unauthorized`
    // - 通用:       `403` / `Forbidden` / `token` / `unauthorized`
    //
    // 实测踩到：只匹配 `auth_error|401|403|Unauthorized|token` 时，
    // Raccoon 的 `code=200003` 不含这些词 → 续期从不触发 →
    // 账号明明有**有效的** refresh token（手工验证能换到新令牌）却一直 401。
    //
    // 宁可偶尔多试一次续期（续期失败会走 catch 落回原错误），
    // 也不要漏掉真正的鉴权失败。
    const isAuth = /auth_error|unauthor|forbidden|invalid.?token|token.?expir|expired|200003|APIG\.0602|\b401\b|\b403\b/i.test(
      message,
    )
    if (!isAuth) throw error

    const provider = findProvider(providerId)
    if (provider?.refresh === undefined) throw error

    const fresh = await provider.refresh(credential, AbortSignal.timeout(30_000))
    await pool.putCredential(credential.uid, fresh, Date.now())
    console.warn(`[refresh] ${providerId} 续期成功，已回写凭据`)
    return { credential: fresh, value: await call(fresh) }
  }
}

/**
 * 把供应商登录拿到的凭据加密落盘（与 `/admin/import` 同一套 key 规则）。
 *
 * ⚠️ 存储 key 的加前缀规则必须与导入路径**完全一致**，
 * 否则同一个账号会因为「登录进来」和「导入进来」而变成两条记录。
 */
async function persistProviderCredential(
  env: Env,
  pool: DurableObjectStub<AccountPoolDO>,
  credential: ProviderCredential,
  now: number,
): Promise<Record<string, unknown>> {
  const providerId = credential.provider
  const storageUid = providerId === DEFAULT_PROVIDER ? credential.uid : `${providerId}:${credential.uid}`
  const realm = credential.extras['realm'] ?? 'cn'
  await pool.createAccount(
    { uid: storageUid, nickname: credential.nickname, realm, provider: providerId },
    now,
  )
  await pool.revive(storageUid, now)
  await pool.putCredential(storageUid, credential, now)
  return { done: true, provider: providerId, uid: storageUid, nickname: credential.nickname }
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
    const body = (await request.json().catch(() => ({}))) as { realm?: string; provider?: string }
    const realm = body.realm ?? 'cn'
    // ⚠️ 按供应商选登录域：
    // - `buddy`（国内版）→ `copilot.tencent.com`
    // - `workbuddy`（国际版）→ `www.workbuddy.ai`
    // 两家的 `/v2/plugin/auth/state` 协议完全相同，只是域名不同
    // （实测国际版返回 `https://www.workbuddy.ai/login?platform=CLI&state=...`）。
    const loginProvider = body.provider ?? DEFAULT_PROVIDER
    const bases = resolveUpstream(env)
    const chatBase = loginProvider === 'workbuddy' ? WORKBUDDY_INTL.chatBase : bases.chat
    try {
      const { state, authUrl } = await startLogin({ chatBase, realm })
      const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
      await pool.saveLoginSession(
        state,
        { realm, provider: loginProvider, createdAt: Date.now() },
        Date.now() + LOGIN_STATE_TTL_MS,
      )
      return json({ ok: true, state, authUrl, realm, provider: loginProvider, expiresInMs: LOGIN_STATE_TTL_MS })
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

  // ── 按供应商发起设备码登录 ──
  //
  // ⚠️ 只有**导出完整登录流程**（start + poll 两个函数）的供应商能走这里。
  // 其余家即便声明了 `login: true` 也无法从本服务发起 —— 见各 provider 的
  // `capabilities.loginBlockedReason`（这是刻意如实声明的，不是遗漏）。
  if (path === '/admin/providers/login/start' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { provider?: string }
    const providerId = body.provider ?? ''
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))

    if (providerId === 'qoder') {
      const { startQoderLogin } = await import('./providers/qoder.js')
      const session = await startQoderLogin('qoder')
      const state = crypto.randomUUID()
      // 会话存 DO（**不返回 verifier 给前端**：那是换取令牌的秘密）
      await pool.saveLoginSession(state, { provider: 'qoder', kind: 'qoder', session }, Date.now() + 15 * 60 * 1000)
      return json({ ok: true, provider: 'qoder', state, authUrl: session.loginUrl })
    }
    if (providerId === 'zcode') {
      const { startZcodeLogin } = await import('./providers/zcode.js')
      const flow = await startZcodeLogin(AbortSignal.timeout(20_000))
      const state = crypto.randomUUID()
      await pool.saveLoginSession(state, { provider: 'zcode', kind: 'zcode', flow }, Date.now() + 15 * 60 * 1000)
      return json({ ok: true, provider: 'zcode', state, authUrl: flow.authorizeUrl })
    }
    return jsonError(
      501,
      `供应商「${providerId}」不支持从本服务发起登录（${providerId === DEFAULT_PROVIDER ? '请用 /admin/login/start' : '请粘贴凭据导入'}）`,
      'login_unsupported',
    )
  }

  // ── 轮询供应商登录结果 ──
  if (path === '/admin/providers/login/poll' && request.method === 'GET') {
    const state = url.searchParams.get('state') ?? ''
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const saved = (await pool.getLoginSession(state, Date.now())) as
      | { provider: string; kind: string; session?: unknown; flow?: unknown }
      | undefined
    if (saved === undefined) return json({ done: false, message: '会话不存在或已过期' })

    const now = Date.now()
    try {
      if (saved.kind === 'qoder') {
        const { pollQoderLogin } = await import('./providers/qoder.js')
        const credential = await pollQoderLogin(saved.session as never, AbortSignal.timeout(20_000))
        if (credential === undefined) return json({ done: false, message: '等待授权中…' })
        return json(await persistProviderCredential(env, pool, credential, now))
      }
      if (saved.kind === 'zcode') {
        const { pollZcodeLogin } = await import('./providers/zcode.js')
        const credential = await pollZcodeLogin(saved.flow as never, AbortSignal.timeout(20_000))
        if (credential === undefined) return json({ done: false, message: '等待授权中…' })
        return json(await persistProviderCredential(env, pool, credential, now))
      }
    } catch (error) {
      return json({ done: false, message: error instanceof Error ? error.message : String(error) })
    }
    return json({ done: false, message: '未知的会话类型' })
  }

  // ── 全部供应商一键签到 ──
  //
  // ⚠️ 逐账号**串行**（不是 Promise.all）：同时出站连接上限是 6，
  // 且并行打上游更容易触发风控。
  //
  // 只对**声明了 checkin: true** 的供应商执行 —— 其余家显式跳过并说明原因，
  // 不静默忽略（用户需要知道「为什么这家没签」）。
  if (path === '/admin/checkin/all' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { realm?: string; provider?: string }
    const realm = body.realm ?? 'cn'
    const only = body.provider ?? ''
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const accounts = await pool.listAccounts(realm, Date.now())
    const results: Array<Record<string, unknown>> = []

    for (const account of accounts) {
      const providerId = account.provider ?? DEFAULT_PROVIDER
      if (only !== '' && providerId !== only) continue
      if (account.disabled) {
        results.push({ uid: account.uid, provider: providerId, ok: false, detail: '账号已禁用' })
        continue
      }
      const provider = findProvider(providerId)
      if (provider === undefined) {
        results.push({ uid: account.uid, provider: providerId, ok: false, detail: '未知供应商' })
        continue
      }
      if (!provider.capabilities.checkin || provider.checkin === undefined) {
        // ⚠️ 显式说明原因，不静默跳过
        results.push({
          uid: account.uid,
          provider: providerId,
          ok: false,
          skipped: true,
          detail: provider.capabilities.checkinBlockedReason ?? '该供应商不支持签到',
        })
        continue
      }
      const credential = (await pool.getCredential(account.uid)) as ProviderCredential | undefined
      if (credential === undefined) {
        results.push({ uid: account.uid, provider: providerId, ok: false, detail: '账号缺少凭据' })
        continue
      }
      const bound = providerId === DEFAULT_PROVIDER ? bindBuddy(env) : provider
      try {
        const r = await bound.checkin!(credential, AbortSignal.timeout(30_000))
        results.push({
          uid: account.uid, provider: providerId, nickname: account.nickname,
          ok: true, alreadyDone: r.alreadyDone, gained: r.gained, detail: r.detail,
        })
        // 记录签到日（面板展示用）
        if (r.alreadyDone || r.gained >= 0) {
          await pool.noteSuccess(account.uid, Date.now()).catch(() => {})
        }
      } catch (error) {
        results.push({
          uid: account.uid, provider: providerId, nickname: account.nickname,
          ok: false, detail: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return json({
      realm,
      total: results.length,
      ok: results.filter((r) => r.ok === true).length,
      skipped: results.filter((r) => r.skipped === true).length,
      failed: results.filter((r) => r.ok !== true && r.skipped !== true).length,
      results,
    })
  }

  // ── buddy 每日任务（签到 + 全部成长任务 + 真实对话任务 + 领奖） ──
  //
  // ⚠️ 刻意**不暴露 plan 选项**：用户要的是「一键做完」，不是「先想清楚要跑哪个计划」。
  //
  // ⚠️ **包含真实对话任务**（`includeRealChat: true`）——
  // 那些是真正**给积分**的任务（expert_5 / Expert_team_use_3 / skill_1 /
  // Expert_lighthouse / black_cat）。用户明确要求把它们一并做掉。
  //
  // 代价：每次执行会消耗极少量配额（每次都是 fast-model 的极短对话，
  // 且**先查进度**，已达标就跳过、不重复消耗）。故只在**用户手动点按钮**时
  // 走这条路径 —— 挂 cron 的自动计划仍然不含它们（见 plans.ts 的注释）。
  if (path === '/admin/tasks/daily-all' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { realm?: string }
    const realm = body.realm ?? 'cn'
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const accounts = await pool.listAccounts(realm, Date.now())
    const started: Array<Record<string, unknown>> = []

    for (const account of accounts) {
      if ((account.provider ?? DEFAULT_PROVIDER) !== DEFAULT_PROVIDER) continue
      if (account.disabled) continue
      const credential = (await pool.getCredential(account.uid)) as LoginCredential | undefined
      if (credential === undefined) continue
      try {
        const result = await startRun(env, {
          uid: account.uid,
          nickname: account.nickname,
          realm: account.realm,
          accessToken: credential.accessToken,
          plan: 'growth',
          // ⚠️ 关键：带上真实对话任务（它们才给积分）。
          // 漏了这个参数，用户点了按钮却拿不到那几个任务的积分。
          includeRealChat: true,
        })
        started.push({ uid: account.uid, nickname: account.nickname, queued: result.queued })
      } catch (error) {
        started.push({
          uid: account.uid, nickname: account.nickname,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return json({ realm, started })
  }

  // ── 模型开关（面板用：打开/关闭某供应商下的模型） ──
  //
  // ⚠️ 与「模型级冷却」是**两个独立概念**，不共用一个字段：
  // - 冷却 = 上游限流，自动恢复；
  // - 停用 = 用户手动选择，只能手动恢复。
  // 混用会导致「手动停用的模型自动复活」这类难查的行为。
  if (path === '/admin/providers/models/toggle' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as {
      realm?: string; provider?: string; model?: string; enabled?: boolean
    }
    const realm = body.realm ?? 'cn'
    const providerId = body.provider ?? ''
    const model = body.model ?? ''
    if (providerId === '' || model === '') {
      return jsonError(400, 'provider 与 model 必填', 'invalid_request')
    }
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const current = new Set(await pool.getDisabledModels(providerId))
    if (body.enabled === false) current.add(model)
    else current.delete(model)
    await pool.setDisabledModels(providerId, [...current])
    return json({ ok: true, provider: providerId, model, enabled: body.enabled !== false })
  }

  // ── 批量设置（一键关闭 / 一键开启全部） ──
  //
  // ⚠️ 必须服务端批量，不能让前端循环调 N 次 toggle ——
  // 那会产生 N 次 DO 往返，且中途失败会留下「关了一半」的不一致状态。
  if (path === '/admin/providers/models/bulk' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as {
      realm?: string; provider?: string; models?: unknown; enabled?: boolean
    }
    const realm = body.realm ?? 'cn'
    const providerId = body.provider ?? ''
    if (providerId === '') return jsonError(400, 'provider 必填', 'invalid_request')
    if (!Array.isArray(body.models)) return jsonError(400, 'models 必须是数组', 'invalid_request')

    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const current = new Set(await pool.getDisabledModels(providerId))
    const ids = body.models.filter((m): m is string => typeof m === 'string' && m !== '')
    if (body.enabled === false) for (const id of ids) current.add(id)
    else for (const id of ids) current.delete(id)
    await pool.setDisabledModels(providerId, [...current])
    return json({ ok: true, provider: providerId, changed: ids.length, disabledCount: current.size })
  }

  // ── 清除模型级冷却（「解冻」） ──
  // ⚠️ 必须有的运维入口：模型级退避 6h 起步，而有些失败其实是**我方**问题
  // （如模型名带前缀被上游判为「没有这个模型」），修好代码后不该再等 6 小时。
  if (path === '/admin/cooldowns/clear' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { realm?: string; uid?: string; model?: string }
    const realm = body.realm ?? 'cn'
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const cleared = await pool.clearModelCooldowns(realm, body.uid, body.model)
    // 同时清账号级熔断/冷却（排查「明明健康却选不到号」时用）
    const resetCount = await pool.clearCooldowns(realm, body.uid)
    return json({ ok: true, realm, cleared, resetCount })
  }

  // ── 供应商目录（面板用：显示每家的能力与登录阻塞原因） ──
  if (path === '/admin/providers' && request.method === 'GET') {
    return json({ default: DEFAULT_PROVIDER, providers: providerCatalog() })
  }

  // ── 按供应商列模特（面板用） ──
  if (path === '/admin/providers/models' && request.method === 'GET') {
    const providerId = url.searchParams.get('provider') ?? DEFAULT_PROVIDER
    const provider = findProvider(providerId)
    if (provider === undefined) return jsonError(404, `未知供应商「${providerId}」`, 'unknown_provider')
    if (!provider.capabilities.listModels) {
      return json({ provider: providerId, models: [], note: '该供应商不支持列出模型' })
    }
    // ⚠️ **必须同时查 cn 与 global 两个 realm**。
    // 账号按凭据里的 realm 分片存（如 WorkBuddy 国际版的凭据 realm 就是 global），
    // 只查 cn 会让国际版账号「看起来不存在」—— 实测踩到：
    // 面板显示「没有该供应商的账号」，而账号其实好好地存在 global 里。
    let account: AccountState | undefined
    let pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    for (const realm of ['cn', 'global']) {
      const candidatePool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
      const accounts = await candidatePool.listAccounts(realm, Date.now())
      const hit = accounts.find((a) => (a.provider ?? DEFAULT_PROVIDER) === providerId)
      if (hit !== undefined) {
        account = hit
        pool = candidatePool
        break
      }
    }
    if (account === undefined) {
      return json({ provider: providerId, models: [], note: '没有该供应商的账号，无法拉取模型目录' })
    }
    const credential = (await pool.getCredential(account.uid)) as ProviderCredential | undefined
    if (credential === undefined) return jsonError(404, '该账号无凭据', 'no_credential')
    // ⚠️ 只有国内版（buddy）需要绑定 env —— 它允许用 env 覆盖域名便于调试；
    // 国际版恒用官方域名。
    const bound = providerId === DEFAULT_PROVIDER ? bindBuddy(env) : provider
    try {
      // ⚠️ 走续期重试：过期令牌不该让用户看到「凭据坏了」
      const { value: models } = await withRefreshRetry(env, pool, providerId, credential, (c) =>
        bound.listModels(c, AbortSignal.timeout(20_000)),
      )
      // 带上「是否被用户停用」标记，供面板渲染开关
      const disabled = await pool.getDisabledModels(providerId)
      const set = new Set(disabled)
      return json({
        provider: providerId,
        models: models.map((m) => ({ ...m, disabled: set.has(m.id) })),
        disabledCount: disabled.length,
      })
    } catch (error) {
      return jsonError(502, error instanceof Error ? error.message : String(error), 'list_models_failed')
    }
  }

  // ── 用量统计 ──
  if (path === '/admin/usage' && request.method === 'GET') {
    const realm = url.searchParams.get('realm') ?? 'cn'
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const summary = await pool.usageSummary()
    return json({ realm, ...summary })
  }
  if (path === '/admin/usage/clear' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { realm?: string }
    const realm = body.realm ?? 'cn'
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    await pool.clearUsage()
    return json({ ok: true, realm })
  }

  // ── 请求日志 ──
  if (path === '/admin/logs' && request.method === 'GET') {
    const realm = url.searchParams.get('realm') ?? 'cn'
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10)
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const logs = await pool.readLogs(Number.isFinite(limit) ? limit : 100)
    return json({ realm, logs })
  }
  if (path === '/admin/logs/clear' && request.method === 'POST') {
    const body = await request.json().catch(() => ({})) as { realm?: string }
    const realm = body.realm ?? 'cn'
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    await pool.clearLogs()
    return json({ ok: true, realm })
  }

  // ── 积分包（逐账号余额明细，实时查上游） ──
  if (path === '/admin/packages' && request.method === 'GET') {
    const realm = url.searchParams.get('realm') ?? 'cn'
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const accounts = await pool.listAccounts(realm, Date.now())
    const now = Date.now()
    const out: Array<Record<string, unknown>> = []
    // ⚠️ 串行查询：同时出站连接上限是 6，且并行打上游更容易触发风控
    for (const a of accounts) {
      const credential = (await pool.getCredential(a.uid)) as LoginCredential | undefined
      if (credential === undefined) continue
      try {
        // ⚠️ **按供应商调它自己的余额接口**，不能一律用 WorkBuddy 的
        // `fetchBalance` —— 那会让所有非 buddy 账号拿到 401
        //（实测：cline/trae/qoder 等的余额全报 auth_error，
        //  而它们的模型目录明明拉得到 485/38/17 个，证明凭据是好的）。
        const pid = a.provider ?? DEFAULT_PROVIDER
        const provider = findProvider(pid)
        if (provider === undefined || !provider.capabilities.balance || provider.balance === undefined) {
          out.push({
            uid: a.uid, provider: pid, nickname: a.nickname,
            skipped: true, reason: '该供应商不支持查余额',
          })
          continue
        }
        const boundProvider = pid === DEFAULT_PROVIDER ? bindBuddy(env) : provider
        // ⚠️ 先把方法取出来再调：TS 无法透过三元表达式收窄 `boundProvider.balance`
        // 的可选性（上面已判过 `provider.balance !== undefined`）。
        const balanceFn = boundProvider.balance
        if (balanceFn === undefined) continue
        // ⚠️ 经 `unknown` 中转：存储里放的是 ProviderCredential（各供应商形态不同），
        // 而 `getCredential` 的返回类型被标注成 LoginCredential（历史原因）。
        // 边界处断言一次，符合本项目「跨存储边界断言一次」的纪律。
        const b = await balanceFn(credential as unknown as ProviderCredential, AbortSignal.timeout(30_000))
        out.push({
          uid: a.uid,
          // ⚠️ 必须回传 provider：面板按供应商卡片汇总积分，
          // 不回传会让所有账号的积分都算到默认供应商头上（静默算错）。
          provider: a.provider ?? DEFAULT_PROVIDER,
          nickname: a.nickname,
          total: b.total,
          expiring: b.expiring,
          earliestExpiry: b.earliestExpiry,
          packages: b.packages,
        })
      } catch (error) {
        out.push({
          uid: a.uid,
          provider: a.provider ?? DEFAULT_PROVIDER,
          nickname: a.nickname,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return json({ realm, accounts: out })
  }

  // ── 任务总览（扫描全部账号的待办，只读） ──
  if (path === '/admin/tasks/scan' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { realm?: string }
    const realm = body.realm ?? 'cn'
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const accounts = await pool.listAccounts(realm, Date.now())
    const out: Array<Record<string, unknown>> = []
    for (const a of accounts) {
      const credential = (await pool.getCredential(a.uid)) as LoginCredential | undefined
      if (credential === undefined) { out.push({ uid: a.uid, error: '无凭据' }); continue }
      try {
        const tasks = await listTasks({ uid: a.uid, accessToken: credential.accessToken, realm }, env)
        const pending = tasks.filter((t) => !t.claimed)
        out.push({
          uid: a.uid,
          nickname: a.nickname,
          total: tasks.length,
          pendingCount: pending.length,
          claimable: tasks.filter((t) => t.claimable).map((t) => t.taskCode),
          pending: pending.map((t) => `${t.taskCode}(${t.current}/${t.target})`),
        })
      } catch (error) {
        out.push({ uid: a.uid, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return json({ realm, accounts: out })
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

    // 允许显式声明供应商（`{"provider":"cline","accounts":[...]}`）；
    // 未声明时按特征自动识别（见 parseCredentialAnywhere 的顺序说明）。
    let declaredProvider: string | undefined
    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      const p = (payload as Record<string, unknown>).provider
      if (typeof p === 'string' && p !== '') declaredProvider = p
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
    const imported: Array<{ uid: string; provider: string; nickname: string; realm: string; expiresAt: number }> = []
    const skipped: Array<{ reason: string; source?: string }> = []

    for (const entry of entries) {
      // 逐条独立：单条坏文件不应影响其他条
      //
      // ⚠️ 多供应商后不再直接调 WorkBuddy 的 `parseAuthDocument` ——
      // 那会把 cline 等供应商的凭据也当成 WorkBuddy 存下来，
      // 表现为「导入成功但一用就 401」。
      let providerId: string
      let credential: ProviderCredential
      try {
        const found = parseCredentialAnywhere(entry.raw, declaredProvider)
        providerId = found.provider.id
        credential = found.credential
      } catch (error) {
        skipped.push({
          reason: error instanceof Error ? error.message : String(error),
          ...(entry.source === undefined ? {} : { source: entry.source }),
        })
        continue
      }

      const realmOf = credential.extras['realm'] ?? 'cn'

      // 安全边界：uid 会被用作 storage key
      if (!isValidUid(credential.uid)) {
        skipped.push({
          reason: `uid 含非法字符，已拒绝：${credential.uid.slice(0, 32)}`,
          ...(entry.source === undefined ? {} : { source: entry.source }),
        })
        continue
      }

      // ⚠️ 存储 key 加供应商前缀。
      // 不同供应商的 uid 空间互相独立，可能出现同 uid 不同家的情况；
      // 不加前缀会互相覆盖凭据（表现为「导入 B 家后 A 家坏了」）。
      const storageUid = providerId === DEFAULT_PROVIDER ? credential.uid : `${providerId}:${credential.uid}`

      const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realmOf))
      try {
        await pool.createAccount(
          { uid: storageUid, nickname: credential.nickname, realm: realmOf, provider: providerId },
          now,
        )
        await pool.revive(storageUid, now)
        await pool.putCredential(storageUid, credential, now)
      } catch (error) {
        // 典型：未配置 CREDENTIAL_KEY → 明确报错而不是静默明文落盘
        skipped.push({
          reason: error instanceof Error ? error.message : String(error),
          ...(entry.source === undefined ? {} : { source: entry.source }),
        })
        continue
      }

      imported.push({
        uid: storageUid,
        provider: providerId,
        nickname: credential.nickname,
        realm: realmOf,
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
        // ⚠️ 必须回传 provider：面板靠它把账号分到各家卡片下。
        // 不回传时面板的 `.filter(a => a.provider === id)` 恒为空，
        // 表现为「点开供应商看不到自己的账号」（实测踩到）。
        provider: a.provider ?? DEFAULT_PROVIDER,
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
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const accounts = await pool.listAccounts(realm, Date.now())

    // ⚠️ **只列「有账号」的供应商的模型**（用户要求）。
    //
    // 没有账号的供应商，其模型选了也只会报「没有可用账号」——
    // 列出来只会让客户端挑到一个必然失败的模型。
    // 这也让「登录后再显示」自然成立：登录后 accountCounts 变化，模型即出现。
    //
    // 只对声明 `listModels` 的家拉目录；逐家**串行**（同时出站连接上限 6，
    // 且并行打上游更容易触发风控）。
    const byProvider = new Map<string, typeof accounts>()
    for (const a of accounts) {
      const pid = a.provider ?? DEFAULT_PROVIDER
      const list = byProvider.get(pid) ?? []
      list.push(a)
      byProvider.set(pid, list)
    }

    const data: Array<Record<string, unknown>> = []
    const errors: Array<{ provider: string; error: string }> = []
    let disabledTotal = 0

    for (const [providerId, list] of byProvider) {
      const provider = findProvider(providerId)
      if (provider === undefined || !provider.capabilities.listModels) continue
      const account = list.find((a) => !a.disabled)
      if (account === undefined) continue
      const credential = (await pool.getCredential(account.uid)) as ProviderCredential | undefined
      if (credential === undefined) continue

      const disabled = new Set(await pool.getDisabledModels(providerId))
      disabledTotal += disabled.size

      try {
        const bound = providerId === DEFAULT_PROVIDER ? bindBuddy(env) : provider
        const models = await bound.listModels(credential, AbortSignal.timeout(20_000))
        for (const m of models) {
          if (disabled.has(m.id)) continue
          const base = m as unknown as Record<string, unknown>
          // ⚠️ 同时暴露**裸名**与 **`provider/` 前缀名**：
          // - 裸名保持既有用户兼容（他们已经在用 `deepseek-v4-flash`）；
          // - 带前缀名让多供应商场景无歧义（多家可能有同名模型）。
          data.push({ ...base, id: `${providerId}/${m.id}` })
          // 裸名只给**默认供应商**（否则多家重名会互相覆盖，客户端拿到谁不确定）
          if (providerId === DEFAULT_PROVIDER) data.push(base)
        }
      } catch (error) {
        // ⚠️ 逐家兜错：一家失败不该让整个目录 500（用户可能只想用另一家）
        errors.push({
          provider: providerId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (data.length === 0 && errors.length === 0) {
      return jsonError(
        503,
        '没有任何可用账号（请先在面板登录或导入凭据）',
        'no_available_account',
      )
    }
    return json({
      object: 'list',
      data,
      ...(errors.length === 0 ? {} : { errors }),
      disabledCount: disabledTotal,
    })
  }

  // ── OpenAI 兼容：对话（**流式 SSE 透传**） ──
  if (path === '/v1/chat/completions' && request.method === 'POST') {
    const realm = url.searchParams.get('realm') ?? 'cn'
    const result = await handleChatCompletions(request, env, realm, ctx)
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
