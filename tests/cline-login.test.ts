/**
 * Cline 设备码登录（WorkOS 三步）的单测 —— **全部走 mock fetch，零真实请求**。
 *
 * ## ⚠️ 本文件绝不能打真实端点（读之前先看这条）
 *
 * Cline 的 `refreshToken` 是**一次性轮换**的：对真实凭据发一次续期请求就会把
 * 用户本机那份凭据作废（`src/providers/types.ts` 的「轮换型 refresh token 的
 * 操作纪律」；本项目已因此丢过两次账号）。故这里的三个流程函数**一律注入
 * `fetcher`**，**没有一处**使用全局 `fetch`，也没有任何真实凭据。
 *
 * ## 这些断言锁的是什么
 *
 * 1. **三步协议逐字对齐**（URL / 方法 / Content-Type / body 字段名）：
 *    字段名写错时服务端**不会**报「缺字段」，而是回一个泛化的认证失败，
 *    现象是「点了没反应」，极难归因（`src/cline-oauth.ts:18-38`）；
 * 2. **状态机判据**：`authorization_pending` 是**响应体的 `error` 字段**而非
 *    HTTP 状态码 —— 按状态码判失败会把「用户还没点授权」误报成登录失败；
 * 3. **`slow_down` 必须累积退避**（源码 `intervalSeconds += 1`），
 *    且间隔**下限 1 秒**（服务端可能下发 0 或负数）；
 * 4. **注册响应回灌 `parseCredential`**：登录拿到的凭据必须与「粘贴导入」
 *    **同形**（否则同一账号会变成两条记录），且 `accountId` / `realm` 不能丢；
 * 5. **无状态友好的持久化**：`intervalMs` / `nextPollAt` / `deadline` 必须写进
 *    会话载荷（面板每 3 秒发独立请求，Workers 无跨请求内存）。
 *
 * 运行：`npm test`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  clineCredentialFromRegisterResponse,
  CLINE_DEVICE_AUTH_EXPIRES_MS,
  CLINE_DEVICE_AUTH_INTERVAL_MS,
  CLINE_DEVICE_MIN_INTERVAL_MS,
  CLINE_DEVICE_SLOW_DOWN_STEP_MS,
  pollClineDeviceTokenOnce,
  registerClineTokens,
  requestClineDeviceAuthorization,
} from '../src/providers/cline.ts'
import { findProvider } from '../src/providers/index.ts'
import { ProviderError } from '../src/providers/types.ts'

/** 造一个只回固定响应的 mock fetch，并记录收到的调用。 */
function mockFetcher(responses: Array<() => Response | Promise<Response>>): {
  fetcher: typeof fetch
  calls: Array<{ url: string; method: string; contentType: string; body: string }>
  count: () => number
} {
  const calls: Array<{ url: string; method: string; contentType: string; body: string }> = []
  let index = 0
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers = new Headers(init?.headers)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      contentType: headers.get('content-type') ?? '',
      body: typeof init?.body === 'string' ? init.body : '',
    })
    const factory = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (factory === undefined) throw new Error('mock 没有更多响应')
    return await factory()
  }) as unknown as typeof fetch
  return { fetcher, calls, count: () => index }
}

/** JSON 响应。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 一次合法的设备码授权响应（字段名逐字来自 `src/cline-oauth.ts:194-203`）。 */
const DEVICE_OK = {
  device_code: 'device-abc123',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://api.workos.com/device',
  verification_uri_complete: 'https://api.workos.com/device?user_code=WDJB-MJHT',
  expires_in: 300,
  interval: 5,
}

/** 一个形状合法的访问令牌（`looksLikeClineToken` 要求 `workos:` 后 > 20 字符）。 */
const ACCESS_TOKEN =
  'workos:eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzAxTTNCQ1Y0In0.c2lnbmF0dXJl'
/** 一个形状合法的 refresh token。 */
const REFRESH_TOKEN = 'tmgEeMfakeRefreshToken0123456789'

