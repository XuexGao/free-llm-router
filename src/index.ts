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

/**
 * raccoon 扫码登录会话的存活时长。
 *
 * ⚠️ 与其它家不同：raccoon 的二维码**没有服务端下发的有效期**，
 * 是我们自己定的窗口。10 分钟足够「掏出手机 → 扫码 → 在微信里确认」，
 * 又不会让一个废弃会话长期占着存储。
 */
const RACCOON_LOGIN_STATE_TTL_MS = 10 * 60 * 1000
/**
 * cline 设备码登录的节流下限（毫秒）。
 *
 * ⚠️ 与 `src/providers/cline.ts` 的 `CLINE_DEVICE_MIN_INTERVAL_MS` 同值。
 * 这里单独写一份是为了避免顶层静态 import 整个 cline 模块（它是**懒加载**的：
 * 该模块带着余额 / 目录 / 续期等一大坨代码，只有真要登录时才需要）。
 * 若两处取值分叉，`intervalMs` 缺失时的兜底会与上游要求不一致。
 */
const CLINE_DEVICE_MIN_INTERVAL_MS = 1_000

/**
 * cline 登录会话在设备码到期后**多留的宽限**（毫秒）。
 *
 * ⚠️ **不能省**：`readLoginSession` 在 `expires_at <= now` 时会直接删掉会话
 * （`src/store/db.ts:128-134`），于是轮询只会拿到通用的「会话不存在或已过期」
 * —— 那条响应**没有 `status`**，面板会当成「继续等」而不是终态，
 * 用户要空等到面板自己的 100 次超时（约 5 分钟）才知道失败。
 *
 * 留出这个窗口后，`/admin/providers/login/poll` 的 cline 分支才有机会走到
 * `now > deadline` 那条判断并回 `status: 'failed'`，让面板**立刻**停下来。
 * ⚠️ 两处 `saveLoginSession`（发起时、每轮 pending 写回时）**必须用同一个值**
 * —— 否则第一轮写回就把宽限抹掉了，等于没加。
 */
const CLINE_LOGIN_SESSION_GRACE_MS = 60_000
import type { AccountState } from './pool/state.js'
import type { ProviderModel } from './providers/types.js'
import type { LoginCredential } from './upstream/auth.js'
import { parseAuthDocument, parseAuthPayload } from './upstream/import.js'
import { handleResponses } from './gateway/responses.js'
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
import { splitModelName, ProviderError, type ProviderCredential } from './providers/types.js'
import {
  buildCodeArtsCallbackUrl,
  buildCodeArtsLoginUrl,
  codeArtsTicketCredentialToProvider,
  CODEARTS_LOGIN_CALLBACK_PATH,
  CODEARTS_LOGIN_STATE_TTL_MS,
  fetchCodeArtsTicket,
  generateCodeArtsLoginState,
  pollCodeArtsTicket,
} from './providers/codearts.js'
import {
  buildTraeCallbackUrl,
  buildTraeLoginURL,
  exchangeTraeCallback,
  generateMachineId,
  generateDeviceId,
  generateTraeLoginState,
  parseTraeCallback,
  TRAE_LOGIN_CALLBACK_PATH,
  TRAE_LOGIN_STATE_TTL_MS,
} from './providers/trae.js'
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
 * 把设备码登录拿到的凭据转成该供应商的 `ProviderCredential`。
 *
 * ## ⚠️ 为什么必须走供应商自己的 `parseCredential`（不要手搓字段）
 *
 * 手搓会漏掉 `extras`，而 `extras` 里有两个字段是**主流程必需**的：
 * - `realm`：决定账号落到哪个 `AccountPoolDO` **分片** —— 落错分片等于
 *   「账号存进去了，但按 realm 查永远查不到」（`/admin/import` 同样从
 *   `credential.extras['realm']` 取分片，见本文件的导入端点）；
 * - `enterpriseId`：续期请求的必填头 `X-Enterprise-Id`，漏了企业账号**永远续期失败**
 *   （`src/providers/buddy.ts:194-196` 明确记了这条）。
 *
 * `domain` 也必须落实：`AccountPoolDO.migrateBuddyIds` 用
 * 「`provider === 'workbuddy'` **且** domain 不含 `workbuddy.ai`」判定为
 * 「本项目早期把国内版叫 workbuddy 时存下的账号」并迁到 `buddy`
 * （`src/pool/AccountPoolDO.ts:178-181`）。国际版登录若 domain 为空串，
 * 刚存进来的国际账号会被这条迁移**误判成国内账号**（静默、且要重新登录才能恢复）。
 * 故国际版缺 domain 时补上本轮登录**实际使用**的固定域名 —— 这不是编造：
 * 下面 `/admin/providers/login/start` 的 workbuddy 分支恒用该域名发起登录。
 */
function toProviderCredential(providerId: string, cred: LoginCredential): ProviderCredential {
  const provider = findProvider(providerId)
  if (provider === undefined) {
    throw new Error(`未知供应商「${providerId}」，无法把登录结果转成凭据`)
  }
  return provider.parseCredential({
    accessToken: cred.accessToken,
    refreshToken: cred.refreshToken,
    expiresAt: cred.expiresAt,
    domain:
      cred.domain !== ''
        ? cred.domain
        : providerId === WORKBUDDY_INTL.id
          ? 'www.workbuddy.ai'
          : '',
    // ⚠️ realm 用**本轮登录请求的** realm，不靠 domain 猜：
    // 上游 token 响应里未必带 domain，而 `parseAuthDocument` 在缺 domain 时会
    // 回落 `cn`（`src/upstream/import.ts:166-167`）—— 国际版会被错判成国内版。
    realm: cred.realm,
    uid: cred.uid,
    enterpriseId: cred.enterpriseId,
    nickname: cred.nickname,
  })
}

/**
 * 把供应商登录拿到的凭据加密落盘（与 `/admin/import` 同一套 key 规则）。
 *
 * ⚠️ 存储 key 的加前缀规则必须与导入路径**完全一致**，
 * 否则同一个账号会因为「登录进来」和「导入进来」而变成两条记录。
 *
 * ⚠️ **分片由凭据里的 `realm` 决定**（不是由调用方传进来的 stub 决定）：
 * `realm` 是「这个账号属于哪个 `AccountPoolDO` 分片」的唯一真相源，
 * 与 `/admin/import` 取分片的口径一致。若改为「调用方传哪个 stub 就存哪个分片」，
 * 国际版（realm=global）登录会被存进 cn 分片 —— 表现为「登录成功，但账号列表为空」，
 * 且极难归因。故这里自己按 `extras['realm']` 取 stub。
 */
async function persistProviderCredential(
  env: Env,
  credential: ProviderCredential,
  now: number,
): Promise<Record<string, unknown>> {
  const providerId = credential.provider
  const storageUid = providerId === DEFAULT_PROVIDER ? credential.uid : `${providerId}:${credential.uid}`
  const realm = credential.extras['realm'] ?? 'cn'
  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
  await pool.createAccount(
    { uid: storageUid, nickname: credential.nickname, realm, provider: providerId },
    now,
  )
  await pool.revive(storageUid, now)
  await pool.putCredential(storageUid, credential, now)
  return { done: true, provider: providerId, uid: storageUid, nickname: credential.nickname, realm }
}

/**
 * 找出某供应商的账号**实际在哪个分片**。
 *
 * ## ⚠️ 为什么必须有它（实测踩到：「国际版的模型管理不了」）
 *
 * 账号按凭据的 `extras.realm` 分片存放（WorkBuddy 国际版在 `global`），
 * 而模型的「启用/停用」列表是**按供应商存在分片里**的
 *（`disabledModels`，见 `AccountPoolDO`）。
 *
 * 所有管理类端点原先一律 `body.realm ?? 'cn'` —— 于是对国际版：
 * 读的是 cn 分片（那里没有它的停用记录，看起来「一个都没关」），
 * 写也写进 cn 分片（**真正的账号在 global，读的时候根本看不到**）。
 * 用户的表现就是「开关点了没反应 / 管理不了」。
 *
 * 规则：先用调用方指定的分片；若该分片里**这个供应商一个账号都没有**，
 * 就回退到另一个。只在「一个都没有」时回退，避免把
 *「有账号但都在冷却」误判成「该换分片」。
 */
async function realmForProvider(
  env: Env,
  providerId: string,
  requested: string | undefined,
): Promise<string> {
  const candidates = requested === undefined || requested === '' ? ['cn', 'global'] : [requested]
  for (const realm of candidates) {
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const has = (await pool.listAccounts(realm, Date.now())).some(
      (a) => (a.provider ?? DEFAULT_PROVIDER) === providerId,
    )
    if (has) return realm
  }
  // 都没账号：用调用方指定的（或默认 cn），让后续逻辑如实报「没有账号」
  return requested === undefined || requested === '' ? 'cn' : requested
}

/**
 * 写「停用模型」列表 —— 写到**该供应商账号所在的规范分片**，
 * 并把同一批 id 从**另一个分片**清掉（自愈）。
 *
 * ## ⚠️ 为什么必须清另一个分片（实测踩到）
 *
 * 修复前所有管理端点都写 `realm='cn'`，于是 WorkBuddy 国际版的停用记录
 * 被写进了 **cn** 分片（而它的账号在 global）。后来读的时候是**两个分片合并**，
 * 于是「在 global 里启用」之后，cn 分片里那条陈旧记录仍然把模型标成已停用 ——
 * 表现为「开关点了返回 ok，但状态没变」，用户说「管理不了」。
 *
 * 所以写入时必须**双写清理**：规范分片设成新值，另一个分片把同批 id 删掉。
 * 这样无论历史脏数据在哪，下一次写操作都会把它纠正过来（自愈，无需手工迁移）。
 */
async function writeDisabledModels(
  env: Env,
  providerId: string,
  realm: string,
  mutate: (current: Set<string>) => void,
): Promise<number> {
  const canonical = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
  const current = new Set(await canonical.getDisabledModels(providerId))
  mutate(current)
  await canonical.setDisabledModels(providerId, [...current])

  // ⚠️ 另一个分片**镜像**成同一份列表（不是「按 current 过滤」）。
  //
  // 我第一版写成 `otherList.filter((id) => !current.has(id))` —— 那是错的：
  // 它保留的是「canonical 里**仍然**停用的 id」，于是当 canonical 本来就是空
  //（WorkBuddy 国际版的停用记录**全在 cn** 分片、global 里一条没有）时，
  // `current` 为空 ⇒ 一个都不删 ⇒ cn 那 29 条陈旧记录原封不动，
  // 合并读取后模型仍显示为停用（用户看到的还是「开关没反应」）。
  //
  // 正确做法是**镜像**：停用状态在逻辑上属于「供应商」而非「分片」，
  // 故两个分片最终应持有同一份列表。这样无论历史脏数据落在哪，
  // 任何一次写操作都会把它纠正过来（自愈），也不需要手工迁移。
  const otherRealm = realm === 'cn' ? 'global' : 'cn'
  const other = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(otherRealm))
  const finalList = [...current]
  const otherList = await other.getDisabledModels(providerId)
  const same =
    otherList.length === finalList.length && otherList.every((id) => current.has(id))
  if (!same) {
    await other.setDisabledModels(providerId, finalList)
  }
  return current.size
}

/**
 * 找出登录会话**实际存在哪个分片**（cn / global）。
 *
 * ⚠️ 必须两个都查：账号按凭据的 `realm` 分片存放，而登录会话与账号同分片 ——
 * WorkBuddy 国际版的会话在 `global`，其余家在 `cn`。只查 `cn` 会让国际版登录
 * 永远回「会话不存在或已过期」（会话就在隔壁分片里）。
 *
 * ⚠️ 这是**免鉴权路径（浏览器回调）与鉴权路径共用**的查找：两边必须
 * 用同一套规则，否则会出现「回调说会话在 global、轮询只找 cn」这类撕裂。
 */
