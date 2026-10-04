/**
 * TRAE 浏览器回跳登录流程的单测（**全部走 mock fetch，零真实请求**）。
 *
 * ## ⚠️ 本文件绝不能打真实端点（读之前先看这条）
 *
 * TRAE 的 `refresh_token` 是**一次性轮换**的：对真实凭据发一次
 * `ExchangeToken` 就会把用户那份凭据作废（`src/providers/types.ts` 的
 * 「轮换型 refresh token 的操作纪律」；本项目已因此丢过两次账号）。
 * 故这里所有网络交互都由注入的 `fetcher` 承担，**没有一处**使用全局 fetch，
 * 也没有任何真实凭据。
 *
 * ## 这些断言锁的是什么
 *
 * 1. **登录 URL 的 18 个参数逐字对齐**（`trae-oauth.ts:99-127`）：
 *    参数名写错（尤其 `auth_callback_url` 写成 `callback_url`）会让登录页
 *    **永远停在授权中**，既不跳转也不回传 —— 现象是「点了没反应」，极难归因；
 * 2. **`login_trace_id` 必须走 `machineTraceId` 的派生**（取拼接串尾部 16 字符），
 *    它是回调反查 pending 的唯一凭据，自创派生方式会让回调认不出会话；
 * 3. **两套回调形态都要认**：老流程（直传 token）与新流程（PKCE `code`）。
 *    只认前者会在上游切换流程时把**合法回调**判为失败，错误信息还会指向错误方向；
 * 4. **`machine_id` / `device_id` 必须落进凭据**（`extras`）：它们不在任何响应里，
 *    丢了会让后续请求被判「异常设备」、签到被「该设备已签到」拦截；
 * 5. **回灌 `parseCredential`**：登录拿到的凭据必须与「粘贴导入」**同形**，
 *    否则同一账号会变成两条记录。
 *
 * 运行：`npm test`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  buildTraeCallbackUrl,
  buildTraeLoginURL,
  exchangeTraeCallback,
  fixNicknameMojibake,
  generateDeviceId,
  generateMachineId,
  generateTraeLoginState,
  machineTraceId,
  parseTraeCallback,
  TRAE_AUTHORIZATION_PATH,
  TRAE_CONSOLE_HOST,
  TRAE_LOGIN_CALLBACK_PATH,
  TRAE_LOGIN_STATE_TTL_MS,
  TRAE_OAUTH_HOST,
  TRAE_PLUGIN_VERSION,
  TRAE_USER_INFO_PATH,
  TRAE_EXCHANGE_PATH,
} from '../src/providers/trae.ts'
import { findProvider } from '../src/providers/index.ts'
import { ProviderError } from '../src/providers/types.ts'

/** 造一个只回固定响应的 mock fetch，并记录收到的调用。 */
function mockFetcher(responses: Array<() => Response | Promise<Response>>): {
  fetcher: typeof fetch
  calls: Array<{ url: string; method: string; contentType: string; body: string; ua: string; cloudide: string }>
  count: () => number
} {
  const calls: Array<{ url: string; method: string; contentType: string; body: string; ua: string; cloudide: string }> = []
  let index = 0
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers = new Headers(init?.headers)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      contentType: headers.get('content-type') ?? '',
      body: typeof init?.body === 'string' ? init.body : '',
      ua: headers.get('user-agent') ?? '',
      cloudide: headers.get('x-cloudide-token') ?? '',
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

/** 一份标准的 ExchangeToken 响应。 */
const EXCHANGE_OK = {
  Result: {
    Token: 'ACCESS-NEW',
    RefreshToken: 'REFRESH-ROTATED',
    TokenExpireAt: 1_800_000_000,
    TokenExpireDuration: 0,
    RefreshExpireAt: 0,
  },
}

/** 一份标准的 GetUserInfo 响应。 */
const USER_INFO_OK = {
  Result: {
    UserID: '4056564292660009',
    ScreenName: '用户26815487395',
    EnterpriseID: 'ent-1',
    NonPlainTextMobile: '130******00',
  },
}

// ─────────────────── ① 设备身份 ───────────────────

test('⚠️ machine_id / device_id 都是 **32 位 hex**（不是 16 位纯数字）', () => {
  // 依据：`trae.ts:181-195` —— device_id 早期被写成「16 位纯数字」，
  // 那是 CodeBuddy 的签到设备号格式，与 TRAE 协议不符（`trae.ts:1303-1307`）。
  for (const make of [generateMachineId, generateDeviceId]) {
    const value = make()
    assert.match(value, /^[0-9a-f]{32}$/, `必须是 32 位小写 hex，实际：${value}`)
  }
})

test('⚠️ 每次生成都不同（账号间必须互异，否则签到被「该设备已签到」拦截）', () => {
  const ids = new Set(Array.from({ length: 20 }, () => generateDeviceId()))
  assert.equal(ids.size, 20, 'device_id 不得重复')
})

test('⚠️ login_trace_id 是**拼接串的尾部 16 字符**（不要自创派生方式）', () => {
  // 依据：`trae-oauth.ts:71-76` 的 `machineTraceId`（对齐 Go 端 `callback.go:55-63`）。
  // 它是回调反查 pending 的唯一凭据 —— 值不一致会让回调认不出是哪个会话。
  const machineId = 'a'.repeat(32)
  const deviceId = 'b'.repeat(32)
  assert.equal(machineTraceId(machineId, deviceId), 'b'.repeat(16))
  // 不足 16 时**左侧**补 0（不是右侧）
  assert.equal(machineTraceId('abc', 'def'), '0000000000abcdef')
})

// ─────────────────── ② 登录 URL 协议 ───────────────────

test('⚠️ 登录 URL 必须带齐 18 个参数，且回调参数名是 auth_callback_url', () => {
  const machineId = 'm'.repeat(32)
  const deviceId = 'd'.repeat(32)
  const callbackUrl = 'https://example.workers.dev/login/trae/callback/abc123'
  const url = new URL(buildTraeLoginURL(machineId, deviceId, callbackUrl))

  // host / path 必须是登录门户（不是 oauth / agent / ug 三个 host）
  assert.equal(url.origin, TRAE_CONSOLE_HOST, '登录页在 www.trae.cn')
  assert.equal(url.pathname, TRAE_AUTHORIZATION_PATH)

  const params = url.searchParams
  // ⚠️ 参数名错了，TRAE 拿不到回调地址 → 登录页**永远停在授权中**
  //（`trae-oauth.ts:86-91` 记录的真实缺陷）。
  assert.equal(params.get('auth_callback_url'), callbackUrl,
    '回调参数名必须是 auth_callback_url（不是 callback_url，也没有 redirect_uri）')
  assert.equal(params.get('callback_url'), null, '不得出现 callback_url')
  assert.equal(params.get('redirect_uri'), null, '不得出现 redirect_uri')

  // 通道参数：缺失时流程走不到回传分支（`trae-oauth.ts:92-93`）
  assert.equal(params.get('login_version'), '1')
  assert.equal(params.get('auth_from'), 'solo')
  assert.equal(params.get('login_channel'), 'native_ide')
  assert.equal(params.get('auth_type'), 'local')
  assert.equal(params.get('redirect'), '0')
  assert.equal(params.get('plugin_version'), TRAE_PLUGIN_VERSION)

  // 设备身份：本体 + x_* 伪装（缺席可能被风控拦截，`trae-oauth.ts:95`）
  assert.equal(params.get('machine_id'), machineId)
  assert.equal(params.get('device_id'), deviceId)
  assert.equal(params.get('x_machine_id'), machineId)
  assert.equal(params.get('x_device_id'), deviceId)
  assert.equal(params.get('x_device_brand'), 'PC')
  assert.equal(params.get('x_device_type'), 'PC')
  assert.equal(params.get('x_os_version'), '1.0')
  assert.equal(params.get('x_app_type'), 'stable')
  assert.equal(params.get('login_trace_id'), machineTraceId(machineId, deviceId),
    'login_trace_id 必须是 machineTraceId 的派生结果')
  assert.ok((params.get('client_id') ?? '').length > 0, 'client_id 必填')
  assert.ok((params.get('x_app_version') ?? '').length > 0, 'x_app_version 必填')

  // 17 个显式参数（`client_id` 在内共 18 个 —— 逐个点名，防漏）
  for (const key of [
    'login_version', 'auth_from', 'login_channel', 'plugin_version', 'auth_type',
    'client_id', 'redirect', 'login_trace_id', 'auth_callback_url',
    'machine_id', 'device_id', 'x_device_id', 'x_machine_id', 'x_device_brand',
    'x_device_type', 'x_os_version', 'x_app_version', 'x_app_type',
  ]) {
    assert.ok(params.get(key) !== null, `缺少参数：${key}`)
  }
  assert.equal([...params.keys()].length, 18, '参数个数必须恰好 18（多一个都可能被风控拦）')
})

test('⚠️ plugin_version 与 x_app_version 是**两个不同**的值，不可混用', () => {
  // `trae-product.ts:142-145`：pluginVersion（给登录门户）与 ideVersion
  // （chat 端点的模型准入版本）是两个独立字段。
  const url = new URL(buildTraeLoginURL('m'.repeat(32), 'd'.repeat(32), 'https://x/y'))
  assert.equal(url.searchParams.get('plugin_version'), '2.3.62834')
  assert.notEqual(url.searchParams.get('plugin_version'), url.searchParams.get('x_app_version'))
})

test('⚠️ 回调地址 state 走**路径**（query 形态对「字符串拼参数」的上游不成立）', () => {
  // 依据：`codearts.ts:716-722` 同款理由 —— 参考实现的回调 URL 不带 query，
  // 无法推断上游是「按 URL API 合并 query」还是「字符串拼 ?x=y」。
  const built = buildTraeCallbackUrl('https://example.workers.dev/', 'state-1')
  assert.equal(built, `https://example.workers.dev${TRAE_LOGIN_CALLBACK_PATH}/state-1`)
  assert.ok(!built.includes('?'), '回调地址本身不得带 query')
  // 结尾多余的斜杠要被去掉（否则会拼出 `//login/...`）
  assert.equal(buildTraeCallbackUrl('https://a.b///', 's'), 'https://a.b/login/trae/callback/s')
})

test('⚠️ 登录 state 是 32 字节 CSPRNG（64 位 hex），不是 randomUUID', () => {
  // 它是这条**免鉴权**路径上唯一的能力凭证，不能有可猜结构。
  const state = generateTraeLoginState()
  assert.match(state, /^[0-9a-f]{64}$/, `必须是 64 位 hex，实际：${state}`)
  const set = new Set(Array.from({ length: 20 }, () => generateTraeLoginState()))
  assert.equal(set.size, 20, 'state 不得重复')
})

// ─────────────────── ③ 回调解析（两套流程） ───────────────────

/** 造一个回调 URL（相对形式，与真实回跳形态一致）。 */
function callbackUrl(params: Record<string, string>): string {
  const search = new URLSearchParams(params).toString()
  return `${TRAE_LOGIN_CALLBACK_PATH}/state-1?${search}`
}

test('⚠️ 老流程：回调**直接回传 token**（没有 ?code=）也能解出', () => {
  // 依据：`trae-oauth.ts:237-243` —— 真实回调形如
  // `?refreshToken=…&userInfo={…}&userJwt={…}`，**不是** OAuth 的 `?code=`。
  // 早期按 OAuth 惯例找 code 导致恒判失败 → 回 400 → 面板永远「认证中」。
  const parsed = parseTraeCallback(callbackUrl({
    refreshToken: 'RT-DIRECT',
    userInfo: JSON.stringify({ UserID: 'u-1', ScreenName: '张三', TenantID: 't-1' }),
  }))
  assert.equal(parsed.ok, true, '老流程回调必须能解出')
  if (!parsed.ok) return
  assert.equal(parsed.info.refreshToken, 'RT-DIRECT')
  assert.equal(parsed.info.accessToken, '', '有 refreshToken 时不该用 userJwt.Token 兜底')
  assert.equal(parsed.info.uid, 'u-1')
  assert.equal(parsed.info.enterpriseId, 't-1', '回调字段名是 TenantID')
})

test('⚠️ refreshToken 缺失时回退 userJwt.RefreshToken，再退 userJwt.Token', () => {
  // 依据：`trae-oauth.ts:294-295` 与 `login.sh:165-166`。
  const viaJwt = parseTraeCallback(callbackUrl({
    userJwt: JSON.stringify({ Token: 'AT', RefreshToken: 'RT-JWT' }),
    userInfo: JSON.stringify({ UserID: 'u-2' }),
  }))
  assert.equal(viaJwt.ok, true)
  if (viaJwt.ok) {
    assert.equal(viaJwt.info.refreshToken, 'RT-JWT', '应回退 userJwt.RefreshToken')
    assert.equal(viaJwt.info.accessToken, '', '有 refreshToken 就不用 Token 兜底')
  }

  const tokenOnly = parseTraeCallback(callbackUrl({
    userJwt: JSON.stringify({ Token: 'AT-ONLY' }),
    userInfo: JSON.stringify({ UserID: 'u-3' }),
  }))
  assert.equal(tokenOnly.ok, true)
  if (tokenOnly.ok) {
    assert.equal(tokenOnly.info.refreshToken, '')
    assert.equal(tokenOnly.info.accessToken, 'AT-ONLY', '只有 Token 时才兜底')
  }
})

test('⚠️ PKCE 新流程（带 code）是**合法回调**，只是我们暂不支持', () => {
  // 依据：`trae-oauth.ts:249-259`（出处 `Trae2api-cn/src/main.py:478-484`）：
  // TRAE 授权页并存两套流程。把带 code 的回调一律判为「无效」，
  // 一旦上游切换流程就会把合法回调误判为失败，且文案指向错误方向。
  for (const params of [
    { code: 'ac-1' },
    { authCode: 'ac-2' },
    { authCodeInfo: JSON.stringify({ code: 'ac-3' }) },
    // ⚠️ authCodeInfo 也可能是**纯 code 字符串**（非 JSON），两种都要认
    { authCodeInfo: 'ac-4' },
  ]) {
    const parsed = parseTraeCallback(callbackUrl({ ...params, userInfo: JSON.stringify({ UserID: 'u' }) }))
    assert.equal(parsed.ok, false, `${JSON.stringify(params)} 应判为 PKCE 流程`)
    if (parsed.ok) continue
    assert.equal(parsed.authCodeFlow, true, '必须用 authCodeFlow 标出真实原因')
    assert.match(parsed.reason, /PKCE/, '原因必须点名 PKCE，不能含糊说「缺少 refreshToken」')
  }
})

test('⚠️ 两种形态同时出现时以 token 为准（PKCE 是回退，不是覆盖）', () => {
  // 依据：`trae-oauth.ts:327-344` —— 有 token 就直接用，code 只作提示。
  const parsed = parseTraeCallback(callbackUrl({
    refreshToken: 'RT-BOTH',
    code: 'should-be-ignored',
    userInfo: JSON.stringify({ UserID: 'u' }),
  }))
  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.equal(parsed.info.refreshToken, 'RT-BOTH')
})

test('⚠️ 什么凭证都没有时，失败原因要说清「缺什么」（而不是静默）', () => {
  const parsed = parseTraeCallback(callbackUrl({ userInfo: JSON.stringify({ UserID: 'u' }) }))
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.equal(parsed.authCodeFlow, false)
  assert.match(parsed.reason, /refreshToken/)
})

test('⚠️ userInfo 中文昵称的双重编码乱码必须修复（否则凭据里是乱码）', () => {
  // 依据：`trae-oauth.ts:209-232` —— 实测昵称乱码 `Óû§8847309959`。
  // 修不好且**不含 CJK** 时回退「用户+uid末4位」（不把乱码写进凭据）。
  const mojibake = '张三'
  const bytes = new Uint8Array([...new TextEncoder().encode(mojibake)])
  const latin1 = [...bytes].map((b) => String.fromCharCode(b)).join('')
  assert.equal(fixNicknameMojibake(latin1, 'u'), '张三', '应能回转出正确中文')

  // ⚠️ 修不好且**不含 CJK** ⇒ 回退「用户+uid末4位」（绝不把乱码写进凭据）。
  // 实测形态见 `trae-oauth.ts:216-232`（`Óû§8847309959`）。
  assert.equal(fixNicknameMojibake('Óû§8847309959', '4056564292660009'), '用户0009')
  // 已经是正常中文 ⇒ 原样返回
  assert.equal(fixNicknameMojibake('李四', 'u'), '李四')
  // 纯 ASCII 本身就是合法 UTF-8 ⇒ 原样返回（不是乱码，不该被替换掉）
  assert.equal(fixNicknameMojibake('plain-ascii', 'u'), 'plain-ascii')
})

test('⚠️ 回调 URL 无法解析时必须返回失败原因（不能抛异常打断回调页）', () => {
  const parsed = parseTraeCallback('http://[::1')
  assert.equal(parsed.ok, false)
})

// ─────────────────── ④ 换取凭据（mock fetch） ───────────────────

test('⚠️ 有 refreshToken ⇒ 走 ExchangeToken，且字段名是**大写开头**的四个', async () => {
  const { fetcher, calls } = mockFetcher([
    () => jsonResponse(EXCHANGE_OK),
    () => jsonResponse(USER_INFO_OK),
  ])
  const credential = await exchangeTraeCallback(
    {
      refreshToken: 'RT-IN', accessToken: '', uid: '', nickname: '', enterpriseId: '',
    },
    { machineId: 'm'.repeat(32), deviceId: 'd'.repeat(32) },
    { fetcher, nowMs: 1_700_000_000_000 },
  )

  assert.equal(calls[0]?.url, `${TRAE_OAUTH_HOST}${TRAE_EXCHANGE_PATH}`)
  assert.equal(calls[0]?.method, 'POST')
  assert.equal(calls[0]?.contentType, 'application/json')
  // ⚠️ OAuth 端点**无签名**，只靠 UA 识别客户端（`trae-oauth.ts:408-414`）
  assert.ok((calls[0]?.ua ?? '').length > 0, '必须带 User-Agent')
  const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>
  // ⚠️ 四个字段名都是大写开头，且 ClientSecret 是字面量 '-'、UserID 是空串 ——
  // 这两点是**实测值**，不是占位符（`trae-oauth.ts:376-380`）。
  assert.deepEqual(body, {
    ClientID: 'en1oxy7wnw8j9n',
    RefreshToken: 'RT-IN',
    ClientSecret: '-',
    UserID: '',
  })

  // 第二轮：GetUserInfo 必须带 X-Cloudide-Token（漏了拿不到用户信息）
  assert.equal(calls[1]?.url, `${TRAE_OAUTH_HOST}${TRAE_USER_INFO_PATH}`)
  assert.equal(calls[1]?.cloudide, 'ACCESS-NEW', 'GetUserInfo 必须带 X-Cloudide-Token')

  assert.equal(credential.accessToken, 'ACCESS-NEW')
  assert.equal(credential.refreshToken, 'REFRESH-ROTATED', '必须用轮换后的新 refresh_token')
  assert.equal(credential.uid, '4056564292660009')
  // 展示名取脱敏手机号（完整理由见下方「展示名取**脱敏手机号优先**」用例）
  assert.equal(credential.nickname, '130******00')
})

test('⚠️ machine_id / device_id 必须落进凭据（否则设备身份丢失）', async () => {
  // 它们**不在任何响应里**，只能来自本次登录会话。丢了会让后续请求被判
  // 「异常设备」，签到被「该设备已签到」拦截（`trae.ts:17-19`）。
  const machineId = 'a1'.repeat(16)
  const deviceId = 'b2'.repeat(16)
  const { fetcher } = mockFetcher([
    () => jsonResponse(EXCHANGE_OK),
    () => jsonResponse(USER_INFO_OK),
  ])
  const credential = await exchangeTraeCallback(
    { refreshToken: 'RT', accessToken: '', uid: '', nickname: '', enterpriseId: '' },
    { machineId, deviceId },
    { fetcher },
  )
  assert.equal(credential.extras['machine_id'], machineId)
  assert.equal(credential.extras['device_id'], deviceId)
  // 回灌 parseCredential ⇒ 与「粘贴导入」同形（否则同一账号会变成两条记录）
  assert.equal(credential.provider, 'trae')
})

test('⚠️ 无 refreshToken ⇒ **不走** ExchangeToken，直接用 userJwt.Token 兜底', async () => {
  // 依据：`trae-oauth.ts:394-403` 的分支 2。多发一次 ExchangeToken 是无意义的
  // 上游请求（且在有 refreshToken 的账号上会**轮换**掉凭据）。
  const { fetcher, calls } = mockFetcher([() => jsonResponse(USER_INFO_OK)])
  const credential = await exchangeTraeCallback(
    { refreshToken: '', accessToken: 'AT-FALLBACK', uid: 'u-fb', nickname: '张三', enterpriseId: '' },
    { machineId: 'm'.repeat(32), deviceId: 'd'.repeat(32) },
    { fetcher },
  )
  assert.equal(calls.length, 1, '只该有 GetUserInfo 一次请求')
  assert.equal(calls[0]?.url, `${TRAE_OAUTH_HOST}${TRAE_USER_INFO_PATH}`)
  assert.equal(credential.accessToken, 'AT-FALLBACK')
  assert.equal(credential.refreshToken, '', '没有就是没有，不编造')
})

test('⚠️ GetUserInfo 失败**不阻塞**（回退回调 userInfo，对齐 login.sh:208-209）', async () => {
  const { fetcher } = mockFetcher([
    () => jsonResponse(EXCHANGE_OK),
    () => new Response('<html>500</html>', { status: 500 }),
  ])
  const credential = await exchangeTraeCallback(
    {
      refreshToken: 'RT', accessToken: '', uid: 'u-from-callback',
      nickname: '回调昵称', enterpriseId: 't-cb',
    },
    { machineId: 'm'.repeat(32), deviceId: 'd'.repeat(32) },
    { fetcher },
  )
  assert.equal(credential.uid, 'u-from-callback', '应沿用回调里的 uid')
  assert.equal(credential.nickname, '回调昵称')
  assert.equal(credential.extras['machine_id'], 'm'.repeat(32))
})

test('⚠️ ExchangeToken 缺 Token 时必须抛错（不能产出空令牌凭据）', async () => {
  const { fetcher } = mockFetcher([() => jsonResponse({ Result: { RefreshToken: 'x' } })])
  await assert.rejects(
    () => exchangeTraeCallback(
      { refreshToken: 'RT', accessToken: '', uid: 'u', nickname: '', enterpriseId: '' },
      { machineId: 'm'.repeat(32), deviceId: 'd'.repeat(32) },
      { fetcher },
    ),
    (error: unknown) => error instanceof ProviderError && /缺少 Token/.test(error.message),
  )
})

test('⚠️ 凭据失效时网关回 HTML 错误页 ⇒ 报错要带**原文片段**，不能是 Unexpected token', async () => {
  // 依据：`trae-auth.ts:397-408` —— 直接 `response.json()` 会抛
  // `Unexpected token '<'`，那个报错对用户毫无信息量。
  const { fetcher } = mockFetcher([
    () => new Response('<html><body>login required</body></html>', { status: 401 }),
  ])
  await assert.rejects(
    () => exchangeTraeCallback(
      { refreshToken: 'RT', accessToken: '', uid: 'u', nickname: '', enterpriseId: '' },
      { machineId: 'm'.repeat(32), deviceId: 'd'.repeat(32) },
      { fetcher },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.equal(error.httpStatus, 401)
      assert.equal(error.retryable, false, '401 是终态，不该让面板无限重试')
      assert.match(error.message, /login required/, '必须带上上游原文片段')
      return true
    },
  )
})

test('⚠️ 5xx / 429 标为 retryable（面板据此继续轮询而不是判死）', async () => {
  for (const status of [500, 429]) {
    const { fetcher } = mockFetcher([() => new Response('boom', { status })])
    await assert.rejects(
      () => exchangeTraeCallback(
        { refreshToken: 'RT', accessToken: '', uid: 'u', nickname: '', enterpriseId: '' },
        { machineId: 'm'.repeat(32), deviceId: 'd'.repeat(32) },
        { fetcher },
      ),
      (error: unknown) => error instanceof ProviderError && error.retryable === true,
    )
  }
})

test('⚠️ 网络层失败也标 retryable（网络抖动不该让用户重新登录）', async () => {
  const fetcher = (async () => { throw new Error('network down') }) as unknown as typeof fetch
  await assert.rejects(
    () => exchangeTraeCallback(
      { refreshToken: 'RT', accessToken: '', uid: 'u', nickname: '', enterpriseId: '' },
      { machineId: 'm'.repeat(32), deviceId: 'd'.repeat(32) },
      { fetcher },
    ),
    (error: unknown) => error instanceof ProviderError && error.retryable === true,
  )
})

test('⚠️ 过期时间必须真的落进凭据（不是 0 = 未知，否则永不续期）', async () => {
  // ⚠️ `parseCredential` 的 `pickExpiresAt` 走 `pickString`（**只认字符串**）：
  // 传数字会被静默丢成 0 = 「过期时间未知」，凭据于是永不触发续期，
  // 直到某天全线 401。这条用例就是锁住那个「转字符串」的动作。
  const { fetcher } = mockFetcher([
    () => jsonResponse(EXCHANGE_OK),
    () => jsonResponse(USER_INFO_OK),
  ])
  const credential = await exchangeTraeCallback(
    { refreshToken: 'RT', accessToken: '', uid: '', nickname: '', enterpriseId: '' },
    { machineId: 'm'.repeat(32), deviceId: 'd'.repeat(32) },
    { fetcher },
  )
  // ExchangeToken 的 TokenExpireAt = 1_800_000_000（Unix **秒**）⇒ ×1000 成毫秒。
  // ⚠️ 不乘 1000 会让凭据落在 1970 年（`trae.ts:512-530` 的秒→毫秒规则）。
  assert.equal(credential.expiresAt, 1_800_000_000_000)
})

test('⚠️ uid 全空时必须抛错（uid 是账号主键，不能落成空账号）', async () => {
  const { fetcher } = mockFetcher([
    () => jsonResponse(EXCHANGE_OK),
    () => jsonResponse({ Result: {} }),
  ])
  await assert.rejects(
    () => exchangeTraeCallback(
      { refreshToken: 'RT', accessToken: '', uid: '', nickname: '', enterpriseId: '' },
      { machineId: 'm'.repeat(32), deviceId: 'd'.repeat(32) },
      { fetcher },
    ),
    (error: unknown) => error instanceof ProviderError && /uid/.test(error.message),
  )
})

test('⚠️ 展示名取**脱敏手机号优先**（多账号消歧最有效的字段）', async () => {
  // 依据：`trae.ts` 的 `traeDisplayNickname` 记录了实测 —— ScreenName 是字节
  // passport 按 uid 自动生成的默认名（`用户26815487395` / `用户9340371069` …），
  // 四个账号形态完全一致，一屏列出来根本认不出谁是谁；而脱敏手机号末两位互异。
  // 用户明确要求过这个展示形态。
  const { fetcher } = mockFetcher([
    () => jsonResponse(EXCHANGE_OK),
    () => jsonResponse(USER_INFO_OK),
  ])
  const credential = await exchangeTraeCallback(
    { refreshToken: 'RT', accessToken: '', uid: '', nickname: '', enterpriseId: '' },
    { machineId: 'm'.repeat(32), deviceId: 'd'.repeat(32) },
    { fetcher },
  )
  assert.equal(credential.nickname, '130******00',
    '有脱敏手机号时必须用它当展示名（ScreenName 认不出账号）')
})

test('⚠️ GetUserInfo 拿不到手机号时，展示名回退 ScreenName（不显示空）', async () => {
  const { fetcher } = mockFetcher([
    () => jsonResponse(EXCHANGE_OK),
    () => jsonResponse({ Result: { UserID: 'u-9', ScreenName: '用户9340371069' } }),
  ])
  const credential = await exchangeTraeCallback(
    { refreshToken: 'RT', accessToken: '', uid: '', nickname: '', enterpriseId: '' },
    { machineId: 'm'.repeat(32), deviceId: 'd'.repeat(32) },
    { fetcher },
  )
  assert.equal(credential.nickname, '用户9340371069')
})

// ─────────────────── ⑤ 接线（src/index.ts） ───────────────────

test('⚠️ trae 的回调路由必须**在鉴权检查之前**（浏览器带不了 Authorization）', () => {
  const src = readFileSync('src/index.ts', 'utf8')
  const routeIndex = src.indexOf('path === TRAE_LOGIN_CALLBACK_PATH')
  assert.ok(routeIndex > 0, 'index.ts 必须有 trae 回调路由')
  const authIndex = src.indexOf('if (!(await authorized(request, env)))')
  assert.ok(authIndex > 0, 'index.ts 必须有鉴权检查')
  assert.ok(routeIndex < authIndex, '回调路由必须排在鉴权检查之前，否则浏览器永远收不到结果页')
})

test('⚠️ 回调**不得**调 ExchangeToken（轮换型 token 只能换一次）', () => {
  // 若回调也换取，回调的 waitUntil 与面板轮询会用同一个旧 refreshToken 各打一次
  // 上游 —— 第二次必然失败，且可能把第一次的凭据丢掉。
  // 故本项目的接线是：**只有 pollTraeLogin 调 exchangeTraeCallback**。
  const src = readFileSync('src/index.ts', 'utf8')
  const callbackBody = src.slice(
    src.indexOf('async function handleTraeCallback'),
    src.indexOf('async function pollTraeLogin'),
  )
  assert.ok(callbackBody.length > 0, '应能切出 handleTraeCallback 的函数体')
  assert.ok(!callbackBody.includes('exchangeTraeCallback'),
    'handleTraeCallback 不得调用 exchangeTraeCallback（会白轮换掉 refresh_token）')

  const pollBody = src.slice(src.indexOf('async function pollTraeLogin'))
  assert.ok(pollBody.includes('exchangeTraeCallback'), 'pollTraeLogin 必须调用 exchangeTraeCallback')
})

test('⚠️ 回调与轮询是两个独立请求 ⇒ 材料必须写进**登录会话载荷**', () => {
  // Workers 无跨请求内存：任何放在模块变量里的 flow 状态都会在两次请求之间丢失。
  const src = readFileSync('src/index.ts', 'utf8')
  const callbackBody = src.slice(
    src.indexOf('async function handleTraeCallback'),
    src.indexOf('async function pollTraeLogin'),
  )
  assert.ok(/saveLoginSession\([\s\S]*callback: parsed\.info/.test(callbackBody),
    '回调必须把解析结果写进会话载荷的 callback 字段')
  const pollBody = src.slice(src.indexOf('async function pollTraeLogin'))
  assert.ok(pollBody.includes("payload['callback']"), '轮询必须从会话载荷里读回材料')
  assert.ok(pollBody.includes("sessionString(payload, 'machineId')"),
    'machine_id 也必须来自会话载荷（它不在回调 URL 里）')
})

test('⚠️ 失败必须写回会话（否则面板只会一直等到超时）', () => {
  const src = readFileSync('src/index.ts', 'utf8')
  const callbackBody = src.slice(
    src.indexOf('async function handleTraeCallback'),
    src.indexOf('async function pollTraeLogin'),
  )
  assert.ok(/failed: parsed\.reason/.test(callbackBody),
    '回调解析失败时必须把原因写进会话，面板才能如实显示')
  const pollBody = src.slice(src.indexOf('async function pollTraeLogin'))
  assert.ok(pollBody.includes("sessionString(payload, 'failed')"),
    '轮询必须能复述终态失败原因（不静默、也不无限重试）')
})

// ─────────────────── ⑥ 能力声明 ───────────────────

test('⚠️ trae 现在声明 login=true（浏览器回跳流程已实现）', () => {
  const provider = findProvider('trae')
  assert.equal(provider?.capabilities.login, true)
  // 声明能登录就**必须**真的有可用的登录原语（避免「声明了却做不到」）
  assert.equal(typeof buildTraeLoginURL, 'function')
  assert.equal(typeof parseTraeCallback, 'function')
  assert.equal(typeof exchangeTraeCallback, 'function')
  assert.equal(typeof buildTraeCallbackUrl, 'function')
  assert.ok(TRAE_LOGIN_STATE_TTL_MS > 0, 'TTL 必须是正数')
})

test('⚠️ 面板必须把 trae 标成「浏览器登录」（否则用户去找不存在的设备码）', () => {
  const js = readFileSync('src/panel/assets/app.js.txt', 'utf8')
  assert.ok(/LOGIN_KIND_LABEL\s*=\s*\{[^}]*trae:\s*'浏览器登录'/.test(js),
    'LOGIN_KIND_LABEL 必须含 trae: 浏览器登录')
  assert.ok(/providerId === 'trae'/.test(js), 'loginWaitHint 必须覆盖 trae（回跳式流程的等待文案不同）')
})

test('⚠️ 零 node: 导入（Workers 只能跑纯 Web 标准）', () => {
  // 源实现 `trae-oauth.ts` 用了 `node:http` 的 createServer 与 Node 的 Buffer，
  // 两者在 Workers 都不可用 —— 本文件必须一个都不引入。
  const src = readFileSync('src/providers/trae.ts', 'utf8')
  const imports = src.split('\n').filter((line) => /^\s*import\b/.test(line))
  for (const line of imports) {
    assert.ok(!line.includes('node:'), `trae.ts 不得 import node: 模块：${line}`)
  }
  // ⚠️ 只禁**代码**里的 Buffer，注释里解释「源实现用了 Buffer，我们换掉了」是
  // 允许的（那正是为什么要改的说明）—— 故先剥掉注释再查。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  assert.ok(!/\bBuffer\b/.test(code), 'trae.ts 不得使用 Node 的 Buffer（注释除外）')
})