// ─────────────────── ① 第一步：设备码授权 ───────────────────

test('设备码授权：URL / 方法 / Content-Type / body 逐字对齐协议', async () => {
  const mock = mockFetcher([() => jsonResponse(DEVICE_OK)])
  await requestClineDeviceAuthorization({ fetcher: mock.fetcher })

  assert.equal(mock.calls.length, 1)
  const call = mock.calls[0]
  assert.equal(call?.url, 'https://api.workos.com/user_management/authorize/device',
    '设备码授权必须挂 api.workos.com（不是 api.cline.bot）')
  assert.equal(call?.method, 'POST')
  // ⚠️ 表单编码，不是 JSON：写成 application/json 服务端不认
  assert.match(call?.contentType ?? '', /application\/x-www-form-urlencoded/)
  assert.equal(call?.body, 'client_id=client_01K3A541FN8TA3EPPHTD2325AR')
})

test('设备码授权：响应归一化为毫秒，且 `verification_uri_complete` 可选', async () => {
  const mock = mockFetcher([() => jsonResponse(DEVICE_OK)])
  const auth = await requestClineDeviceAuthorization({ fetcher: mock.fetcher })

  assert.equal(auth.deviceCode, 'device-abc123')
  assert.equal(auth.userCode, 'WDJB-MJHT')
  assert.equal(auth.verificationUri, 'https://api.workos.com/device')
  assert.equal(auth.verificationUriComplete, 'https://api.workos.com/device?user_code=WDJB-MJHT')
  // 上游下发的是**秒**，内部一律用毫秒
  assert.equal(auth.expiresInMs, 300_000)
  assert.equal(auth.intervalMs, 5_000)
})

test('⚠️ 缺少 device_code / user_code / verification_uri 任一即失败（不产出坏会话）', async () => {
  // 三字段缺一都是**必然失败**的会话：缺 user_code 用户无从输入，
  // 缺 device_code 轮询无从发起。宁可在这里如实报错，也不要让用户
  // 拿着一个必然失败的会话等 5 分钟超时（参考实现同判据，`cline-oauth.ts:197-199`）。
  for (const missing of ['device_code', 'user_code', 'verification_uri']) {
    const payload: Record<string, unknown> = { ...DEVICE_OK }
    delete payload[missing]
    const mock = mockFetcher([() => jsonResponse(payload)])
    await assert.rejects(
      () => requestClineDeviceAuthorization({ fetcher: mock.fetcher }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError, `应抛 ProviderError，实际 ${String(error)}`)
        assert.match(error.message, /缺少必要字段/)
        return true
      },
      `缺 ${missing} 时必须失败`,
    )
  }
})

test('设备码授权非 2xx：抛错并带上服务端文案', async () => {
  const mock = mockFetcher([() => jsonResponse({ error: 'invalid_client', error_description: '客户端无效' }, 400)])
  await assert.rejects(
    () => requestClineDeviceAuthorization({ fetcher: mock.fetcher }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.match(error.message, /400/)
      assert.match(error.message, /客户端无效/, '服务端文案必须带上（否则无从排查）')
      return true
    },
  )
})