async function findLoginSession(
  env: Env,
  state: string,
): Promise<
  { realm: string; payload: Record<string, unknown>; pool: DurableObjectStub<AccountPoolDO> } | undefined
> {
  if (state === '') return undefined
  for (const realm of ['cn', 'global']) {
    const probe = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const session = (await probe.getLoginSession(state, Date.now())) as Record<string, unknown> | undefined
    // ⚠️ 连同**命中分片的 stub** 一起返回：调用方要就地更新会话
    // （cline 的设备码节流状态每轮都要写回），自己按 realm 重建 stub
    // 容易写错分片，而写错分片的表现是「节流失效」这种静默故障。
    if (session !== undefined) return { realm, payload: session, pool: probe }
  }
  return undefined
}

/** 从会话载荷里安全读字符串（缺失/类型不符返回空串）。 */
function sessionString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === 'string' ? value : ''
}

/** 从会话载荷里安全读数值（缺失/类型不符返回 `undefined`）。 */
function sessionNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 渲染**浏览器回跳登录**的结果页（codearts 与 trae 共用）。
 *
 * ## 为什么是**纯静态 HTML**
 *
 * 页面必须**不带任何脚本**：面板的 CSP 是 `default-src 'none'; script-src 'self'`，
 * 而这里复用同一套安全头（`securityHeaders()`）。要放脚本就得放开
 * `unsafe-inline`，那等于放弃 XSS 防护（`src/panel/index.ts` 的原注释）。
 * 用户只需要「看一眼说明 + 点回面板」，静态 HTML 完全够用。
 *
 * ⚠️ 所有插值都经 `escapeHtml`：`detail` 可能包含**上游原文**
 * （如 ticket 端点返回的错误文案），不转义就是反射型 XSS。
 *
 * ## ⚠️ 为什么两家必须共用（而不是各写一份）
 *
 * codearts 与 trae 的回调页做的是**同一件事**（告诉用户「回面板去，凭据由面板
 * 写」），差异只有标题与说明文字。各写一份必然漂移 —— 上一轮 codearts 的页面
 * 就出现过「文案说有脚本、实际没有」这种只有一处改到的问题。
 * 故这里只保留**一个**渲染函数，两家传不同文案。
 */
function loginCallbackPage(input: {
  status: number
  ok: boolean
  title: string
  detail: string
}): Response {
  const color = input.ok ? '#1a7f37' : '#b42318'
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background:#0d1117;color:#e6edf3;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
<main style="max-width:640px;margin:12vh auto;padding:28px 32px;background:#161b22;border:1px solid #30363d;border-radius:12px">
<h1 style="margin:0 0 12px;font-size:20px;color:${color}">${escapeHtml(input.title)}</h1>
<p style="margin:0 0 18px;line-height:1.7;font-size:14px;color:#c9d1d9">${escapeHtml(input.detail)}</p>
<p style="margin:0 0 8px;line-height:1.7;font-size:14px;color:#8b949e">
凭据由<b>面板</b>负责写入（本页不写任何凭据）。请回到面板查看结果，无需关闭本页。
</p>
<p style="margin:18px 0 0"><a href="/panel/" style="color:#58a6ff;font-size:14px">返回管理面板</a></p>
</main>
</body>
</html>`
  return new Response(body, {
    status: input.status,
    headers: { ...securityHeaders(), 'content-type': 'text/html; charset=utf-8' },
  })
}

/** HTML 转义（回调页会插入上游原文，必须转义）。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 浏览器落点：`GET /login/codearts/callback/<state>?secret=…`（**免鉴权**）。
 *
 * ## 为什么不鉴权（以及凭什么安全）
 *
 * 浏览器是被华为**重定向**过来的，它带不了 `Authorization` 头。
 * 故这里**不能**用管理密钥，改用 `state` 本身作为能力凭证：
 * - `state` 是 32 字节 CSPRNG（{@link generateCodeArtsLoginState}），不可猜；
 * - 它绑定到一个**已经存在**的 `codearts` 登录会话（`kind === 'codearts'`），
 *   所以回调**永远无法**给任意其它供应商写凭据 —— 供应商只能来自会话载荷，
 *   **绝不**从 URL 参数取；
 * - 会话 10 分钟过期（{@link CODEARTS_LOGIN_STATE_TTL_MS}），且用完即删。
 *
 * ## 为什么 `state` 在**路径**里
 *
 * 见 `src/providers/codearts.ts` 的 {@link CODEARTS_LOGIN_CALLBACK_PATH} 注释：
 * 参考实现的回调 URL 不带 query（`login.ts:26`），故无法推断华为是「合并 query」
 * 还是「字符串拼 `?secret=`」；state 放路径里对两种行为都成立。
 * 同时这里对 query 形态（`?state=`）与最坏情况的「`state=x?secret=y`」都做了
 * 兼容解析，见下方剥离逻辑。
 *
 * ## 为什么真正的轮询不在这里阻塞
 *
 * 浏览器在等这一份响应，不能堵着它两分钟。故：
 * - 立刻回一个静态提示页；
 * - `ctx.waitUntil` 里**尽力**轮询 8 次（约 8 秒），成功就把凭据材料写回会话；
 * - 真正的权威是 `GET /admin/providers/login/poll`（面板每 3 秒调一次），
 *   它既读回这里的结果、也能自己再打一次 ticket 端点。
 * 这样即使 `waitUntil` 被 Worker 提前回收（它只是尽力而为），登录也不会失败。
 */
async function handleCodeArtsCallback(
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  path: string,
): Promise<Response> {
  // ── state：路径优先，其次 query ──
  let state = path.startsWith(`${CODEARTS_LOGIN_CALLBACK_PATH}/`)
    ? decodeURIComponent(path.slice(CODEARTS_LOGIN_CALLBACK_PATH.length + 1))
    : ''
  const params = url.searchParams
  if (state === '') state = params.get('state') ?? ''
  let secret = params.get('secret') ?? ''

  /**
   * ⚠️ **`fingerprint` 是华为的另一种回传形态**（实测用户反馈里出现）。
   *
   * 参考实现**同时**处理两种（`login.ts:187-200` 与 `:201`）：
   * - `?secret=<值>` → 拿它去 ticket 端点换凭据；
   * - `?fingerprint=<base64(URL)>` → 解出那个 URL，从它的 query 里取
   *   `token` / `access_token` / `accessToken` / `authCode`（`pickToken`，
   *   `login.ts:149-155`）。
   *
   * 我们的实现**原先只有 `secret` 分支** —— 若华为回的是 `fingerprint`，
   * 我们会直接判「回调参数不完整」，用户看到的就是一直等不到结果。
   *
   * ⚠️ `fingerprint` 里的 URL **未必带 token**：实测用户反馈里那个
   * fingerprint 解出来只是 `/doer/login?...` 自身的地址（没有 token 字段）——
   * 那种情况下它**不是**完成信号，应继续当作「等待中」，而不是报错。
   * 故这里只在**真的解出 token** 时才认它。
   */
  let fingerprintToken = ''
  const fingerprintRaw = params.get('fingerprint') ?? ''
  if (fingerprintRaw !== '') {
    try {
      // Workers 里没有 Buffer，用 atob 解 base64（含 URL-safe 变体）
      const normalized = fingerprintRaw.replaceAll('-', '+').replaceAll('_', '/')
      const decoded = atob(normalized)
      const inner = new URLSearchParams(new URL(decoded).search)
      fingerprintToken = inner.get('token')
        ?? inner.get('access_token')
        ?? inner.get('accessToken')
        ?? inner.get('authCode')
        ?? ''
    } catch {
      // 解码失败：不当作错误（它可能只是我们看不懂的中间态），继续走 secret 分支
    }
  }

  // ⚠️ 最坏情况的剥离：若华为把 `?secret=` 直接拼在了已有 query 后面，
  // 我们会解析出 `state = "<state>?secret=<secret>"`。把 secret 剥出来，
  // 否则 state 找不到会话、而 secret 又缺失 —— 表现为「回调页报参数缺失」。
  const questionMark = state.indexOf('?')
  if (questionMark >= 0) {
    const inner = new URLSearchParams(state.slice(questionMark + 1))
    if (secret === '') secret = inner.get('secret') ?? ''
    state = state.slice(0, questionMark)
  }

  // ⚠️ **诊断日志**（排查「登录后一直显示登录中」必需）。
  //
  // 用户报障：华为登录完成后面板一直停在「等待授权中…」。
  // 要判断是「浏览器压根没回跳到我们」还是「回跳了但参数形态与预期不符」，
  // 必须能看见**实际收到的参数名**。
  //
  // ⚠️ 只记**参数名与长度**，不记 `secret` 的值 —— 它是换取凭据的能力凭证，
  // 写进日志等于泄漏（日志会进面板、也可能被导出）。
  console.log(
    `[codearts-callback] 收到回跳：path=${path.slice(0, 60)} `
    + `params=[${[...params.keys()].join(',')}] `
    + `secretLen=${secret.length} stateLen=${state.length}`,
  )

  // 用户在华为页面上取消授权：不是错误，但要如实说明（参考实现只回 400）。
  const upstreamError = params.get('error') ?? params.get('error_code')
  if (upstreamError !== null && upstreamError !== '') {
    const description = params.get('error_description') ?? params.get('error_msg') ?? ''
    return loginCallbackPage({
      status: 400,
      ok: false,
      title: '授权未完成',
      detail: `华为侧返回了错误：${upstreamError}${description === '' ? '' : `（${description}）`}。请在面板重新发起登录。`,
    })
  }

  // ⚠️ `fingerprint` 里解出 token 时，它**等价于** `secret`（都是完成信号），
  // 故不能因为它没带 `secret` 就判「参数不完整」。
  // ⚠️ 第三种可能：华为**直接回传 token**（参考实现的 `pickToken` 就是为这条路径准备的，
  // 见 `login.ts:149-155`）。它认 `token` / `access_token` / `accessToken` / `authCode`。
  // 我们的实现原先只认 `secret` —— 若上游换成直接回传，我们会判「参数不完整」。
  const directToken = params.get('token')
    ?? params.get('access_token')
    ?? params.get('accessToken')
    ?? params.get('authCode')
    ?? ''
  if (directToken !== '') secret = secret === '' ? directToken : secret

  if (state === '' || (secret === '' && fingerprintToken === '')) {
    // ⚠️ 文案要点明**收到了什么**，便于用户与我们一起定位。
    // 实测用户反馈：华为把他送到了 `/doer/login?...&fingerprint=<base64(当前URL)>`，
    // 那个 fingerprint 解出来**不含 token** —— 即浏览器还没走到回调。
    // 只说「参数不完整」会让人以为是我们这边坏了。
    const got = [...params.keys()].join(', ') || '（无 query 参数）'
    return loginCallbackPage({
      status: 400,
      ok: false,
      title: '回调参数不完整',
      detail: `这次跳转没有带上可用于换取凭据的 state/secret（实际收到：${got}）。`
        + '请在面板重新发起登录；若反复出现，请把浏览器地址栏内容反馈给我们。',
    })
  }

  const saved = await findLoginSession(env, state)
  // ⚠️ **必须**校验 kind：会话是「谁」只能由服务端记的载荷说了算。
  // 不校验就等于允许用任意 state 把凭据写进任意供应商的流程里。
  if (saved === undefined || saved.payload['kind'] !== 'codearts') {
    return loginCallbackPage({
      status: 410,
      ok: false,
      title: '登录会话不存在或已过期',
      detail: '会话有效期 10 分钟（浏览器耗时过久会过期）。请回到面板重新点「发起登录」。',
    })
  }

  const ticketId = sessionString(saved.payload, 'ticketId')
  if (ticketId === '') {
    return loginCallbackPage({
      status: 410,
      ok: false,
      title: '登录会话已损坏',
      detail: '会话里没有 ticket_id，无法换取凭据。请在面板重新发起登录。',
    })
  }

  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(saved.realm))
  // ⚠️ 回写时必须用**会话原本的过期时刻**（载荷里自带的 `expiresAt`）。
  // 若写成 `Date.now() + TTL`，每次回跳都会把窗口续满 —— 一个被泄漏的 state
  // 就能被无限续期，能力凭证的窗口形同虚设。
  // （`getLoginSession` 不回传 expires_at，故创建会话时把它一并存进载荷。）
  const expiresAt = sessionNumber(saved.payload, 'expiresAt') ?? (Date.now() + CODEARTS_LOGIN_STATE_TTL_MS)
  const withSecret: Record<string, unknown> = { ...saved.payload, secret, secretAt: Date.now() }
  await pool.saveLoginSession(state, withSecret, expiresAt)

  // 后台尽力轮询：成功即把**凭据材料**写回会话，供 `/admin/providers/login/poll` 落盘。
  // ⚠️ 这里不调用 `persistProviderCredential`：落盘只有一条路（poll 端点），
  // 避免「回调写一次、轮询又写一次」两处各自演进。
  ctx.waitUntil(
    (async (): Promise<void> => {
      try {
        const material = await pollCodeArtsTicket(ticketId, secret, { maxAttempts: 8, gapMs: 1_000 })
        await pool.saveLoginSession(state, { ...withSecret, credential: material }, expiresAt)
      } catch (error) {
        // 超时是**预期的**（8 次拿不到就交给面板继续），不写任何标记；
        // 只有服务端明确拒绝（非瞬时）才记下原因，让面板如实显示而不是空等。
        const terminal = error instanceof ProviderError && !error.retryable
        if (!terminal) return
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[codearts-login] ticket 换取凭据被拒：${message}`)
        await pool.saveLoginSession(state, { ...withSecret, failed: message }, expiresAt)
      }
    })(),
  )

  return loginCallbackPage({
    status: 200,
    ok: true,
    title: '授权完成，请回到面板',
    detail: '浏览器这一程已经走完，本服务正在用华为回传的 secret 换取凭据。'
      + '请切回管理面板（本页可以关闭），凭据会自动加密保存到账号池。',
  })
}

