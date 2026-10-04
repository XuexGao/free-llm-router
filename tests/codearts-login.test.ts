/**
 * CodeArts 浏览器回跳登录流程的单测（**全部走 mock fetch，零真实请求**）。
 *
 * ## ⚠️ 本文件绝不能打真实端点（读之前先看这条）
 *
 * CodeArts 的 `refresh_token` 是**单次使用**的：对真实凭据发一次续期请求就会
 * 把用户本机那份凭据废掉（`src/providers/types.ts` 的
 * 「轮换型 refresh token 的操作纪律」，以及 AGENTS.md 记录过的两次真实事故）。
 * 故这里所有网络交互都由注入的 `fetcher` 承担，**没有一处**使用全局 fetch。
 *
 * ## 这些断言锁的是什么
 *
 * 1. **URL 协议**：两级跳的 URL 必须与参考实现逐字同形（参数名写错 = 浏览器侧
 *    400，且现象是「点了没反应」，极难归因）；
 * 2. **两种响应形态**都能归一化，且**缺 SK 时不产出凭据**（源实现会产出永远
 *    401 的凭据 —— 我们刻意更严）；
 * 3. **轮询循环**的四条路径：成功 / 仍未就绪 / 终态错误 / 非 JSON 响应；
 * 4. **回灌 `parseCredential`**：登录拿到的材料必须能落成与「粘贴导入」**同形**
 *    的 `ProviderCredential`（否则同一账号会变成两条记录）。
 *
 * 运行：`npm test`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCodeArtsCallbackUrl,
  buildCodeArtsLoginUrl,
  codeArtsTicketCredentialToProvider,
  CODEARTS_LOGIN_BASE,
  CODEARTS_LOGIN_CALLBACK_PATH,
  CODEARTS_LOGIN_PLUGIN_NAME,
  CODEARTS_LOGIN_PLUGIN_VERSION,
  CODEARTS_LOGIN_STATE_TTL_MS,
  CODEARTS_TICKET_ENDPOINT,
  fetchCodeArtsTicket,
  generateCodeArtsLoginState,
  HUAWEI_AUTH_BASE,
  parseCodeArtsTicketResponse,
  pollCodeArtsTicket,
  readCodeArtsTicketError,
  type CodeArtsTicketMaterial,
} from '../src/providers/codearts.ts'
import { findProvider } from '../src/providers/index.ts'
import { ProviderError } from '../src/providers/types.ts'

/** 造一个只回固定响应的 mock fetch，并记录收到的调用。 */
function mockFetcher(responses: Array<() => Response | Promise<Response>>): {
  fetcher: typeof fetch
  calls: Array<{ url: string; headers: Headers; method: string }>
  count: () => number
} {
  const calls: Array<{ url: string; headers: Headers; method: string }> = []
  let index = 0
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, headers: new Headers(init?.headers), method: init?.method ?? 'GET' })
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

/** 一份完整的「形态 1」响应体（华为 IAM credential 形）。 */
const SHAPE_CREDENTIAL = {
  credential: {
    access: 'AKEXAMPLE',
    secret: 'SKEXAMPLE',
    securitytoken: 'TOKENEXAMPLE',
    expires_at: '2030-01-01T00:00:00Z',
  },
  domain_id: 'domain-1',
  user_id: 'user-1',
  user_name: '张三',
}

/** 一份完整的「形态 2」响应体（华为 IAM result 形）。 */
const SHAPE_RESULT = {
  result: {
    accessKeyId: 'AK2',
    secretAccessKey: 'SK2',
    securityToken: 'ST2',
    expiration: '2031-02-03T04:05:06Z',
  },
}

// ─────────────────── ① URL 协议 ───────────────────