test('⚠️ 间隔下限 1 秒：服务端下发 0 / 负数 / 缺失时都必须兜底', async () => {
  // 实测服务端可能下发 0 或负数（`src/cline-oauth.ts:236-237`）。
  // 不兜底会变成「无间隔轮询」→ 被 WorkOS 持续限流。
  const cases: Array<[unknown, number]> = [
    [0, CLINE_DEVICE_AUTH_INTERVAL_MS],
    [-5, CLINE_DEVICE_AUTH_INTERVAL_MS],
    [undefined, CLINE_DEVICE_AUTH_INTERVAL_MS],
    ['abc', CLINE_DEVICE_AUTH_INTERVAL_MS],
    // 小数秒（0.4s）合法但取整后为 0 —— 必须被**下限**（不是默认值）拦住
    [0.4, CLINE_DEVICE_MIN_INTERVAL_MS],
  ]
  for (const [interval, expected] of cases) {
    const mock = mockFetcher([() => jsonResponse({ ...DEVICE_OK, interval })])
    const auth = await requestClineDeviceAuthorization({ fetcher: mock.fetcher })
    assert.equal(auth.intervalMs, expected, `interval=${String(interval)} 的兜底值不对`)
    assert.ok(auth.intervalMs >= CLINE_DEVICE_MIN_INTERVAL_MS, '任何情况下都不得低于 1 秒下限')
  }
  // 合法的 1 秒（低于默认 5 秒但高于下限）必须**原样保留**，不能被默认值吃掉
  const mock = mockFetcher([() => jsonResponse({ ...DEVICE_OK, interval: 1 })])
  const auth = await requestClineDeviceAuthorization({ fetcher: mock.fetcher })
  assert.equal(auth.intervalMs, 1_000)
})

// ─────────────────── ② 第二步：轮询 ───────────────────

test('轮询：body 必须带 grant_type / device_code / client_id（grant_type 逐字）', async () => {
  const mock = mockFetcher([() => jsonResponse({ error: 'authorization_pending' }, 400)])
  await pollClineDeviceTokenOnce({ deviceCode: 'device-abc123', intervalMs: 5_000 }, { fetcher: mock.fetcher })

  const call = mock.calls[0]
  assert.equal(call?.url, 'https://api.workos.com/user_management/authenticate')
  assert.equal(call?.method, 'POST')
  assert.match(call?.contentType ?? '', /application\/x-www-form-urlencoded/)
  const params = new URLSearchParams(call?.body ?? '')
  assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code',
    'grant_type 写错会得到泛化的认证失败，极难定位')
  assert.equal(params.get('device_code'), 'device-abc123')
  assert.equal(params.get('client_id'), 'client_01K3A541FN8TA3EPPHTD2325AR')
})

test('⚠️ `authorization_pending` 必须判为**继续等待**，不是失败', async () => {
  // 这是本流程最容易写错、也最难归因的一条：pending 的判据是响应体的 `error`
  // 字段（`src/cline-oauth.ts:40-44`），而服务端**可能同时返回非 2xx**。
  // 按状态码判失败 = 用户还没点授权就报「登录失败」。
  const mock = mockFetcher([() => jsonResponse({ error: 'authorization_pending' }, 400)])
  const outcome = await pollClineDeviceTokenOnce(
    { deviceCode: 'd', intervalMs: 5_000 },
    { fetcher: mock.fetcher },
  )
  assert.equal(outcome.kind, 'pending')
  assert.equal(outcome.kind === 'pending' ? outcome.status : '', 'authorization_pending')
  // 间隔原样保留（pending 不改变节奏）
  assert.equal(outcome.kind === 'pending' ? outcome.intervalMs : 0, 5_000)
})

test('⚠️ `slow_down` 必须**累积**退避 1 秒（不是重置回原间隔）', async () => {
  // 源码是 `intervalSeconds += 1`（`src/cline-oauth.ts:273-277`）。
  // 用固定间隔会在服务端要求降速后持续被限流。
  const first = await pollClineDeviceTokenOnce(
    { deviceCode: 'd', intervalMs: 5_000 },
    { fetcher: mockFetcher([() => jsonResponse({ error: 'slow_down' }, 400)]).fetcher },
  )
  assert.equal(first.kind, 'pending')
  assert.equal(first.kind === 'pending' ? first.status : '', 'slow_down')
  assert.equal(first.kind === 'pending' ? first.intervalMs : 0, 5_000 + CLINE_DEVICE_SLOW_DOWN_STEP_MS)

  // 第二次 slow_down 必须在上一次的基础上**再加** 1 秒（累积），而不是回到 6 秒
  const second = await pollClineDeviceTokenOnce(
    { deviceCode: 'd', intervalMs: 6_000 },
    { fetcher: mockFetcher([() => jsonResponse({ error: 'slow_down' }, 400)]).fetcher },
  )
  assert.equal(second.kind === 'pending' ? second.intervalMs : 0, 7_000, '退避必须累积')

  // 极端情形：间隔被压到 0 时 slow_down 也必须回到下限之上
  const third = await pollClineDeviceTokenOnce(
    { deviceCode: 'd', intervalMs: 0 },
    { fetcher: mockFetcher([() => jsonResponse({ error: 'slow_down' }, 400)]).fetcher },
  )
  assert.ok((third.kind === 'pending' ? third.intervalMs : 0) >= CLINE_DEVICE_MIN_INTERVAL_MS)
})