/**
 * 完成一次 CodeArts 浏览器登录：把 ticket 换到的材料落盘成正式凭据。
 *
 * 两个来源，优先级明确：
 * 1. 会话里已有 `credential`（回调的后台轮询写进来的）⇒ 直接用；
 * 2. 否则自己再**打一次** ticket 端点（回调的 `waitUntil` 只有 30 秒预算，
 *    且可能被提前回收 ⇒ 面板轮询必须能独立完成这件事）。
 *
 * ⚠️ 单次尝试（不是循环）：面板每 3 秒轮询一次，**在这里空等会叠加**成并发
 * 轮询同一个 ticket。按一次的粒度做，整体节奏交给面板。
 */
async function pollCodeArtsLogin(
  env: Env,
  saved: { realm: string; payload: Record<string, unknown> },
  state: string,
  now: number,
): Promise<Response> {
  const payload = saved.payload
  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(saved.realm))

  // 终态失败：反复轮询不会有别的结果，如实复述原因（而不是让面板空等到超时）。
  const failed = sessionString(payload, 'failed')
  if (failed !== '') {
    return json({ done: false, status: 'failed', message: `CodeArts 登录失败：${failed}` })
  }

  let material: unknown = payload['credential']
  if (material === undefined) {
    const secret = sessionString(payload, 'secret')
    if (secret === '') {
      return json({
        done: false,
        status: 'awaiting_browser',
        // ⚠️ 文案里带上**自查方法**：这条分支意味着「浏览器还没回到本服务」。
        // 用户能据此区分「登录没做完」与「回调没接住」——
        // 前者继续操作即可，后者需要看浏览器地址栏并反馈给我们。
        message: '等待浏览器完成授权…（登录成功后浏览器应自动跳到本服务的「授权完成」提示页。'
          + '若浏览器停在华为页面不动、或跳到别处，请把地址栏内容反馈给我们）',
      })
    }
    const ticketId = sessionString(payload, 'ticketId')
    let outcome
    try {
      outcome = await fetchCodeArtsTicket(ticketId, secret)
    } catch (error) {
      // 明确被拒：记进会话，后续轮询复述同一原因（不静默、也不无限重试）。
      const message = error instanceof Error ? error.message : String(error)
      await pool.saveLoginSession(state, { ...payload, failed: message }, sessionNumber(payload, 'expiresAt') ?? now + CODEARTS_LOGIN_STATE_TTL_MS)
      return json({ done: false, status: 'failed', message: `CodeArts 登录失败：${message}` })
    }
    if (outcome.status === 'pending') {
      return json({ done: false, status: 'pending', message: '已收到授权回调，正在换取凭据…' })
    }
    material = outcome.credential
  }

  // ⚠️ 走 provider 自己的解析（同一套 uid / expiresAt / extras 规则），
  // 保证「登录进来」与「粘贴导入」落成**同一条**账号记录。
  const credential = codeArtsTicketCredentialToProvider(material as never)
  const result = await persistProviderCredential(env, credential, now)
  // 落盘成功后才清会话：失败时保留，用户可继续轮询重试。
  await pool.removeLoginSession(state)
  return json(result)
}

/**
 * 浏览器落点：`GET /login/trae/callback/<state>?<TRAE 回传的凭证>`（**免鉴权**）。
 *
 * ## 为什么不鉴权（以及凭什么安全）
 *
 * 与 codearts 完全同款（见 {@link handleCodeArtsCallback} 的说明）：浏览器是被
 * TRAE **重定向**过来的，带不了 `Authorization` 头，故改用 `state` 本身作为
 * 能力凭证 —— 32 字节 CSPRNG、绑定到一个**已经存在**的 `trae` 会话
 * （`kind === 'trae'`，供应商只来自会话载荷、**绝不**从 URL 取）、10 分钟过期。
 *
 * ## ⚠️ 与 codearts 的两处关键差异
 *
 * 1. **这里不换取凭据，只把材料写回会话。**
 *    TRAE 的 `ExchangeToken` 会**轮换** `refresh_token`（见 `trae.ts` 的
 *    {@link refresh}），而回调的 `ctx.waitUntil` 与面板轮询是**两个独立请求**。
 *    若两边都交换，第二次会用同一个旧 refreshToken 打上游 —— 必然失败，
 *    且可能把第一次拿到的凭据丢掉（`types.ts` 的「轮换型 refresh token 的
 *    操作纪律」）。codearts 能在回调里轮询是因为它的 ticket 换取是**幂等 GET**。
 * 2. **凭证材料必须落在会话里**（`callback` 字段），不能放模块内存 ——
 *    回调与轮询是两个 HTTP 请求，Workers 无跨请求内存（AGENTS.md §4.2）。
 *
 * ## 为什么不需要 `ctx.waitUntil`
 *
 * 这一程只做「解析 URL + 写一次 DO」，没有要等的上游请求，故同步完成即可。
 */
async function handleTraeCallback(
  env: Env,
  url: URL,
  path: string,
): Promise<Response> {
  // ── state：路径优先，其次 query ──
  let state = path.startsWith(`${TRAE_LOGIN_CALLBACK_PATH}/`)
    ? decodeURIComponent(path.slice(TRAE_LOGIN_CALLBACK_PATH.length + 1))
    : ''
  const params = url.searchParams
  if (state === '') state = params.get('state') ?? ''

  // ⚠️ 最坏情况的剥离：若 TRAE 把凭证直接拼在了已有 query 后面，我们会解析出
  // `state = "<state>?refreshToken=…"`（与 codearts 的 `?secret=` 同型风险）。
  // 把 query 部分还原成可解析的 search，否则 state 找不到会话、
  // 而凭证又读不到 —— 表现为「回调页报会话不存在」。
  const questionMark = state.indexOf('?')
  let search = params
  if (questionMark >= 0) {
    const inner = new URLSearchParams(state.slice(questionMark + 1))
    for (const [key, value] of inner) if (!search.has(key)) search.append(key, value)
    state = state.slice(0, questionMark)
  }

  // ⚠️ **诊断日志**（排查「登录后一直显示登录中」必需）。
  //
  // 要判断是「浏览器压根没回跳到我们」还是「回跳了但参数形态与预期不符」，
  // 必须能看见**实际收到的参数名**。
  //
  // ⚠️ 只记**参数名与长度**，不记 `refreshToken` / `userJwt` 的值 ——
  // 它们是能换取凭据的秘密，写进日志等于泄漏（日志会进面板、也可能被导出）。
  console.log(
    `[trae-callback] 收到回跳：path=${path.slice(0, 60)} `
    + `params=[${[...search.keys()].join(',')}] stateLen=${state.length}`,
  )

  // 用户在 TRAE 页面上取消授权：不是错误，但要如实说明。
  const upstreamError = search.get('error') ?? search.get('error_code')
  if (upstreamError !== null && upstreamError !== '') {
    const description = search.get('error_description') ?? search.get('error_msg') ?? ''
    return loginCallbackPage({
      status: 400,
      ok: false,
      title: '授权未完成',
      detail: `TRAE 侧返回了错误：${upstreamError}${description === '' ? '' : `（${description}）`}。请在面板重新发起登录。`,
    })
  }

  if (state === '') {
    return loginCallbackPage({
      status: 400,
      ok: false,
      title: '回调参数不完整',
      detail: '这次跳转没有带上 state。请在面板重新发起登录；'
        + '若反复出现，请改用「粘贴凭据导入」。',
    })
  }

  const saved = await findLoginSession(env, state)
  // ⚠️ **必须**校验 kind：会话是「谁」只能由服务端记的载荷说了算。
  // 不校验就等于允许用任意 state 把凭据写进任意供应商的流程里。
  if (saved === undefined || saved.payload['kind'] !== 'trae') {
    return loginCallbackPage({
      status: 410,
      ok: false,
      title: '登录会话不存在或已过期',
      detail: '会话有效期 10 分钟（浏览器耗时过久会过期）。请回到面板重新点「发起登录」。',
    })
  }

  // ⚠️ 从**拼好的 search** 重建相对 URL 交给 provider 解析：这样上面剥离出来的
  // `state?refreshToken=…` 形态也能被正常解出（provider 只关心凭证参数）。
  const parsed = parseTraeCallback(`/login/trae/callback?${search.toString()}`)
  if (!parsed.ok) {
    // ⚠️ **必须把失败也写回会话**：否则面板只能一直等到超时，
    // 用户看到的是「一直在等待」，而真实原因是「上游换了流程」或「参数名变了」。
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(saved.realm))
    const expiresAt = sessionNumber(saved.payload, 'expiresAt') ?? (Date.now() + TRAE_LOGIN_STATE_TTL_MS)
    await pool.saveLoginSession(state, { ...saved.payload, failed: parsed.reason }, expiresAt)
    return loginCallbackPage({
      status: 400,
      ok: false,
      title: '回调无法解析',
      detail: `${parsed.reason}。请在面板重新发起登录；若反复出现，请改用「粘贴凭据导入」。`,
    })
  }

  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(saved.realm))
  // ⚠️ 回写时必须用**会话原本的过期时刻**（载荷里自带的 `expiresAt`）。
  // 若写成 `Date.now() + TTL`，每次回跳都会把窗口续满 —— 一个被泄漏的 state
  // 就能被无限续期，能力凭证的窗口形同虚设（与 codearts 同款理由）。
  const expiresAt = sessionNumber(saved.payload, 'expiresAt') ?? (Date.now() + TRAE_LOGIN_STATE_TTL_MS)
  await pool.saveLoginSession(
    state,
    { ...saved.payload, callback: parsed.info, callbackAt: Date.now() },
    expiresAt,
  )

  return loginCallbackPage({
    status: 200,
    ok: true,
    title: '授权完成，请回到面板',
    detail: '浏览器这一程已经走完。请切回管理面板（本页可以关闭），'
      + '凭据会自动加密保存到账号池。',
  })
}