test('登录 URL 是两级跳，且 auth_callback_url 指向**我们自己的**回调地址', () => {
  const callbackUrl = 'https://example.workers.dev/login/codearts/callback/abc123'
  const { redirectUrl, loginUrl } = buildCodeArtsLoginUrl(callbackUrl, 'ticket-1')

  // 第一级：doer/redirect —— 参数名与参考实现 login.ts:27 逐字对齐
  assert.ok(redirectUrl.startsWith(`${CODEARTS_LOGIN_BASE}?`), redirectUrl)
  assert.ok(redirectUrl.includes(`auth_callback_url=${encodeURIComponent(callbackUrl)}`),
    '回调地址必须整体 URL 编码（不编码会被 query 里的 & 截断）')
  assert.ok(redirectUrl.includes(`plugin-name=${CODEARTS_LOGIN_PLUGIN_NAME}`), '插件名必须带')
  assert.ok(redirectUrl.includes(`plugin-version=${CODEARTS_LOGIN_PLUGIN_VERSION}`), '插件版本必须带')
  assert.ok(redirectUrl.includes('ticket_id=ticket-1'), 'ticket_id 必须在第一级 URL 里')
  assert.ok(redirectUrl.includes('IdeaType=jetbrains'), 'IdeaType 对齐真实插件')

  // 第二级：华为登录页，service 参数里裹着整个 redirectUrl
  assert.ok(loginUrl.startsWith(`${HUAWEI_AUTH_BASE}?service=`), loginUrl)
  assert.equal(decodeURIComponent(loginUrl.slice(`${HUAWEI_AUTH_BASE}?service=`.length)), redirectUrl,
    'service 必须就是第一级 URL（解码后完全相等）')
})

test('⚠️ 回调地址**不带 query**（state 走路径），这样华为怎么拼 secret 都不会冲突', () => {
  // 依据：参考实现的回调 URL 是 `http://127.0.0.1:<port>/authentication`（login.ts:26），
  // 本身不带 query ⇒ 无法推断华为是「合并 query」还是「字符串拼 ?secret=」。
  // state 放路径里对两种行为都成立。
  const url = buildCodeArtsCallbackUrl('https://example.workers.dev', 'deadbeef')
  assert.equal(url, `https://example.workers.dev${CODEARTS_LOGIN_CALLBACK_PATH}/deadbeef`)
  assert.ok(!url.includes('?'), '回调 URL 不得带 query')
})

test('回调地址取请求 origin（自定义域与 workers.dev 都自动正确）', () => {
  assert.ok(buildCodeArtsCallbackUrl('https://a.example.com/', 's').startsWith('https://a.example.com/login/'))
  assert.ok(buildCodeArtsCallbackUrl('https://b.workers.dev', 's').startsWith('https://b.workers.dev/login/'))
})

test('⚠️ state 必须是不可猜的强随机（它是免鉴权路径上唯一的能力凭证）', () => {
  const a = generateCodeArtsLoginState()
  const b = generateCodeArtsLoginState()
  assert.match(a, /^[0-9a-f]{64}$/, '32 字节 → 64 位小写 hex')
  assert.notEqual(a, b, '两次生成必须不同')
  // 会话 10 分钟过期：能力凭证的窗口不能长（参考实现的浏览器那一程是 180 秒）
  assert.equal(CODEARTS_LOGIN_STATE_TTL_MS, 10 * 60 * 1000)
})

// ─────────────────── ② 两种响应形态的归一化 ───────────────────

test('形态 1（credential{access,secret,securitytoken}）能归一化', () => {
  const material = parseCodeArtsTicketResponse(SHAPE_CREDENTIAL)
  assert.notEqual(material, null)
  assert.equal(material?.access_key_id, 'AKEXAMPLE')
  assert.equal(material?.secret_access_key, 'SKEXAMPLE')
  assert.equal(material?.security_token, 'TOKENEXAMPLE')
  assert.equal(material?.expires_at, '2030-01-01T00:00:00Z')
  assert.equal(material?.user_id, 'user-1', 'user_id 是 uid 的来源，不能丢')
  assert.equal(material?.user_name, '张三')
})

test('形态 2（result{accessKeyId,secretAccessKey,securityToken,expiration}）能归一化', () => {
  const material = parseCodeArtsTicketResponse(SHAPE_RESULT)
  assert.notEqual(material, null)
  assert.equal(material?.access_key_id, 'AK2')
  assert.equal(material?.secret_access_key, 'SK2')
  assert.equal(material?.security_token, 'ST2')
  assert.equal(material?.expires_at, '2031-02-03T04:05:06Z')
})