test('终态错误（access_denied / expired_token / invalid_grant）必须停轮询', async () => {
  for (const code of ['access_denied', 'expired_token', 'invalid_grant']) {
    const outcome = await pollClineDeviceTokenOnce(
      { deviceCode: 'd', intervalMs: 5_000 },
      { fetcher: mockFetcher([() => jsonResponse({ error: code }, 400)]).fetcher },
    )
    assert.equal(outcome.kind, 'failed', `${code} 必须是终态`)
    assert.equal(outcome.kind === 'failed' ? outcome.status : '', code)
    assert.ok((outcome.kind === 'failed' ? outcome.message : '').length > 5, '终态必须带可读文案')
  }
})

test('其它非 2xx（含未知 error 码）一律终态失败', async () => {
  const outcome = await pollClineDeviceTokenOnce(
    { deviceCode: 'd', intervalMs: 5_000 },
    { fetcher: mockFetcher([() => jsonResponse({ error: 'server_error' }, 500)]).fetcher },
  )
  assert.equal(outcome.kind, 'failed')
  assert.match(outcome.kind === 'failed' ? outcome.message : '', /500/)
})

test('⚠️ 2xx 但缺 token 必须判**终态失败**（不是 pending）', async () => {
  // 判成 pending 会让用户永远挂在「等待授权中」，而重试一万次也不会有 token。
  for (const payload of [{ access_token: ACCESS_TOKEN }, { refresh_token: REFRESH_TOKEN }, {}]) {
    const outcome = await pollClineDeviceTokenOnce(
      { deviceCode: 'd', intervalMs: 5_000 },
      { fetcher: mockFetcher([() => jsonResponse(payload)]).fetcher },
    )
    assert.equal(outcome.kind, 'failed', `${JSON.stringify(payload)} 应判失败`)
  }
})

test('轮询成功：取出 WorkOS 的 access_token / refresh_token', async () => {
  const outcome = await pollClineDeviceTokenOnce(
    { deviceCode: 'd', intervalMs: 5_000 },
    { fetcher: mockFetcher([() => jsonResponse({ access_token: 'at', refresh_token: 'rt', token_type: 'Bearer' })]).fetcher },
  )
  assert.equal(outcome.kind, 'success')
  assert.equal(outcome.kind === 'success' ? outcome.accessToken : '', 'at')
  assert.equal(outcome.kind === 'success' ? outcome.refreshToken : '', 'rt')
})

// ─────────────────── ③ 第三步：注册 ───────────────────

test('注册：URL 挂 apiBase（不是 workos），body 是**驼峰**', async () => {
  const mock = mockFetcher([() => jsonResponse({ success: true, data: {} })])
  await registerClineTokens({ accessToken: 'at', refreshToken: 'rt' }, { fetcher: mock.fetcher })

  const call = mock.calls[0]
  assert.equal(call?.url, 'https://api.cline.bot/api/v1/auth/register',
    '注册挂 api.cline.bot —— 与 WorkOS 那两个端点不是同一个域')
  assert.equal(call?.method, 'POST')
  assert.match(call?.contentType ?? '', /application\/json/)
  // ⚠️ 字段名是驼峰（`src/cline-oauth.ts:312`）：写成 OAuth 标准的
  // `access_token` / `refresh_token` 服务端不认，且不会报「缺字段」。
  assert.deepEqual(JSON.parse(call?.body ?? '{}'), { accessToken: 'at', refreshToken: 'rt' })
})