/**
 * 完成一次 TRAE 浏览器登录：用回调写下的材料换凭据并落盘。
 *
 * ⚠️ **只有这里调 `ExchangeToken`**（回调只解析、不交换）—— 理由见
 * {@link handleTraeCallback} 的差异说明：该端点会轮换 refreshToken，
 * 两处都调会让第二次必然失败。
 *
 * ⚠️ 单次尝试（不是循环）：面板每 3 秒轮询一次，在这里空等会叠加成并发请求。
 */
async function pollTraeLogin(
  env: Env,
  saved: { realm: string; payload: Record<string, unknown> },
  state: string,
  now: number,
): Promise<Response> {
  const payload = saved.payload
  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(saved.realm))

  // 终态失败：反复轮询不会有别的结果，如实复述原因（而不是让面板空等到超时）。
  const failed = sessionString(payload, 'failed')
  if (failed !== '') {
    return json({ done: false, status: 'failed', message: `TRAE 登录失败：${failed}` })
  }

  // 已有材料 ⇒ 只做「换凭据 + 落盘」，不再看浏览器那一程。
  // 还没有 ⇒ 说明回调尚未到达，如实告诉面板「等浏览器」。
  //
  // ⚠️ 换取失败**不写 `failed`**：`ExchangeToken` 的 5xx / 429 是瞬时的
  // （`traePostJson` 已标 `retryable`），写死会让用户必须重新发起登录；
  // 而面板会继续轮询，下一次很可能就成功。只有明确的 4xx 才值得记成终态。
  const material = payload['callback']
  if (material === undefined || typeof material !== 'object' || material === null) {
    return json({
      done: false,
      status: 'awaiting_browser',
      message: '等待浏览器完成授权…（登录后浏览器会跳到本服务的提示页，回到本面板即可）',
    })
  }

  const machineId = sessionString(payload, 'machineId')
  const deviceId = sessionString(payload, 'deviceId')
  if (machineId === '' || deviceId === '') {
    return json({
      done: false,
      status: 'failed',
      message: 'TRAE 登录失败：登录会话缺少 machine_id / device_id，请重新发起登录',
    })
  }

  let credential: ProviderCredential
  try {
    credential = await exchangeTraeCallback(
      material as never,
      { machineId, deviceId },
      { nowMs: now },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const terminal = error instanceof ProviderError && !error.retryable
    if (terminal) {
      const expiresAt = sessionNumber(payload, 'expiresAt') ?? (now + TRAE_LOGIN_STATE_TTL_MS)
      await pool.saveLoginSession(state, { ...payload, failed: message }, expiresAt)
      return json({ done: false, status: 'failed', message: `TRAE 登录失败：${message}` })
    }
    // 瞬时失败：如实回一句，会话保留，面板下一次轮询会重试。
    return json({ done: false, status: 'pending', message: `换取凭据失败，正在重试：${message}` })
  }

  const result = await persistProviderCredential(env, credential, now)
  // 落盘成功后才清会话：失败时保留，用户可继续轮询重试。
  await pool.removeLoginSession(state)
  return json(result)
}

/**
 * Worker 的 `fetch` 入口 —— **带兜底的异常边界**。
 *
 * ## 🔴 为什么必须包这一层（实测缺陷）
 *
 * 原先 `export default { fetch: handle }` 直接暴露业务函数，而 `handle`
 * **完全没有 try/catch**。于是任何一个未捕获的抛出（provider 里某个
 * 解析分支、DO RPC、上游返回了意外形状…）都会变成 Cloudflare 的
 * **裸 `error code: 1101`**：
 *
 * - 客户端只看到 `error code: 1101` + HTTP 500，**不知道发生了什么**；
 * - 我们这边也拿不到可读原因（日志里只有 CF 的内部码）；
 * - 实测触发场景：qoder 排队 3 轮耗尽后（约 122s）抛出的路径。
 *
 * ⚠️ 这与本项目「**绝不静默失败**」（§7.2）的纪律直接冲突 ——
 * `1101` 就是最彻底的静默失败：既没有原因，也没有可操作信息。
 *
 * 故这里加一层边界：把抛出转成**带可读原因**的 500 JSON，
 * 同时在日志里打出完整堆栈（`console.error` 会进 Workers Logs）。
 *
 * ⚠️ **只兜异常，不改行为**：正常路径一个字节都不受影响。
 */
async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    return await handleInner(request, env, ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? (error.stack ?? '') : ''
    // ⚠️ 打完整堆栈进 Workers Logs —— 否则排查时只剩一个 1101。
    // 请求信息也打上（路径 + 方法），但**绝不打 Authorization**。
    const url = (() => { try { return new URL(request.url) } catch { return undefined } })()
    console.error(
      `[unhandled] ${request.method} ${url?.pathname ?? '(bad url)'} → ${message}\n${stack}`,
    )
    // 回给客户端**可读原因**（而不是 `error code: 1101`）。
    return new Response(
      JSON.stringify({
        error: {
          message: `服务内部错误：${message}`,
          type: 'internal_error',
          code: 'internal_error',
        },
      }),
      { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
    )
  }
}