test('载荷被包在 data 里时也能归一化（网关版本差异）', () => {
  const material = parseCodeArtsTicketResponse({ data: SHAPE_CREDENTIAL })
  assert.equal(material?.security_token, 'TOKENEXAMPLE')
})

test('⚠️ 缺 SK 时**不**产出凭据（源实现会给一个永远 401 的凭据）', () => {
  // 参考实现 login.ts:37-47 只要 access + securitytoken 非空就返回，
  // `secret_access_key` 允许是空串 —— 但没有 SK 就无法完成 SDK-HMAC-SHA256 签名。
  // 这里刻意更严：缺任一项都当作「尚未就绪」继续轮询。
  const partial = { credential: { access: 'AK', securitytoken: 'ST' } }
  assert.equal(parseCodeArtsTicketResponse(partial), null)
  assert.equal(parseCodeArtsTicketResponse({ credential: { access: 'AK', secret: 'SK' } }), null)
  assert.equal(parseCodeArtsTicketResponse({ result: { accessKeyId: 'AK', secretAccessKey: 'SK' } }), null)
})

test('未就绪 / 非对象载荷返回 null（而不是抛错）', () => {
  for (const body of [{}, { code: 0, message: 'waiting' }, null, 'html', [], 42]) {
    assert.equal(parseCodeArtsTicketResponse(body), null, `应判未就绪：${JSON.stringify(body)}`)
  }
})

test('服务端把标识符下发成数字时也能读（readString 的兼容分支）', () => {
  const material = parseCodeArtsTicketResponse({
    credential: { access: 'AK', secret: 'SK', securitytoken: 'ST' },
    user_id: 12345,
  })
  assert.equal(material?.user_id, '12345')
})

// ─────────────────── ③ 显式错误判据 ───────────────────

test('⚠️ 显式业务错误必须能识别为终态（参考实现会白轮询 120 次）', () => {
  const cases: unknown[] = [
    { error_code: 'APIG.0301', error_msg: 'verify ak sk signature fail' },
    { error: 'invalid_grant', error_description: 'secret 无效' },
    { code: 401, message: 'unauthorized' },
    { success: false, message: 'ticket 已失效' },
  ]
  for (const body of cases) {
    const failure = readCodeArtsTicketError(body)
    assert.notEqual(failure, undefined, `应识别为错误：${JSON.stringify(body)}`)
    assert.equal(failure?.transient, false, `应判终态：${JSON.stringify(body)}`)
  }
})

test('5xx / 429 判为**瞬时**（继续轮询，不立刻判死）', () => {
  assert.equal(readCodeArtsTicketError({ code: 503, message: 'busy' })?.transient, true)
  assert.equal(readCodeArtsTicketError({ code: 429, message: 'slow down' })?.transient, true)
})

test('成功信封（code=0/200）不算错误', () => {
  assert.equal(readCodeArtsTicketError({ code: 0, message: 'ok' }), undefined)
  assert.equal(readCodeArtsTicketError({ code: 200 }), undefined)
  assert.equal(readCodeArtsTicketError({}), undefined)
})

// ─────────────────── ④ 单次请求（fetchCodeArtsTicket） ───────────────────

test('单次请求：URL 与三个头必须与参考实现一致，成功后回 ready', async () => {
  const mock = mockFetcher([() => jsonResponse(SHAPE_CREDENTIAL)])
  const outcome = await fetchCodeArtsTicket('ticket-1', 'secret-1', { fetcher: mock.fetcher })
  assert.equal(outcome.status, 'ready')

  const call = mock.calls[0]
  assert.notEqual(call, undefined)
  assert.ok(call.url.startsWith(`${CODEARTS_TICKET_ENDPOINT}?ticket_id=ticket-1&secret=secret-1`), call.url)
  assert.equal(call.method, 'GET')
  assert.equal(call.headers.get('plugin-name'), CODEARTS_LOGIN_PLUGIN_NAME)
  assert.equal(call.headers.get('plugin-version'), CODEARTS_LOGIN_PLUGIN_VERSION)
  assert.equal(call.headers.get('content-type'), 'application/json;charset=UTF-8')
})