test('注册非 2xx：抛错并带上服务端文案', async () => {
  const mock = mockFetcher([() => jsonResponse({ error: 'token 已被使用' }, 401)])
  await assert.rejects(
    () => registerClineTokens({ accessToken: 'at', refreshToken: 'rt' }, { fetcher: mock.fetcher }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.match(error.message, /注册失败/)
      assert.match(error.message, /401/)
      assert.match(error.message, /已被使用/)
      return true
    },
  )
})

// ─────────────────── ④ 注册响应 → 凭据（必须与导入同形） ───────────────────

/** 一份完整的注册响应（形状来自 `src/cline.ts:121-160`）。 */
const REGISTER_OK = {
  success: true,
  data: {
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    expiresAt: '2030-09-25T05:23:47.000Z',
    tokenType: 'Bearer',
    userInfo: { clineUserId: 'usr-01M3BCV4FYCGJKAWD3MJG3DBQM', email: 'someone@example.com', firstName: '', lastName: '' },
  },
}

test('注册响应 → 凭据：uid / accountId / 过期时间 / 令牌前缀都正确', () => {
  const credential = clineCredentialFromRegisterResponse(REGISTER_OK, 'cn')

  assert.equal(credential.provider, 'cline')
  // ⚠️ uid 必须是 `usr-…`（不是 JWT 的 sub）：它同时是存储主键与余额端点的入参
  assert.equal(credential.uid, 'usr-01M3BCV4FYCGJKAWD3MJG3DBQM')
  assert.equal(credential.extras['accountId'], 'usr-01M3BCV4FYCGJKAWD3MJG3DBQM',
    'accountId 丢了余额端点会直接 400')
  assert.equal(credential.extras['email'], 'someone@example.com')
  assert.equal(credential.extras['realm'], 'cn', 'realm 决定账号落哪个分片，必须写入')
  assert.equal(credential.refreshToken, REFRESH_TOKEN)
  assert.equal(credential.expiresAt, Date.parse('2030-09-25T05:23:47.000Z'))
  // 服务端下发的令牌自带 workos: 前缀 —— 幂等补齐不得重复加
  assert.equal(credential.accessToken, ACCESS_TOKEN)
  assert.ok(!credential.accessToken.startsWith('workos:workos:'), '前缀不得重复叠加')
})

test('⚠️ 注册响应的 accessToken **不带**前缀时也要补上（对上游变更鲁棒）', () => {
  // 实测续期响应返回的就是裸 JWT（`AGENTS.md` 的坑 1）；注册若哪天也改回不带
  // 前缀，少了 `workos:` 的请求头就是 401，而文案会误导成「客户端版本过旧」。
  const bare = ACCESS_TOKEN.replace(/^workos:/, '')
  const credential = clineCredentialFromRegisterResponse(
    { success: true, data: { ...REGISTER_OK.data, accessToken: bare } },
    'cn',
  )
  assert.equal(credential.accessToken, ACCESS_TOKEN, '必须补回 workos: 前缀')
})