/** 真正的业务路由（异常由上面的 {@link handle} 统一兜住）。 */
async function handleInner(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname

  // ── 免鉴权：存活探针（不含任何敏感信息） ──
  if (path === '/healthz') {
    return json({ ok: true, service: 'free-llm-router' })
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

  // ── CodeArts 浏览器登录回调（**免鉴权**，见 handleCodeArtsCallback 的说明） ──
  //
  // ⚠️ 必须放在下面的鉴权检查**之前**：浏览器是被华为重定向过来的，
  // 带不了 `Authorization` 头。安全性由 `state`（32 字节 CSPRNG + 10 分钟 TTL
  // + 绑定 codearts 会话）保证，不靠密钥。
  if (path === CODEARTS_LOGIN_CALLBACK_PATH || path.startsWith(`${CODEARTS_LOGIN_CALLBACK_PATH}/`)) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET', ...securityHeaders() } })
    }
    return await handleCodeArtsCallback(env, ctx, url, path)
  }

  // ── TRAE 浏览器登录回调（**免鉴权**，见 handleTraeCallback 的说明） ──
  //
  // ⚠️ 与 codearts 同款，必须在鉴权检查**之前**：浏览器是被 TRAE 重定向过来的。
  // 安全性由 `state`（32 字节 CSPRNG + 10 分钟 TTL + 绑定 trae 会话）保证。
  if (path === TRAE_LOGIN_CALLBACK_PATH || path.startsWith(`${TRAE_LOGIN_CALLBACK_PATH}/`)) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET', ...securityHeaders() } })
    }
    return await handleTraeCallback(env, url, path)
  }

  // ── 其余一律鉴权 ──
  if (!(await authorized(request, env))) {
    return json({ error: { message: 'Missing or invalid API key', type: 'authentication_error' } }, 401)
  }

  // ── 登录：发起（返回授权 URL 给前端/用户） ──
  if (path === '/admin/login/start' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { realm?: string; provider?: string }
    // ⚠️ 按供应商选登录域：
    // - `buddy`（国内版）→ `copilot.tencent.com`
    // - `workbuddy`（国际版）→ `www.workbuddy.ai`
    // 两家的 `/v2/plugin/auth/state` 协议完全相同，只是域名不同
    // （实测国际版返回 `https://www.workbuddy.ai/login?platform=CLI&state=...`）。
    const loginProvider = body.provider ?? DEFAULT_PROVIDER
    // ⚠️ **realm 由供应商决定，不由客户端决定**。
    // 国际版账号必须落 `global` 分片，且会话也必须存在同一个分片里，
    // 否则轮询时找不到会话（轮询按 realm 分片逐个查）。
    // 面板历史上对所有供应商都传 `realm: 'cn'` —— 一律照收的话，
    // 国际版账号会被存进 `cn` 分片，表现为「登录成功但账号列表里没有它」。
    const realm = loginProvider === WORKBUDDY_INTL.id ? 'global' : (body.realm ?? 'cn')
    const bases = resolveUpstream(env)
    const chatBase = loginProvider === WORKBUDDY_INTL.id ? WORKBUDDY_INTL.chatBase : bases.chat
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
      const session = (await pool.getLoginSession(state, now)) as
        | { realm: string; provider?: string; createdAt: number }
        | undefined
      if (session === undefined) continue

      // ⚠️ 按**会话里记的供应商**选登录域与 realm：
      // 会话是发起时写下的，比客户端在轮询阶段的任何输入都可信。
      const providerId = session.provider ?? DEFAULT_PROVIDER
      const bases = resolveUpstream(env)
      const chatBase = providerId === WORKBUDDY_INTL.id ? WORKBUDDY_INTL.chatBase : bases.chat
      const sessionRealm = providerId === WORKBUDDY_INTL.id ? 'global' : session.realm

      let credential
      try {
        credential = await pollLogin({ chatBase, realm: sessionRealm, state })
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

      // ⚠️ 落盘走与其它供应商**同一条路**（`persistProviderCredential`）。
      //
      // 之前这里直接存 `pollLogin` 的原始结果（`LoginCredential`），
      // 它**没有 `provider` 与 `extras`** —— 于是：
      // 1. `buddy.refresh()` 读 `credential.extras['realm']` 会抛 TypeError，
      //    表现为「登录进来的账号一到期就废」；
      // 2. 国际版凭据的 `extras.realm` 丢失，账号落不到 `global` 分片。
      // 转换一次即两个问题同时消掉，且与 `/admin/import` 的落盘形状一致。
      const providerCredential = toProviderCredential(providerId, { ...credential, realm: sessionRealm })
      const result = await persistProviderCredential(env, providerCredential, now)
      // 只有在**落盘成功之后**才清会话 —— 失败时保留，用户可继续轮询重试
      await pool.removeLoginSession(state)

      // ⚠️ 只回非敏感字段：**绝不回 token**
      return json({ ...result, encrypted: true })
    }

    return json({ error: { message: 'unknown or expired state（请重新发起登录）', type: 'unknown_state' } }, 404)
  }

  // ── 删除账号（连带凭据；不可逆，故要求显式确认字段） ──
  // ── 按账号启用/停用（面板的「停用 / 启用」按钮） ──
  //
  // ⚠️ 与 `/admin/accounts/remove` 的区别：这个**可逆**，故**不需要 confirm**。
  // 用户点错了再点一次就好，加确认反而烦。
  if (path === '/admin/accounts/toggle' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as {
      uid?: string; realm?: string; disabled?: boolean
    }
    if (typeof body.uid !== 'string' || body.uid === '') {
      return json({ error: { message: 'uid 必填' } }, 400)
    }
    if (typeof body.disabled !== 'boolean') {
      return json({ error: { message: 'disabled 必须是布尔值' } }, 400)
    }
    const realm = body.realm ?? 'cn'
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const ok = await pool.setAccountDisabled(body.uid, body.disabled, Date.now())
    if (!ok) return json({ error: { message: '账号不存在' } }, 404)
    return json({ ok: true, uid: body.uid, disabled: body.disabled, realm })
  }

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
    const body = (await request.json().catch(() => ({}))) as {
      provider?: string; realm?: string; phone?: string
    }
    const providerId = body.provider ?? ''
    // ⚠️ 会话分片必须与**账号将要落入的分片**一致，否则轮询时找不到会话
    //（轮询按 realm 逐个分片查，见 `/admin/providers/login/poll`）。
    const loginRealm = body.realm ?? (providerId === WORKBUDDY_INTL.id ? 'global' : 'cn')
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(loginRealm))

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
    // ── codearts（华为云码道）：浏览器回跳式 ticket 流程 ──
    //
    // ⚠️ 与其它家**不同**的地方（也是本分支存在的理由）：回调不是本机端口，
    // 而是**本服务自己的 URL**（`auth_callback_url` 是通用参数，
    // 参考实现 `login.ts:26` 填的是 `http://127.0.0.1:<port>/authentication`）。
    // ⚠️ **未实测**：华为是否接受非 localhost 的 callback。见 codearts.ts 文件头。
    //
    // `state` 用 32 字节 CSPRNG（不是 randomUUID）：它是这条免鉴权路径上
    // **唯一**的能力凭证 —— 谁拿到 state，谁就能把浏览器的回跳绑到该会话。
    // 它同时用于「回调 URL 的路径段」与「登录会话主键」，两者必须是**同一个值**。
    if (providerId === 'codearts') {
      const ticketId = crypto.randomUUID()
      const state = generateCodeArtsLoginState()
      // 回调地址取**本次请求的 origin** —— 自定义域与 workers.dev 都自动正确。
      const callbackUrl = buildCodeArtsCallbackUrl(url.origin, state)
      const { loginUrl } = buildCodeArtsLoginUrl(callbackUrl, ticketId)
      const expiresAt = Date.now() + CODEARTS_LOGIN_STATE_TTL_MS
      // ⚠️ `expiresAt` 也存进载荷：回调回写 secret 时要沿用它（否则每次回跳
      // 都会把窗口续满，`getLoginSession` 不回传 expires_at，见 store/db.ts:128）。
      await pool.saveLoginSession(
        state,
        {
          provider: 'codearts',
          kind: 'codearts',
          realm: loginRealm,
          ticketId,
          callbackUrl,
          createdAt: Date.now(),
          expiresAt,
        },
        expiresAt,
      )
      return json({
        ok: true,
        provider: 'codearts',
        state,
        authUrl: loginUrl,
        callbackUrl,
        realm: loginRealm,
        expiresInMs: CODEARTS_LOGIN_STATE_TTL_MS,
      })
    }
    // ── trae（字节 TRAE）：浏览器回跳 + ExchangeToken ──
    //
    // 与 codearts 同型（回调指向**本服务自己的 URL**），但有两处必须照抄的差异：
    //
    // 1. `machine_id` / `device_id` 必须**本次生成并持久化进凭据**
    //    （`trae.ts:17-19`）：它们是设备指纹与签到设备号，且 `device_id`
    //    **逐账号必须互异**（同一天两个账号共用会被「该设备已签到」拦截）。
    //    两者都是 **32 位 hex** —— 不是 16 位纯数字（那是 CodeBuddy 的格式）。
    // 2. `auth_callback_url` 必须是**我们自己的 URL**。参考实现写死
    //    `http://127.0.0.1:18080/authorize`（`trae-oauth.ts:4-11`），那是宿主的
    //    限制；该参数由我们构造并随登录 URL 一起发给 TRAE。
    //    ⚠️ **未验证**：TRAE 是否接受非 localhost 的回调地址 —— 见 trae.ts 文件头。
    //
    // `state` 用 32 字节 CSPRNG（不是 randomUUID）：它是这条免鉴权路径上
    // **唯一**的能力凭证 —— 谁拿到 state，谁就能把浏览器的回跳绑到该会话。
    // 它同时是「回调 URL 的路径段」与「登录会话主键」，必须是**同一个值**。
    if (providerId === 'trae') {
      const state = generateTraeLoginState()
      const machineId = generateMachineId()
      const deviceId = generateDeviceId()
      // 回调地址取**本次请求的 origin** —— 自定义域与 workers.dev 都自动正确。
      const callbackUrl = buildTraeCallbackUrl(url.origin, state)
      const authUrl = buildTraeLoginURL(machineId, deviceId, callbackUrl)
      const expiresAt = Date.now() + TRAE_LOGIN_STATE_TTL_MS
      // ⚠️ `expiresAt` 也存进载荷：回调回写凭证时要沿用它（否则每次回跳都会把
      // 窗口续满 —— `getLoginSession` 不回传 expires_at，见 store/db.ts:128）。
      await pool.saveLoginSession(
        state,
        {
          provider: 'trae',
          kind: 'trae',
          realm: loginRealm,
          machineId,
          deviceId,
          callbackUrl,
          createdAt: Date.now(),
          expiresAt,
        },
        expiresAt,
      )
      return json({
        ok: true,
        provider: 'trae',
        state,
        authUrl,
        callbackUrl,
        realm: loginRealm,
        expiresInMs: TRAE_LOGIN_STATE_TTL_MS,
      })
    }
    // ── raccoon（商汤小浣熊）：微信扫码，二维码由**本服务**渲染 ──
    //
    // ⚠️ 与其余家最关键的不同：**没有「服务端下发二维码」这一步**。
    // `qrcode_code` 是**客户端自造**的 32 位 hex（参考实现
    // `src/raccoon-oauth.ts:112-118`），二维码内容是我们自己拼的公开登录页
    //（`buildQrLoginUrl`），服务端只在轮询时认这个 code。
    //
    // 故这条流程**不需要用户点开任何外部链接**：面板直接内联 SVG，
    // 用户用微信扫即可 —— 比「打开浏览器 → 登录 → 回跳」的家更省事。
    //
    // 为什么值得做（用户诉求）：本地 DSH 客户端与本服务此前**共用同一份凭据文件**，
    // 而 raccoon 的 `refresh_token` 是**一次性轮换**的 —— 两边互相续期会把对方顶掉，
    // 账号「用一天就废」。本服务自己扫码后即拥有独立凭据，两边不再打架。
    //
    // ⚠️ 会话存 `cn` 分片：raccoon 的凭据不带 `extras.realm`，
    // 与 buddy 同属国内分片（见 `realmForProvider`）。
    if (providerId === 'raccoon') {
      const { beginRaccoonQrLogin } = await import('./providers/raccoon.js')
      const started = beginRaccoonQrLogin()
      const state = crypto.randomUUID()
      await pool.saveLoginSession(
        state,
        {
          provider: 'raccoon',
          kind: 'raccoon',
          realm: loginRealm,
          // ⚠️ 存 `qrcode_code`：轮询时必须原样回传，丢了就再也查不到这个会话
          qrCode: started.code,
          createdAt: Date.now(),
        },
        Date.now() + RACCOON_LOGIN_STATE_TTL_MS,
      )
      return json({
        ok: true,
        provider: 'raccoon',
        state,
        // 面板把 `qrSvg` 直接插进 DOM（无需前端 QR 库）；`qrUrl` 供「复制链接」兜底。
        qrSvg: started.qrSvg,
        qrUrl: started.qrUrl,
        realm: loginRealm,
        expiresInMs: RACCOON_LOGIN_STATE_TTL_MS,
      })
    }
    // ── cline：WorkOS 设备码（**用户码**式，不是扫码也不是回跳） ──
    //
    // ⚠️ 与其余家的关键不同：授权页要用户**手输一个 user code**，
    // 故返回体里带 `userCode`（面板必须显眼地展示它，而不是只给一个链接）。
    //
    // 三步协议（`src/providers/cline.ts` 的「设备码登录」小节，
    // 原始依据 `deepseek-harness-codearts/src/cline-oauth.ts:18-38`）：
    // ① 拿设备码 → ② 轮询 WorkOS token → ③ 注册成 Cline 自己的 token。
    // **第 ③ 步不能省**：WorkOS 的 token 只是「证明你是谁」。
    //
    // ⚠️ 会话里的 `intervalMs` / `nextPollAt` / `deadline` 是**必须持久化**的：
    // 面板每 3 秒发一个**独立** HTTP 请求来轮询，而 Workers 没有跨请求内存
    // —— 把间隔放在模块变量里会随 isolate 回收丢失，于是 `slow_down` 的
    // 累积退避**静默失效**（表现为被 WorkOS 持续限流）。
    //
    // cline 属 `cn` 分片（凭据不带 `extras.realm`，与 buddy 同域）。
    if (providerId === 'cline') {
      const { requestClineDeviceAuthorization } = await import('./providers/cline.js')
      try {
        const started = await requestClineDeviceAuthorization({ signal: AbortSignal.timeout(30_000) })
        const state = crypto.randomUUID()
        const now = Date.now()
        // 设备码自身有效期（上游 `expires_in`，缺省 5 分钟）就是会话期限 ——
        // 会话比设备码活得久没有意义（轮询只会得到 expired_token）。
        const deadline = now + started.expiresInMs
        // ⚠️ 会话 TTL 比 `deadline` **多留 {@link CLINE_LOGIN_SESSION_GRACE_MS}**：
        // 理由见该常量的注释（不留的话设备码一过期，轮询只会拿到
        // 没有 `status` 的「会话不存在」，面板会一直空等）。
        const sessionTtl = deadline + CLINE_LOGIN_SESSION_GRACE_MS
        await pool.saveLoginSession(
          state,
          {
            provider: 'cline',
            kind: 'cline',
            realm: loginRealm,
            deviceCode: started.deviceCode,
            userCode: started.userCode,
            verificationUri: started.verificationUri,
            ...started.verificationUriComplete === undefined
              ? {}
              : { verificationUriComplete: started.verificationUriComplete },
            intervalMs: started.intervalMs,
            // 首次轮询也要等满一个 interval（设备码规范要求）
            nextPollAt: now + started.intervalMs,
            deadline,
            createdAt: now,
          },
          sessionTtl,
        )
        return json({
          ok: true,
          provider: 'cline',
          state,
          userCode: started.userCode,
          verificationUri: started.verificationUri,
          // ⚠️ 没有就不编造：面板会回落到 `verificationUri`（用户多输一次 code）
          ...started.verificationUriComplete === undefined
            ? {}
            : { verificationUriComplete: started.verificationUriComplete },
          // `requestClineDeviceAuthorization` 已保证该值 > 0（非法值回落到默认）
          expiresInMs: started.expiresInMs,
          realm: loginRealm,
        })
      } catch (error) {
        return json(
          {
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: 'login_start_failed',
            },
          },
          502,
        )
      }
    }

    // ── minimax（MiniMax Code 中国版）：OAuth 设备码 + PKCE 轮询 ──
    //
    // ⚠️ 与 cline 同型（设备码 + 用户码），但三处判据不同，写错会得到
    //「用户还没来得及点授权就报失败」：
    // 1. `pending` 是 **HTTP 200 + status**，而标准 OAuth 是
    //    **非 200 + error=authorization_pending** —— **两种都要认**；
    // 2. PKCE 是 **S256**（`crypto.subtle.digest`，无需 `node:crypto`）；
    // 3. `slow_down` 退避是 **+5 秒**（cline 是 +1），且**累积**。
    // 依据：`deepseek-harness-codearts/src/minimax-oauth.ts:10-16,196-201,276-280`。
    //
    // ⚠️ 账号域是 `account.minimax.cn`，业务域是 `agent.minimax.cn` —— 不可混用。
    if (providerId === 'minimax') {
      const { startMinimaxLogin } = await import('./providers/minimax.js')
      try {
        const started = await startMinimaxLogin(AbortSignal.timeout(30_000))
        const state = crypto.randomUUID()
        const now = Date.now()
        const deadline = now + started.expiresInSec * 1000
        const sessionTtl = deadline + CLINE_LOGIN_SESSION_GRACE_MS
        await pool.saveLoginSession(
          state,
          {
            provider: 'minimax',
            kind: 'minimax',
            realm: loginRealm,
            // ⚠️ 设备码 + PKCE verifier 都必须持久化：Workers 无跨请求内存，
            // 放在模块变量里 isolate 一回收就丢，续期/轮询会静默失败。
            deviceCode: started.deviceCode,
            codeVerifier: started.codeVerifier,
            userCode: started.userCode,
            verificationUri: started.verificationUri,
            verificationUriComplete: started.verificationUriComplete,
            intervalSec: started.intervalSec,
            // 首次轮询也要等满一个 interval（设备码规范要求）
            nextPollAt: now + started.intervalSec * 1000,
            deadline,
            createdAt: now,
          },
          sessionTtl,
        )
        return json({
          ok: true,
          provider: 'minimax',
          state,
          userCode: started.userCode,
          verificationUri: started.verificationUri,
          verificationUriComplete: started.verificationUriComplete,
          expiresInMs: started.expiresInSec * 1000,
          realm: loginRealm,
        })
      } catch (error) {
        return json(
          {
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: 'login_start_failed',
            },
          },
          502,
        )
      }
    }

    // ── loomy（讯飞办公助手）：**短信验证码**登录 ──
    //
    // ## ⚠️ 与其它家都不同：它**没有 loginUrl**，要用户输入
    //
    // 参考实现的注释写得很清楚（`src/loomy-oauth.ts:6-7`）：
    // > 那 7 个都是「返回 loginUrl → 前端 window.open → 轮询 login.poll」。
    // > 短信登录**没有 URL 可打开**，故走「发验证码 → 用户输入 → 提交」三步。
    //
    // ## ✅ 为什么它在 Workers 上**可行**（与微信扫码相反）
    //
    // 短信路径是**纯 HTTP 三步**，`loomy-oauth.ts` 里 `127.0.0.1` 出现 **0 次**
    //（实测 grep）—— 不需要任何本地回调监听。
    // ⚠️ 而 loomy 的**微信扫码**路径需要本地服务器承载弹窗页
    //（`loomy-wechat-login.ts:11-13` 的 `127.0.0.1:随机端口`），那条**不可行**。
    //
    // ## 流程
    //
    // 1. `POST {provider:'loomy', phone}` → 发短信，返回 `state`（存 msgid）
    // 2. `POST {provider:'loomy', phone, code, state}` → 校验，拿 session/userid
    //
    // ⚠️ `msgid` 必须持久化在登录会话里（Workers 无跨请求内存）——
    // 丢了它第二步会被服务端判「msgid 无效」，而那个报错与真实原因无关
    //（参考实现 `loomy-oauth.ts:141-144` 专门为此不返回空串）。
    if (providerId === 'loomy') {
      const { sendLoomySmsCode } = await import('./providers/loomy.js')
      // 🔴 **必须复用上面已经解析过的 `body`，不能再次 `request.json()`**。
      //
      // ## 实测缺陷（用户报「明明是 11 位号码却发不了验证码」）
      //
      // 原先这里写了 `await request.json()` **第二次**。而 HTTP 请求体是
      // **一次性流** —— 第二次读会抛 `TypeError: body used already`
      //（或 `Unexpected end of JSON input`），被 `.catch(() => ({}))` 吞掉后
      // `phone` 恒为 `''` ⇒ **任何号码都被判「请填写 11 位手机号」**。
      //
      // ⚠️ 症状极具误导性：错误文案说的是「号码格式不对」，而真实原因是
      // **我们没读到号码**。用户会反复检查自己输入的号码。
      // ⚠️ 这类「静默吞掉解析异常」的写法正是本项目明令禁止的
      //（AGENTS.md §7.2「失败必须显式」）—— `.catch(() => ({}))` 让一个
      // 必然失败的操作看起来像「用户传了空值」。
      const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
      // ⚠️ 只做**最基本的**格式检查（11 位数字，1 开头）—— 详细的号码规则
      // 交给上游判（它才知道哪些号段可用）。这里拦的是明显的空值/乱填。
      if (!/^1\d{10}$/.test(phone)) {
        return jsonError(400, '请填写 11 位手机号（以 1 开头）', 'invalid_phone')
      }
      try {
        const msgid = await sendLoomySmsCode(phone, AbortSignal.timeout(30_000))
        const state = crypto.randomUUID()
        const now = Date.now()
        // 验证码 5 分钟有效（`LOOMY_SMS_CODE_TTL_SECONDS`）。
        await pool.saveLoginSession(
          state,
          { provider: 'loomy', kind: 'loomy-sms', realm: loginRealm, phone, msgid, createdAt: now },
          // ⚠️ TTL 用**上游的验证码有效期**，不留宽限：码过期后再提交
          // 必然是「验证码错误」，多留时间只会让用户白等。
          5 * 60 * 1000,
        )
        return json({ ok: true, provider: 'loomy', state, phone, needsCode: true })
      } catch (error) {
        return json(
          { error: { message: error instanceof Error ? error.message : String(error), type: 'login_start_failed' } },
          502,
        )
      }
    }
    // ── workbuddy（国际版）：与 buddy 同一套设备码协议，只是换域名 ──
    //
    // ⚠️ 这条分支此前**缺失**，故 `/admin/login/start?provider=workbuddy` 会
    // 落到下面的 501（登录不支持）—— 国际版账号只能靠粘贴凭据导入。
    //
    // 协议逐项对照（国际版与国内版**完全同形**，只有域名不同）：
    // - `POST {base}/v2/plugin/auth/state?platform=CLI` → `state` + `authUrl`
    //   （参考实现 `deepseek-harness-codearts/src/buddy-oauth.ts:134-166`；
    //    入口函数 `src/upstream/auth.ts:96-119` 的 `startLogin`，此处复用）；
    // - 轮询 `GET /v2/plugin/auth/token`、取账号 `GET /v2/plugin/login/account`
    //   （`src/upstream/auth.ts:129-200` 的 `pollLogin`）。
    //
    // ⚠️ realm 必须是 `global`：它决定账号落哪个 `AccountPoolDO` 分片，
    // 也是 `refreshCredential` 选续期域的依据
    //（`global` → `www.workbuddy.ai`，见 `src/upstream/auth.ts:266`）。
    // 且国际版必须**显式传 realm**，不能靠 domain 兜底 —— 见 `toProviderCredential`。
    if (providerId === WORKBUDDY_INTL.id) {
      try {
        const { state, authUrl } = await startLogin({ chatBase: WORKBUDDY_INTL.chatBase, realm: 'global' })
        await pool.saveLoginSession(
          state,
          { realm: 'global', provider: WORKBUDDY_INTL.id, kind: 'buddy', createdAt: Date.now() },
          Date.now() + LOGIN_STATE_TTL_MS,
        )
        return json({
          ok: true,
          provider: WORKBUDDY_INTL.id,
          state,
          authUrl,
          realm: 'global',
          expiresInMs: LOGIN_STATE_TTL_MS,
        })
      } catch (error) {
        return json(
          {
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: 'login_start_failed',
            },
          },
          502,
        )
      }
    }
    return jsonError(
      501,
      `供应商「${providerId}」不支持从本服务发起登录（${providerId === DEFAULT_PROVIDER ? '请用 /admin/login/start' : '请粘贴凭据导入'}）`,
      'login_unsupported',
    )
  }

  // ── loomy 短信登录第 2 步：提交验证码 ──
  //
  // ⚠️ 为什么单独一个端点而不是复用 `/login/poll`：
  // 短信登录**不是轮询** —— 它是「用户输入后主动提交」。
  // 塞进 poll（那是个按 state 查询的 GET）会让两种语义混在一处：
  // poll 是**幂等只读**，而这个**会消费验证码**（提交即用掉）。
  // ⚠️ 更不能做成 GET：验证码会进 URL，落进日志与 Referer。
  if (path === '/admin/providers/login/loomy/sms' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as {
      state?: string; phone?: string; code?: string; realm?: string
    }
    const state = typeof body.state === 'string' ? body.state : ''
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    if (state === '') return jsonError(400, 'state 必填（重新发起登录）', 'missing_state')
    if (!/^\d{4,8}$/.test(code)) return jsonError(400, '请填写收到的验证码', 'invalid_code')

    const realm = body.realm === 'global' ? 'global' : 'cn'
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const saved = await (async () => {
      // 逐个分片找（与 `/login/poll` 同法：会话所在分片由发起时决定）
      for (const r of [realm, realm === 'cn' ? 'global' : 'cn']) {
        const p = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(r))
        const hit = (await p.getLoginSession(state, Date.now())) as
          | { payload: Record<string, unknown>; pool: typeof p }
          | undefined
        if (hit !== undefined) return { payload: hit.payload, pool: p }
      }
      return undefined
    })()
    if (saved === undefined) {
      return jsonError(404, '登录会话不存在或已过期，请重新发起登录', 'session_not_found')
    }
    if (saved.payload['kind'] !== 'loomy-sms') {
      return jsonError(400, '该会话不是短信登录，请重新发起', 'wrong_flow')
    }
    const msgid = typeof saved.payload['msgid'] === 'string' ? saved.payload['msgid'] : ''
    const phone = typeof saved.payload['phone'] === 'string' ? saved.payload['phone'] : ''
    if (msgid === '' || phone === '') {
      await saved.pool.removeLoginSession(state)
      return jsonError(400, '登录会话缺少 msgid/phone，请重新发起登录', 'session_incomplete')
    }

    const { loginLoomyBySmsCode } = await import('./providers/loomy.js')
    try {
      const result = await loginLoomyBySmsCode(phone, code, msgid, AbortSignal.timeout(30_000))
      // ⚠️ 验证码是**一次性**的：无论成败都清掉会话，
      // 免得用户拿同一个码重复提交（上游会回「已使用」，那个报错会让人困惑）。
      await saved.pool.removeLoginSession(state)
      return json(await persistProviderCredential(env, result.credential, Date.now()))
    } catch (error) {
      // ⚠️ 失败**也清会话**（同上：码已消费）。用户需要重新发码。
      await saved.pool.removeLoginSession(state)
      const message = error instanceof Error ? error.message : String(error)
      // ⚠️ 文案要说清「下一步做什么」：用户卡在这里最需要知道的是「重新获取验证码」。
      return json(
        { error: { message: `验证码校验失败：${message}。请重新获取验证码后再试。`, type: 'sms_failed' } },
        400,
      )
    }
  }

  // ── 轮询供应商登录结果 ──
  if (path === '/admin/providers/login/poll' && request.method === 'GET') {
    const state = url.searchParams.get('state') ?? ''
    // ⚠️ 会话按 realm 分片存放（国际版的在 `global`，其余家在 `cn`）。
    // 查找规则见 findLoginSession（**浏览器的回调路径用的是同一个函数**）。
    const saved = await findLoginSession(env, state)
    if (saved === undefined) return json({ done: false, message: '会话不存在或已过期' })

    const now = Date.now()
    try {
      if (saved.payload['kind'] === 'buddy') {
        // ── 设备码登录（buddy 国内版 / workbuddy 国际版），与 `/admin/login/poll` 同口径 ──
        const realm = typeof saved.payload['realm'] === 'string' ? saved.payload['realm'] : saved.realm
        const providerId = typeof saved.payload['provider'] === 'string' ? saved.payload['provider'] : DEFAULT_PROVIDER
        const chatBase = providerId === WORKBUDDY_INTL.id ? WORKBUDDY_INTL.chatBase : resolveUpstream(env).chat
        const cred = await pollLogin({ chatBase, realm, state })
        // 还没完成授权：不是错误，继续轮询
        if (cred === undefined) return json({ done: false, message: '等待授权中…' })
        // 安全边界：uid 会被用作 storage key，必须校验
        if (!isValidUid(cred.uid)) {
          return json(
            { error: { message: '上游返回的 uid 含非法字符，已拒绝入库', type: 'invalid_uid' } },
            502,
          )
        }
        const credential = toProviderCredential(providerId, cred)
        const result = await persistProviderCredential(env, credential, now)
        // 只有**落盘成功**后才清会话：失败时保留，让用户能继续轮询重试
        const bound = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
        await bound.removeLoginSession(state)
        return json(result)
      }
      if (saved.payload['kind'] === 'qoder') {
        const { pollQoderLogin } = await import('./providers/qoder.js')
        const credential = await pollQoderLogin(saved.payload['session'] as never, AbortSignal.timeout(20_000))
        if (credential === undefined) return json({ done: false, message: '等待授权中…' })
        return json(await persistProviderCredential(env, credential, now))
      }
      if (saved.payload['kind'] === 'zcode') {
        const { pollZcodeLogin } = await import('./providers/zcode.js')
        const credential = await pollZcodeLogin(saved.payload['flow'] as never, AbortSignal.timeout(20_000))
        if (credential === undefined) return json({ done: false, message: '等待授权中…' })
        return json(await persistProviderCredential(env, credential, now))
      }
      // ── raccoon：微信扫码（二维码由本服务渲染，用户扫完即完成） ──
      if (saved.payload['kind'] === 'raccoon') {
        const { pollRaccoonQrLogin } = await import('./providers/raccoon.js')
        const qrCode = saved.payload['qrCode']
        if (typeof qrCode !== 'string' || qrCode === '') {
          return json({ done: false, status: 'failed', message: '登录会话缺少 qrcode_code，请重新发起' })
        }
        const polled = await pollRaccoonQrLogin(qrCode, AbortSignal.timeout(20_000))
        // `success` 才带凭据；其余状态如实回传，面板据此显示「等待扫码 / 已扫码待确认 / 已取消」
        if (polled.status === 'success' && polled.credential !== undefined) {
          return json(await persistProviderCredential(env, polled.credential, now))
        }
        if (polled.status === 'canceled') {
          return json({ done: false, status: 'canceled', message: '用户已取消授权，请重新发起' })
        }
        return json({ done: false, status: polled.status, message: '等待扫码…' })
      }
      // ── cline：WorkOS 设备码（单次轮询 + 会话内持久化节流） ──
      //
      // ⚠️ **必须无状态友好**：面板每 3 秒发一个**独立** HTTP 请求，Workers
      // 没有跨请求内存 —— 设备码的 `interval` / `slow_down` 退避状态只能存在
      // 会话载荷里（start 时写入，这里每轮更新）。放在模块变量里会在 isolate
      // 回收后丢失，退避**静默失效**。
      //
      // ⚠️ 三段状态机（判据逐条对齐 `src/cline-oauth.ts:266-291`）：
      // - `authorization_pending` → 继续等（**不是错误**）；
      // - `slow_down` → 间隔 **+1 秒累积**后继续；
      // - 终态错误 → `{done:false, status:'failed'}`，面板据此停止轮询。
      //
      // ⚠️ 未到下次轮询时刻时**直接返回 pending**，不打上游：
      // 面板 3 秒一次而设备码间隔可能已退避到 8 秒，不做节流会持续被限流。
      if (saved.payload['kind'] === 'cline') {
        const {
          pollClineDeviceTokenOnce,
          registerClineTokens,
          clineCredentialFromRegisterResponse,
        } = await import('./providers/cline.js')

        const deviceCode = sessionString(saved.payload, 'deviceCode')
        if (deviceCode === '') {
          return json({ done: false, status: 'failed', message: '登录会话缺少 device_code，请重新发起登录' })
        }
        const deadline = sessionNumber(saved.payload, 'deadline') ?? now
        if (now > deadline) {
          // 设备码本身已过期：再轮询只会得到 `expired_token`，如实收尾。
          // ⚠️ 这条分支**依赖发起时给会话多留了宽限**（CLINE_LOGIN_SESSION_GRACE_MS）
          // —— 会话 TTL 若恰好等于 deadline，`readLoginSession` 会先一步删掉会话，
          // 我们只能回一条**没有 `status`** 的「会话不存在」，面板会当成继续等。
          await saved.pool.removeLoginSession(state)
          return json({ done: false, status: 'failed', message: '设备码已过期，请重新发起登录' })
        }

        const intervalMs = sessionNumber(saved.payload, 'intervalMs') ?? CLINE_DEVICE_MIN_INTERVAL_MS
        const nextPollAt = sessionNumber(saved.payload, 'nextPollAt') ?? now
        if (now < nextPollAt) {
          // 还没到下一次轮询时刻（面板的 3 秒节奏快于设备码要求）
          return json({ done: false, status: 'authorization_pending', message: '等待授权中…' })
        }

        const outcome = await pollClineDeviceTokenOnce(
          { deviceCode, intervalMs },
          { signal: AbortSignal.timeout(20_000) },
        )

        if (outcome.kind === 'pending') {
          // ⚠️ 每轮都把新间隔写回会话：`slow_down` 的累积退避必须跨请求保留。
          // ⚠️ TTL 也必须带上同一个宽限值（见 CLINE_LOGIN_SESSION_GRACE_MS）——
          // 用 `deadline` 当 TTL 会把宽限窗口在第一轮就抹掉。
          await saved.pool.saveLoginSession(
            state,
            {
              ...saved.payload,
              intervalMs: outcome.intervalMs,
              nextPollAt: Date.now() + outcome.intervalMs,
              lastStatus: outcome.status,
            },
            deadline + CLINE_LOGIN_SESSION_GRACE_MS,
          )
          return json({
            done: false,
            // ⚠️ 原样回传上游状态（`authorization_pending` / `slow_down`），
            // 不糊成一句「等待中」—— 面板与排查都需要看到真实原因
            status: outcome.status,
            message: outcome.status === 'slow_down' ? '服务端要求降速，继续等待授权…' : '等待授权中…',
          })
        }

        if (outcome.kind === 'failed') {
          await saved.pool.removeLoginSession(state)
          return json({ done: false, status: 'failed', message: outcome.message })
        }

        // 第二步成功 → 第三步：注册成 Cline 自己的 token
        try {
          const registered = await registerClineTokens(outcome, { signal: AbortSignal.timeout(30_000) })
          const credential = clineCredentialFromRegisterResponse(registered, saved.realm)
          const result = await persistProviderCredential(env, credential, now)
          // ⚠️ 只有**落盘成功**后才清会话（与 buddy 分支同口径）：
          // 失败时保留，让用户能继续轮询重试。
          await saved.pool.removeLoginSession(state)
          return json(result)
        } catch (error) {
          await saved.pool.removeLoginSession(state)
          return json({
            done: false,
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }

      // ── minimax：设备码 + PKCE 轮询（与 cline 同型，判据不同） ──
      if (saved.payload['kind'] === 'minimax') {
        const { pollMinimaxLoginOnce } = await import('./providers/minimax.js')

        const deviceCode = sessionString(saved.payload, 'deviceCode')
        const codeVerifier = sessionString(saved.payload, 'codeVerifier')
        if (deviceCode === '' || codeVerifier === '') {
          // ⚠️ `codeVerifier` 也要查：丢了它轮询**必然换不到 token**
          //（服务端拿它的 S256 与申请时的 challenge 比对），
          // 而错误会显示成「授权失败」，完全看不出是会话缺字段。
          return json({ done: false, status: 'failed', message: '登录会话缺少设备码或 PKCE verifier，请重新发起登录' })
        }
        const deadline = sessionNumber(saved.payload, 'deadline') ?? now
        if (now > deadline) {
          await saved.pool.removeLoginSession(state)
          return json({ done: false, status: 'failed', message: '设备码已过期，请重新发起登录' })
        }

        // ⚠️ 面板 3 秒一轮，而上游要求 5 秒起（`slow_down` 后更长）。
        // 未到点就**直接回 pending，不打上游** —— 省配额也避免被限流。
        const intervalSec = sessionNumber(saved.payload, 'intervalSec') ?? 5
        const nextPollAt = sessionNumber(saved.payload, 'nextPollAt') ?? now
        if (now < nextPollAt) {
          return json({
            done: false,
            status: sessionString(saved.payload, 'lastStatus') || 'pending',
            message: `等待授权中…（${Math.ceil((nextPollAt - now) / 1000)} 秒后重试）`,
          })
        }

        const auth = {
          deviceCode,
          codeVerifier,
          userCode: sessionString(saved.payload, 'userCode'),
          verificationUri: sessionString(saved.payload, 'verificationUri'),
          verificationUriComplete: sessionString(saved.payload, 'verificationUriComplete'),
          expiresInSec: Math.max(1, Math.round((deadline - now) / 1000)),
          intervalSec,
        }
        const outcome = await pollMinimaxLoginOnce(auth, AbortSignal.timeout(20_000))

        if (outcome.kind === 'pending') {
          // ⚠️ 每轮都把新间隔写回会话：`slow_down` 的 **+5 秒累积退避**
          // 必须跨请求保留（Workers 无跨请求内存，放模块变量会静默失效）。
          // ⚠️ TTL 也要带同一个宽限值 —— 用 `deadline` 当 TTL 会把宽限在第一轮抹掉。
          await saved.pool.saveLoginSession(
            state,
            { ...saved.payload, intervalSec: outcome.intervalSec, nextPollAt: Date.now() + outcome.intervalSec * 1000, lastStatus: outcome.kind },
            deadline + CLINE_LOGIN_SESSION_GRACE_MS,
          )
          return json({ done: false, status: 'pending', message: '等待授权中…' })
        }
        if (outcome.kind === 'failed') {
          await saved.pool.removeLoginSession(state)
          return json({ done: false, status: 'failed', message: outcome.message })
        }
        return json(await persistProviderCredential(env, outcome.credential, now))
      }
      // ── codearts：浏览器回跳 + ticket 换取凭据 ──
      // `{done:false, status}` 是**约定形状**：面板据此区分「等浏览器」
      //（awaiting_browser）/「已收到回调正在换」（pending）/「终态失败」（failed），
      // 而不是把三种状态都糊成一句「等待中」。
      if (saved.payload['kind'] === 'codearts') {
        return await pollCodeArtsLogin(env, saved, state, now)
      }
      // ── trae：浏览器回跳 + ExchangeToken（**只有这里调交换**） ──
      // 状态形状与 codearts 一致（awaiting_browser / pending / failed / done）。
      if (saved.payload['kind'] === 'trae') {
        return await pollTraeLogin(env, saved, state, now)
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
        // ⚠️ 记录**签到日**（面板「签到 YYYY-MM-DD」标签的数据源）。
        //
        // 原实现只调 `noteSuccess`，而它**不写** `lastCheckinDay` —— 于是那句
        // 「记录签到日」的注释从来没有兑现，面板标签永远为空（实测
        // `/admin/accounts` 上两个 buddy 账号的 `lastCheckinDay` 都是 `""`）。
        // Go 侧对应的 `Pool.NoteCheckinDone`（`internal/panel/panel.go:494,499`）
        // 与清熔断是两个独立动作，故这里也分两次调用。
        if (r.alreadyDone || r.gained >= 0) {
          const at = Date.now()
          await pool.noteCheckinDone(account.uid, at).catch(() => {})
          await pool.noteSuccess(account.uid, at).catch(() => {})
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
    const providerId = body.provider ?? ''
    const model = body.model ?? ''
    // ⚠️ 用「该供应商账号实际所在的分片」，否则国际版的开关会写错分片
    const realm = await realmForProvider(env, providerId, body.realm)
    if (providerId === '' || model === '') {
      return jsonError(400, 'provider 与 model 必填', 'invalid_request')
    }
    await writeDisabledModels(env, providerId, realm, (current) => {
      if (body.enabled === false) current.add(model)
      else current.delete(model)
    })
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
    const providerId = body.provider ?? ''
    if (providerId === '') return jsonError(400, 'provider 必填', 'invalid_request')
    // ⚠️ 同上：国际版在 global 分片
    const realm = await realmForProvider(env, providerId, body.realm)
    if (!Array.isArray(body.models)) return jsonError(400, 'models 必须是数组', 'invalid_request')

    const ids = body.models.filter((m): m is string => typeof m === 'string' && m !== '')
    const size = await writeDisabledModels(env, providerId, realm, (current) => {
      if (body.enabled === false) for (const id of ids) current.add(id)
      else for (const id of ids) current.delete(id)
    })
    return json({ ok: true, provider: providerId, changed: ids.length, disabledCount: size })
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
    // ⚠️ 带上**面板设置**（顺序 + 已关闭的家）—— 面板据此渲染
    //   「供应商」卡片与排序。「关闭」是**服务端**状态（会真的影响
    //   `/v1/models` 与路由），不是浏览器 localStorage。
    //
    // ⚠️ 设置存在 `cn` 分片的 DO 里当全局值用（见 `getProviderSettings` 的说明）。
    // 读失败**不能让整个端点失败** —— 设置只是展示偏好，缺了就用默认顺序。
    let settings: { order: string[]; disabled: string[] } = { order: [], disabled: [] }
    try {
      const cnPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
      settings = await cnPool.getProviderSettings()
    } catch {
      // 用默认值（空顺序 = 注册表原顺序；无关闭）
    }
    return json({
      default: DEFAULT_PROVIDER,
      providers: providerCatalog(),
      order: settings.order,
      disabled: settings.disabled,
    })
  }

  // ── 改供应商面板设置（顺序 / 启用开关） ──
  //
  // ⚠️ 语义（用户明确）：
  // · **关闭 = 彻底关掉** ⇒ 该家的模型从 `/v1/models` 消失、也拒绝路由到它；
  // · **排序只影响面板展示**，**不**改默认供应商
  //  （裸模型名仍回落到 `DEFAULT_PROVIDER` —— 悄悄改掉既有请求的路由不可接受）。
  if (path === '/admin/providers/settings' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { order?: unknown; disabled?: unknown }
    const known = new Set(providerIds())
    const toIds = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && known.has(x)) : []
    // ⚠️ 未知 id 一律丢弃：否则一个笔误就会在存储里留下永远匹配不上的条目。
    const order = toIds(body.order)
    const disabled = toIds(body.disabled)
    const cnPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    await cnPool.setProviderSettings({ order, disabled })
    return json({ ok: true, order, disabled })
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
    let pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    // ⚠️ **逐个账号尝试，而不是取第一个**（实测缺陷，用户报「商汤账号又不行了」）。
    //
    // 原实现是 `accounts.find(...)` —— 拿**第一个**该供应商的账号就去拉目录。
    // 但池里可能有多个账号（实测商汤有 2 个），**第一个恰好是坏号**
    //（refresh_token 已失效）时，整个目录请求就失败了 —— 而另一个好号
    // 明明能正常拉取、也正是 `chat`（走 `pick()`，会自动跳过坏号）在用的那个。
    //
    // 表现极具误导性：**同一个账号 chat 完全正常，模型列表却报
    // 「登录态已过期」** —— 用户会以为整个账号废了，实际只是选号策略不一致。
    //
    // ⇒ 与 chat 对齐：**健康的账号优先，坏的跳过**。
    // 只有全部账号都失败时，才回报（并带上最后一个错误供排查）。
    const candidates: Array<{ pool: DurableObjectStub<AccountPoolDO>; uid: string }> = []
    for (const realm of ['cn', 'global']) {
      const candidatePool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
      const accounts = await candidatePool.listAccounts(realm, Date.now())
      for (const a of accounts) {
        if ((a.provider ?? DEFAULT_PROVIDER) !== providerId) continue
        // ⚠️ 跳过明确不可用的账号：它们大概率还是失败，白打上游一次
        //（也避免在 refresh_token 已失效时反复尝试续期 —— 那是**终态**，
        // 重试只会浪费一次请求）。判据与 `pick()` 的健康检查保持一致。
        if (a.disabled === true) continue
        if (a.until > Date.now() || a.breakerUntil > Date.now()) continue
        candidates.push({ pool: candidatePool, uid: a.uid })
      }
    }
    if (candidates.length === 0) {
      return json({ provider: providerId, models: [], note: '没有该供应商的可用账号，无法拉取模型目录' })
    }
    // ⚠️ 只有国内版（buddy）需要绑定 env —— 它允许用 env 覆盖域名便于调试；
    // 国际版恒用官方域名。
    const bound = providerId === DEFAULT_PROVIDER ? bindBuddy(env) : provider
    let models: ProviderModel[] | undefined
    let lastError: unknown
    for (const cand of candidates) {
      const credential = (await cand.pool.getCredential(cand.uid)) as ProviderCredential | undefined
      if (credential === undefined) continue
      try {
        // ⚠️ 走续期重试：过期令牌不该让用户看到「凭据坏了」
        const got = await withRefreshRetry(env, cand.pool, providerId, credential, (c) =>
          bound.listModels(c, AbortSignal.timeout(20_000)),
        )
        models = got.value
        pool = cand.pool
        break
      } catch (error) {
        // ⚠️ **单个账号失败不终止**：换下一个继续试。
        // 全部失败时把**最后一个**错误如实回报（不静默、不编造）。
        lastError = error
      }
    }
    if (models === undefined) {
      return jsonError(
        502,
        lastError instanceof Error ? lastError.message : String(lastError ?? '模型目录拉取失败'),
        'list_models_failed',
      )
    }
    {
      // 带上「是否被用户停用」标记，供面板渲染开关
      // ⚠️ 合并**两个分片**的停用列表：停用记录是按供应商存在各自分片里的，
      // 只看当前分片会让「在另一个分片关掉的模型」重新显示为启用。
      const set = new Set<string>()
      for (const p of ['cn', 'global']) {
        const other = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(p))
        for (const id of await other.getDisabledModels(providerId)) set.add(id)
      }
      return json({
        provider: providerId,
        models: models.map((m) => ({ ...m, disabled: set.has(m.id) })),
        disabledCount: set.size,
      })
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
        // ⚠️ 不只给模型名，还要给**到期时间与原因** ——
        // 面板的「模型限流」弹窗要显示「还剩多久 / 为什么被限」，
        // 只给名字无法回答用户最关心的那两个问题。
        modelCooldowns: Object.entries(a.modelCooldowns).map(([model, info]) => ({
          model,
          until: info?.until ?? 0,
          reason: info?.reason ?? '',
          hits: info?.hits ?? 0,
        })),
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
    // ⚠️ **必须遍历两个 realm**（实测踩到：WorkBuddy 国际版在目录里完全消失）。
    //
    // 账号按凭据的 `extras.realm` 分片存放（国际版在 `global`），
    // 而这里原先只看 `?realm=`（缺省 `cn`）—— 于是国际版**永远不会出现**，
    // 表现为「账号登录好了、别处也能用，但 /v1/models 里没有它」，
    // 客户端根本选不到。
    //
    // ⚠️ 每个账号要**连它的 realm 一起记**：取凭据必须回到**同一个分片**的
    // DO stub（跨分片拿不到）。丢掉 realm 会让国际版账号在取凭据时丢失，
    // 或者更糟 —— 拿 cn 分片的同名 uid 去取到别人的凭据。
    //
    // 客户端仍可用 `?realm=` 限定只看某一个分片（保留原有语义）。
    const requestedRealm = url.searchParams.get('realm')
    const realms = requestedRealm === null || requestedRealm === '' ? ['cn', 'global'] : [requestedRealm]

    const pools = new Map<string, ReturnType<typeof env.ACCOUNT_POOL.get>>()
    for (const r of realms) pools.set(r, env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(r)))

    // ⚠️ **只列「有账号」的供应商的模型**（用户要求）。
    //
    // 没有账号的供应商，其模型选了也只会报「没有可用账号」——
    // 列出来只会让客户端挑到一个必然失败的模型。
    // 这也让「登录后再显示」自然成立：登录后账号数变化，模型即出现。
    //
    // 只对声明 `listModels` 的家拉目录；逐家**串行**（同时出站连接上限 6，
    // 且并行打上游更容易触发风控）。
    // 账号 + 它所在的分片（取凭据/停用列表都要回到同一分片）
    type Sourced = { account: AccountState; realm: string }
    const byProvider = new Map<string, Sourced[]>()
    for (const r of realms) {
      const pool = pools.get(r)
      if (pool === undefined) continue
      for (const a of await pool.listAccounts(r, Date.now())) {
        const pid = a.provider ?? DEFAULT_PROVIDER
        const list = byProvider.get(pid) ?? []
        list.push({ account: a, realm: r })
        byProvider.set(pid, list)
      }
    }

    const data: Array<Record<string, unknown>> = []
    const errors: Array<{ provider: string; error: string }> = []
    let disabledTotal = 0

    // ⚠️ 读一次「已被用户关闭的供应商」——关闭 = **彻底关掉**：
    // 它们的模型**不出现在目录里**（也不允许路由到，见 handleChatCompletions
    // 的同类判据）。设置是全局的，故只需读 cn 分片一次。
    const userDisabledProviders = new Set<string>()
    try {
      const cnPool = pools.get('cn') ?? env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
      for (const id of (await cnPool.getProviderSettings()).disabled) userDisabledProviders.add(id)
    } catch {
      // 读不到设置就按「都没关」处理 —— 目录功能不该因为偏好读取失败而整体失败
    }

    for (const [providerId, list] of byProvider) {
      // ⚠️ 用户关闭的家直接跳过（不入 errors：那不是**故障**，是用户的**选择**）
      if (userDisabledProviders.has(providerId)) continue
      const provider = findProvider(providerId)
      if (provider === undefined || !provider.capabilities.listModels) continue
      const picked = list.find((x) => !x.account.disabled)
      if (picked === undefined) continue
      // ⚠️ 用**该账号自己分片**的 stub 取凭据与停用列表
      const pool = pools.get(picked.realm)
      if (pool === undefined) continue
      const credential = (await pool.getCredential(picked.account.uid)) as ProviderCredential | undefined
      if (credential === undefined) continue

      // ⚠️ 停用列表是**按供应商**存的，但存在各自 realm 的分片里。
      // 合并两边，否则「国际版关掉的模型」在国内分片里查不到、会重新冒出来。
      const disabled = new Set<string>()
      for (const p of pools.values()) {
        for (const id of await p.getDisabledModels(providerId)) disabled.add(id)
      }
      disabledTotal += disabled.size

      try {
        const bound = providerId === DEFAULT_PROVIDER ? bindBuddy(env) : provider
        // ⚠️ 走**续期重试**：过期的令牌不该让整家从目录里消失。
        // 实测踩到：raccoon 的 access token 过期后，/v1/models 直接把它
        // 归到 errors 里，客户端看到的是「这家没有模型」——
        // 而它其实只需要续期一次就恢复。
        const { value: models } = await withRefreshRetry(env, pool, providerId, credential, (c) =>
          bound.listModels(c, AbortSignal.timeout(20_000)),
        )
        for (const m of models) {
          if (disabled.has(m.id)) continue
          const base = m as unknown as Record<string, unknown>
          // ⚠️ **目录里一律带 `provider/` 前缀**（用户要求「加上前缀，方便区分」）。
          //
          // 早先还给默认供应商额外暴露一份**裸名**，结果是同一个模型在目录里
          // 出现两次（`buddy/glm-5.3-flash` 与 `glm-5.3-flash`），
          // 而多家又有同名模型（`buddy/`、`codearts/`、`trae/` 都有
          // `deepseek-v4.1-flash`）—— 用户看到裸名根本分不清是哪一家。
          //
          // ⚠️ **请求侧仍然接受裸名**（回退到默认供应商，见 `splitModelName`）：
          // 已有的客户端配置不会因为这个改动而失效，只是目录里不再列它。
          // 兼容与无歧义两件事分开处理 —— 目录负责「说清楚」，路由负责「不breaking」。
          data.push({ ...base, id: `${providerId}/${m.id}` })
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

  // ── OpenAI **Responses API**（新一代客户端：Codex CLI 等） ──
  //
  // ⚠️ **与 `/v1/chat/completions` 并存**，不做「格式开关」：
  // 客户端用哪套协议由它自己请求的 URL 决定。做成互斥开关只会让
  // 「另一个协议的客户端在切换后突然失效」，而网关这边没有任何互斥的理由 ——
  // 两者共用同一份 provider 路由、账号池与图片入站。
  // 依据：参考实现 `openai-gateway/responses.ts:12-16`。
  if (path === '/v1/responses' && request.method === 'POST') {
    const realm = url.searchParams.get('realm') ?? 'cn'
    const result = await handleResponses(request, env, realm, ctx)
    // 同 Chat 路径：流式响应**原样返回**，不在这里包装或缓冲。
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