test('⚠️ ticket_id / secret 必须 URL 编码（否则含特殊字符就换不到凭据）', async () => {
  const mock = mockFetcher([() => jsonResponse(SHAPE_CREDENTIAL)])
  await fetchCodeArtsTicket('a b&c', 'x?y=z', { fetcher: mock.fetcher })
  const url = mock.calls[0]?.url ?? ''
  assert.ok(url.includes(`ticket_id=${encodeURIComponent('a b&c')}`), url)
  assert.ok(url.includes(`secret=${encodeURIComponent('x?y=z')}`), url)
})

test('单次请求：200 + 载荷里还没有凭据 → pending', async () => {
  const mock = mockFetcher([() => jsonResponse({ code: 0, message: 'waiting' })])
  assert.equal((await fetchCodeArtsTicket('t', 's', { fetcher: mock.fetcher })).status, 'pending')
})

test('单次请求：非 JSON 响应体 → pending（不抛错、不静默成功）', async () => {
  // 依据 login.ts:106-108：JSON 解析失败时 continue（网关会回 HTML 错误页）
  const mock = mockFetcher([() => new Response('<html>502 Bad Gateway</html>', { status: 502 })])
  assert.equal((await fetchCodeArtsTicket('t', 's', { fetcher: mock.fetcher })).status, 'pending')
})

test('单次请求：网络失败 → pending（瞬时，不当成终态）', async () => {
  const mock = mockFetcher([() => { throw new Error('network down') }])
  assert.equal((await fetchCodeArtsTicket('t', 's', { fetcher: mock.fetcher })).status, 'pending')
})

test('单次请求：HTTP 4xx 但**没有**错误体 → 仍判 pending（ticket 可能尚未创建）', async () => {
  // ⚠️ 不能把 4xx 一律判死：ticket 尚未创建时端点很可能就回 404
  //（与 Qoder 设备码轮询同一形态，见 providers/qoder.ts:1523-1526）。
  const mock = mockFetcher([() => new Response('', { status: 404 })])
  assert.equal((await fetchCodeArtsTicket('t', 's', { fetcher: mock.fetcher })).status, 'pending')
})

test('⚠️ 单次请求：显式业务错误 → 抛 ProviderError（带服务端原文，不静默）', async () => {
  const mock = mockFetcher([() => jsonResponse({ error_code: 'APIG.0301', error_msg: 'ticket not found' })])
  await assert.rejects(
    () => fetchCodeArtsTicket('t', 's', { fetcher: mock.fetcher }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError, '必须是 ProviderError（面板按它显示原因）')
      assert.match(error.message, /APIG\.0301/, '错误码要带出来')
      assert.match(error.message, /ticket not found/, '服务端原文要带出来')
      assert.equal(error.retryable, false, '明确被拒 ⇒ 不可重试')
      return true
    },
  )
})

// ─────────────────── ⑤ 轮询循环（pollCodeArtsTicket） ───────────────────

test('轮询：第一次 pending、第二次成功（只打两次，且中间等待了 gap）', async () => {
  const mock = mockFetcher([
    () => jsonResponse({}),
    () => jsonResponse(SHAPE_CREDENTIAL),
  ])
  const sleeps: number[] = []
  const material = await pollCodeArtsTicket('t', 's', {
    fetcher: mock.fetcher,
    maxAttempts: 5,
    gapMs: 1000,
    sleep: async (ms) => { sleeps.push(ms) },
  })
  assert.equal(material.security_token, 'TOKENEXAMPLE')
  assert.equal(mock.count(), 2, '第一次未就绪，第二次成功')
  assert.deepEqual(sleeps, [1000], '只在两次尝试之间等待（首次不等待）')
})

test('轮询：非 JSON 响应被跳过，之后成功（证明它不致命）', async () => {
  const mock = mockFetcher([
    () => new Response('<html>oops</html>', { status: 200 }),
    () => jsonResponse(SHAPE_CREDENTIAL),
  ])
  const material = await pollCodeArtsTicket('t', 's', {
    fetcher: mock.fetcher,
    maxAttempts: 3,
    gapMs: 0,
    sleep: async () => {},
  })
  assert.equal(material.access_key_id, 'AKEXAMPLE')
  assert.equal(mock.count(), 2)
})