test('⚠️ `data` 信封里的 ISO `expiresAt` 必须被解析（否则 expiresAt 恒为 0）', () => {
  // 真实缺陷：`expiresAt` 是**顶层是 ISO 字符串、且在 `data` 信封里**，
  // 而解析原先只看顶层 —— 于是登录/续期拿到的凭据 `expiresAt` 恒为 0。
  // 后果不是「少显示一个字段」：`needsRefresh(0, now)` 恒为 true，
  // 即**每次请求前都白续一次期**，而 cline 的 refresh token 是**一次性轮换**的
  // —— 白续期会真的消耗轮换次数，把账号推向不可续期。
  const expected = Date.parse('2030-09-25T05:23:47.000Z')

  // ① 官方形态：`data.expiresAt` 是 ISO 字符串
  assert.equal(clineCredentialFromRegisterResponse(REGISTER_OK, 'cn').expiresAt, expected)

  // ② 顶层 ISO 字符串
  assert.equal(
    clineCredentialFromRegisterResponse(
      { accessToken: ACCESS_TOKEN, expiresAt: '2030-09-25T05:23:47.000Z' },
      'cn',
    ).expiresAt,
    expected,
  )

  // ③ 数字秒（老形态）仍按秒解释，不被当成毫秒
  assert.equal(
    clineCredentialFromRegisterResponse(
      { accessToken: ACCESS_TOKEN, expiresAt: 1_916_544_227 },
      'cn',
    ).expiresAt,
    expected,
  )

  // ④ 完全没有过期时间 ⇒ 0（未知），不编造
  assert.equal(
    clineCredentialFromRegisterResponse({ accessToken: ACCESS_TOKEN }, 'cn').expiresAt,
    0,
  )
})

test('⚠️ `success:false`（即使 HTTP 200）必须抛错，不得产出凭据', () => {
  // 只看 HTTP 状态码会把失败信封当成功，产出一份永远 401 的凭据，
  // 而用户看到的是「登录成功」。
  assert.throws(
    () => clineCredentialFromRegisterResponse({ success: false, error: '工作区未授权' }, 'cn'),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.match(error.message, /工作区未授权/)
      return true
    },
  )
})

test('非对象 / 缺令牌的注册响应必须抛错（不静默产出坏凭据）', () => {
  for (const bad of [null, 'not-json', 42, [], { success: true, data: {} }]) {
    assert.throws(
      () => clineCredentialFromRegisterResponse(bad, 'cn'),
      (error: unknown) => error instanceof ProviderError,
      `${JSON.stringify(bad)} 应抛 ProviderError`,
    )
  }
})

// ─────────────────── ⑤ 能力声明与无状态友好的持久化 ───────────────────

test('⚠️ cline 现在声明 login=true，且三步流程都有可调用的原语', () => {
  const provider = findProvider('cline')
  assert.equal(provider?.capabilities.login, true, '三步流程已实现并接线，能力位必须如实为 true')
  // 声明能登录就**必须**真的有可用的登录原语（避免「声明了却做不到」）
  assert.equal(typeof requestClineDeviceAuthorization, 'function')
  assert.equal(typeof pollClineDeviceTokenOnce, 'function')
  assert.equal(typeof registerClineTokens, 'function')
})

test('⚠️ 登录函数必须可注入 fetcher（否则单测会打真实端点、作废用户凭据）', () => {
  // cline 的 refreshToken 是一次性轮换的：任何「顺手验证一下」的真实调用
  // 都可能把用户本机那份凭据废掉。注入点是这条纪律的**唯一**保障。
  const src = readFileSync('src/providers/cline.ts', 'utf8')
  for (const fn of ['requestClineDeviceAuthorization', 'pollClineDeviceTokenOnce', 'registerClineTokens']) {
    const start = src.indexOf(`export async function ${fn}`)
    assert.ok(start > 0, `找不到 ${fn}`)
    const body = src.slice(start, start + 900)
    assert.ok(/fetcher/.test(body), `${fn} 必须接受可注入的 fetcher`)
    assert.ok(!/await fetch\(/.test(body), `${fn} 不得直接调用全局 fetch`)
  }
})

test('⚠️ 设备码节流状态必须**持久化在会话载荷**里（Workers 无跨请求内存）', () => {
  // 面板每 3 秒发一个**独立** HTTP 请求来轮询。若把 intervalMs / nextPollAt
  // 放在模块变量里，isolate 一回收就丢，`slow_down` 的累积退避**静默失效**
  // （表现为被 WorkOS 持续限流，且没有任何报错）。
  const src = readFileSync('src/index.ts', 'utf8')
  const start = src.indexOf("if (saved.payload['kind'] === 'cline')")
  assert.ok(start > 0, 'index.ts 里找不到 cline 轮询分支')
  const body = src.slice(start, start + 4200)

  // ⚠️ 断言的是**写回会话的载荷**，不是「出现过这个词」——
  // 读取处（`sessionNumber(saved.payload, 'nextPollAt')`）也会出现同名标识符，
  // 只查词存在会让「压根没写回」的坏实现蒙混过关（反向验证时实测到了）。
  const write = /saveLoginSession\(\s*state,\s*\{([\s\S]*?)\},\s*deadline[^,)]*,?\s*\)/.exec(body)
  assert.notEqual(write, null, 'pending 时必须把新状态写回会话')
  const payload = write?.[1] ?? ''
  assert.ok(payload.includes('intervalMs: outcome.intervalMs'), '写回的载荷必须带新的 intervalMs')
  assert.ok(payload.includes('nextPollAt:'), '写回的载荷必须带 nextPollAt（否则退避后立刻再打上游）')
  assert.ok(payload.includes('...saved.payload'), '写回必须展开原载荷（deviceCode 等不能丢）')

  assert.ok(body.includes('deadline'), '必须读会话里的 deadline（设备码有效期）')
  assert.ok(!/^\s*let\s+intervalMs/m.test(body), '间隔不得放在模块变量里（会随 isolate 回收丢失）')
})