test('⚠️ 轮询：终态错误立刻抛出（**不**陪跑满 maxAttempts）', async () => {
  const mock = mockFetcher([() => jsonResponse({ error_code: 'STS5.1806', error_msg: 'secret has been used' })])
  await assert.rejects(
    () => pollCodeArtsTicket('t', 's', { fetcher: mock.fetcher, maxAttempts: 120, gapMs: 0, sleep: async () => {} }),
    /secret has been used/,
  )
  assert.equal(mock.count(), 1, '终态错误只应打一次（否则白烧 120 个请求）')
})

test('轮询：一直 pending 到次数耗尽 → 抛超时（可重试，提示重新发起）', async () => {
  const mock = mockFetcher([() => jsonResponse({})])
  await assert.rejects(
    () => pollCodeArtsTicket('t', 's', { fetcher: mock.fetcher, maxAttempts: 3, gapMs: 0, sleep: async () => {} }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.equal(error.retryable, true)
      assert.match(error.message, /超时/)
      return true
    },
  )
  assert.equal(mock.count(), 3, '次数用尽即停（默认 120 与参考实现同口径）')
})

// ─────────────────── ⑥ 回灌 parseCredential（落盘形状一致性） ───────────────────

test('⚠️ ticket 材料回灌 parseCredential：security_token 进 accessToken，AK/SK 进 extras', () => {
  const material = parseCodeArtsTicketResponse(SHAPE_CREDENTIAL) as CodeArtsTicketMaterial
  const credential = codeArtsTicketCredentialToProvider(material)

  assert.equal(credential.provider, 'codearts')
  assert.equal(credential.accessToken, 'TOKENEXAMPLE', 'accessToken 装的是 security_token（本项目的既定口径）')
  assert.equal(credential.extras['ak'], 'AKEXAMPLE')
  assert.equal(credential.extras['sk'], 'SKEXAMPLE')
  assert.equal(credential.uid, 'user-1', 'uid 优先取服务端下发的 user_id')
  assert.equal(credential.nickname, '张三')
  assert.equal(credential.expiresAt, Date.parse('2030-01-01T00:00:00Z'), 'ISO 过期时间要解析成毫秒')
  assert.equal(credential.refreshToken, '', 'ticket 响应没有 refresh_token ⇒ 不可续期（已知代价）')
  // 关键：把**同一份材料**（也就是用户手工粘贴时会贴的那段扁平 JSON）
  // 走一遍导入路径的解析器，结果必须逐字段相同 —— 否则「登录进来」与
  // 「粘贴导入」会落成两条账号记录（或同一份凭据一个判过期、一个不判）。
  assert.deepEqual(
    findProvider('codearts')?.parseCredential({
      access_key_id: material.access_key_id,
      secret_access_key: material.secret_access_key,
      security_token: material.security_token,
      expires_at: material.expires_at,
      domain_id: material.domain_id,
      user_id: material.user_id,
      user_name: material.user_name,
    }),
    credential,
    '登录与导入必须落到同一份凭据形状',
  )
})

test('⚠️ 缺 AK/SK/security_token 时回灌解析必须**抛错**（不产出永远 401 的凭据）', () => {
  for (const broken of [
    { access_key_id: '', secret_access_key: 'SK', security_token: 'ST' },
    { access_key_id: 'AK', secret_access_key: '', security_token: 'ST' },
    { access_key_id: 'AK', secret_access_key: 'SK', security_token: '' },
  ]) {
    assert.throws(
      () => codeArtsTicketCredentialToProvider({
        ...broken,
        expires_at: '',
        domain_id: '',
        user_id: '',
        user_name: '',
      } as CodeArtsTicketMaterial),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError, '应为 ProviderError（缺什么要说清楚）')
        assert.match(error.message, /缺/)
        return true
      },
    )
  }
})