test('⚠️ cline 的设备码会话落在 cn 分片（与凭据的 realm 一致）', () => {
  // 会话分片与账号分片不一致 ⇒ 轮询找不到会话（「会话不存在或已过期」）。
  const src = readFileSync('src/index.ts', 'utf8')
  assert.ok(/providerId === 'cline'/.test(src), '应有一条 cline 发起分支')
  assert.ok(src.includes("provider: 'cline',\n            kind: 'cline',\n            realm: loginRealm"),
    'cline 会话必须记录 realm（与 loginRealm 一致）')
})

test('⚠️ 会话 TTL 必须比设备码 deadline 多留宽限（否则过期时面板一直空等）', () => {
  // `readLoginSession` 在 `expires_at <= now` 时**直接删掉**会话
  // （`src/store/db.ts:128-134`）。若会话 TTL 恰好等于 deadline，设备码一过期
  // 轮询就只会拿到通用的「会话不存在或已过期」—— 那条响应**没有 `status`**，
  // 面板把它当成「继续等」，用户要空等到面板自己的 100 次超时（约 5 分钟）
  // 才知道失败。留出宽限后 `now > deadline` 分支才有机会回 `status:'failed'`。
  const src = readFileSync('src/index.ts', 'utf8')
  const start = src.indexOf("if (providerId === 'cline')")
  assert.ok(start > 0, '找不到 cline 发起分支')
  const startBody = src.slice(start, start + 2600)

  assert.ok(/const sessionTtl = deadline \+ CLINE_LOGIN_SESSION_GRACE_MS/.test(startBody),
    '发起时会话 TTL 必须是 deadline + 宽限')
  assert.ok(/saveLoginSession\(\s*state,\s*\{[\s\S]*?\},\s*sessionTtl,?\s*\)/.test(startBody),
    '发起时必须把 sessionTtl（不是 deadline）传给 saveLoginSession')

  // ⚠️ 每轮 pending 写回也必须带同一个宽限 —— 用 deadline 当 TTL 会在
  // 第一轮就把宽限窗口抹掉，等于没加（写这条断言时实测到了这个坑）。
  const pollStart = src.indexOf("if (saved.payload['kind'] === 'cline')")
  const pollBody = src.slice(pollStart, pollStart + 4200)
  assert.ok(/deadline \+ CLINE_LOGIN_SESSION_GRACE_MS/.test(pollBody),
    'pending 写回也必须用 deadline + 宽限，否则第一轮就抹掉了宽限')

  // 宽限常量本身必须是正的、且远小于设备码有效期（不能把会话拖成长期垃圾）
  const graceMatch = /const CLINE_LOGIN_SESSION_GRACE_MS = ([\d_]+)/.exec(src)
  assert.notEqual(graceMatch, null, '应有 CLINE_LOGIN_SESSION_GRACE_MS 常量')
  const grace = Number((graceMatch?.[1] ?? '0').replaceAll('_', ''))
  assert.ok(grace > 0, '宽限必须为正')
  assert.ok(grace <= 5 * 60_000, `宽限 ${grace}ms 过长，会让废弃会话长期占存储`)
})