test('uid 兜底：没有 user_id / domain_id 时落到 AK（重登不会变成新账号）', () => {
  const material = parseCodeArtsTicketResponse({
    result: { accessKeyId: 'AK-STABLE', secretAccessKey: 'SK', securityToken: 'ST' },
  }) as CodeArtsTicketMaterial
  const credential = codeArtsTicketCredentialToProvider(material)
  assert.equal(credential.uid, 'ak:AK-STABLE', 'AK 长期不变，是唯一稳定的账号标识')
  assert.equal(credential.expiresAt, 0, '没有过期时间就给 0（未知），不编造')
})

test('⚠️ 服务端万一同时下发续期材料，必须透传（否则可续期的账号被当成不可续期）', () => {
  const material = parseCodeArtsTicketResponse({
    credential: { access: 'AK', secret: 'SK', securitytoken: 'ST' },
    refresh_token: 'RT',
    code_verifier: 'CV',
    dpop_private_key_jwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' }),
  }) as CodeArtsTicketMaterial
  const credential = codeArtsTicketCredentialToProvider(material)
  assert.equal(credential.refreshToken, 'RT')
  assert.equal(credential.extras['codeVerifier'], 'CV')
  assert.ok((credential.extras['dpopPrivateKeyJwk'] ?? '').includes('P-256'))
})

// ─────────────────── ⑦ 能力声明 ───────────────────

test('⚠️ codearts 现在声明 login=true（浏览器回跳流程已实现）', () => {
  const provider = findProvider('codearts')
  assert.equal(provider?.capabilities.login, true)
  // 声明能登录就**必须**真的有可用的登录原语（避免「声明了却做不到」）
  assert.equal(typeof buildCodeArtsLoginUrl, 'function')
  assert.equal(typeof fetchCodeArtsTicket, 'function')
})

// ─────────────────── 登录入口 host（用户报障「一直显示登录中」） ───────────────────

test('⚠️ 华为登录入口 host 不得带区域前缀（带区域的 API 已下线）', () => {
  // 实测 2026-10-04：参考实现用的
  // `devcloud.cn-north-4.huaweicloud.com/doer/redirect` 已返回
  //   404 {"error_code":"APIGW.0101",
  //        "error_msg":"The API does not exist or has not been published in the environment"}
  // 而**去掉区域前缀**的 `devcloud.huaweicloud.com` 返回 200 + 跳转脚本。
  //
  // 这正是用户报障「华为登录之后一直显示登录中…」的根因：
  // 他点开的授权页是 **404 错误页**，根本没有登录框，
  // 浏览器永远不会回跳到我们的 callback，面板只能一直等。
  assert.equal(CODEARTS_LOGIN_BASE, 'https://devcloud.huaweicloud.com/doer/redirect')
  assert.ok(!CODEARTS_LOGIN_BASE.includes('cn-north-4'), '不得带区域前缀')
})

test('⚠️ 认证页路径是 /authui/login（无 .html）—— 那是跳转脚本自己拼的目标', () => {
  // `doer/redirect` 的响应体里明写：
  //   window.location.replace('https://auth.huaweicloud.com/authui/login?service=' + …)
  assert.equal(HUAWEI_AUTH_BASE, 'https://auth.huaweicloud.com/authui/login')
})

test('⚠️ 登录 URL 必须把我们的 callback 原样带上', () => {
  const callbackUrl = 'https://example.com/login/codearts/callback/abc123'
  const { redirectUrl, loginUrl } = buildCodeArtsLoginUrl(callbackUrl, 'ticket-1')
  // redirectUrl 里的 auth_callback_url 必须是我们给的（编码后）
  assert.ok(redirectUrl.includes(encodeURIComponent(callbackUrl)), 'auth_callback_url 必须原样带上')
  assert.ok(redirectUrl.includes('ticket_id=ticket-1'), 'ticket_id 必须在')
  // loginUrl 必须把整个 redirectUrl 作为 service 参数
  assert.ok(loginUrl.startsWith(`${HUAWEI_AUTH_BASE}?service=`), 'service 必须指向 redirectUrl')
  assert.ok(loginUrl.includes(encodeURIComponent(redirectUrl)), 'redirectUrl 必须整体编码进 service')
})