test('⚠️ cline.ts 必须零 `node:` 导入（Workers 只认 Web 标准 API）', () => {
  const src = readFileSync('src/providers/cline.ts', 'utf8')
  const imports = src.match(/^\s*import[^\n]*from\s*'([^']+)'/gm) ?? []
  for (const line of imports) {
    assert.ok(!line.includes("'node:"), `cline.ts 不得导入 node: 模块：${line.trim()}`)
  }
})

// ─────────────────── ⑥ 面板：用户码式登录的渲染 ───────────────────

test('⚠️ 面板必须渲染 `userCode`（cline 是用户码式，只给链接用户会卡住）', () => {
  const js = readFileSync('src/panel/assets/app.js.txt', 'utf8')
  const start = js.indexOf('function renderLoginPrompt')
  assert.ok(start > 0, '找不到 renderLoginPrompt')
  const body = js.slice(start, start + 2600)

  // ⚠️ 断言的是**分支判据**，不是「出现过 userCode」——
  // 函数开头就有 `const userCode = body.userCode`，只查词存在的话
  // 「把分支删掉、退回纯链接渲染」的坏实现照样能过（反向验证时实测到了）。
  assert.match(body, /if \(typeof userCode === 'string' && userCode !== ''\)/,
    '必须有专门处理 userCode 的分支（否则用户拿到链接却不知道要输什么码）')
  assert.ok(body.includes("codeBox.className = 'user-code'"), '必须有一个专门展示用户码的容器')
  // ⚠️ 用户码必须留在页面上：轮询只更新状态文字，不能覆盖整块内容
  assert.ok(body.includes('el._loginStatus = status'), '轮询必须只更新状态文字（用户码不能被覆盖掉）')
  // 链接优先用带 code 的完整 URL，没有才回落到基础 URL
  assert.ok(body.includes('body.verificationUriComplete') && body.includes('body.verificationUri'),
    '链接必须优先用 verificationUriComplete，并回落到 verificationUri')
})

test('⚠️ 面板仍不得出现 innerHTML 赋值（XSS）', () => {
  const js = readFileSync('src/panel/assets/app.js.txt', 'utf8')
  const assignments = js.match(/\.innerHTML\s*=/g) ?? []
  assert.equal(assignments.length, 0, `发现 ${assignments.length} 处 innerHTML 赋值`)
})

test('⚠️ 用户码样式必须白底深字且可整段选中（深色主题下要能看清/抄对）', () => {
  const css = readFileSync('src/panel/assets/style.css.txt', 'utf8')
  assert.ok(css.includes('.user-code'), '应有 .user-code 样式')
  const start = css.indexOf('.user-code {')
  const block = css.slice(start, css.indexOf('}', start))
  assert.match(block, /background:\s*#fff/, '必须白底（深色主题下低对比会抄错码）')
  assert.match(block, /user-select:\s*all/, '必须可整段选中（用户要复制它）')
  assert.match(block, /ui-monospace/, '必须等宽字体（避免 0/O、1/I 看错）')
})

test('⚠️ cline 的登录方式标签必须写明是「用户码」而不是笼统的「设备码登录」', () => {
  const js = readFileSync('src/panel/assets/app.js.txt', 'utf8')
  const start = js.indexOf('const LOGIN_KIND_LABEL')
  const line = js.slice(start, js.indexOf('\n', start))
  assert.ok(line.includes("cline: '用户码登录'"),
    'cline 要用户手抄代码，标签必须提前说清（否则用户点开才发现要抄码）')
})
