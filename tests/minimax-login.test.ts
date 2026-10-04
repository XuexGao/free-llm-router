/**
 * MiniMax 设备码登录的单测（**全部走 mock fetch，零真实请求**）。
 *
 * ⚠️ 本文件绝不能打真实端点：一次真实的 token 轮询会消耗掉用户的授权机会。
 * 所有网络交互都由注入的 `fetcher` 承担。
 */
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

import { startMinimaxLogin, pollMinimaxLoginOnce } from '../src/providers/minimax.ts'

/** 造一个可控的 fetch 桩。 */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    return await handler(String(input), init ?? {})
  }) as typeof fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const DEVICE_OK = {
  device_code: 'dev-123',
  user_code: 'ABCD-1234',
  verification_uri: 'https://account.minimax.cn/device',
  verification_uri_complete: 'https://account.minimax.cn/device?user_code=ABCD-1234',
  expires_in: 300,
  interval: 5,
}

const TOKEN_OK = {
  access_token: 'mmoat_' + 'x'.repeat(54),
  refresh_token: 'mmort_' + 'y'.repeat(54),
  token_type: 'Bearer',
  scope: 'agent.default',
  expires_in: 3600,
}

test('⚠️ 设备码申请必须走 account 域，不是业务域 agent 域', async () => {
  // 两个 host 不可混用（`minimax-product.ts:127-130`）。
  // 打到 agent 域会 404 —— 而错误文案不会说明是 host 错了。
  let seen = ''
  const fetcher = stubFetch((url) => {
    seen = url
    return jsonResponse(DEVICE_OK)
  })
  const auth = await startMinimaxLogin(AbortSignal.timeout(5_000), fetcher)
  assert.ok(seen.startsWith('https://account.minimax.cn/'), `应走 account 域，实际 ${seen}`)
  assert.ok(seen.includes('/oauth2/device/code'), '路径应是 /oauth2/device/code')
  assert.equal(auth.deviceCode, 'dev-123')
  assert.equal(auth.userCode, 'ABCD-1234')
  assert.equal(auth.expiresInSec, 300)
  assert.equal(auth.intervalSec, 5)
})

test('⚠️ 设备码申请必须带 S256 PKCE（code_challenge_method=S256）', async () => {
  let body = ''
  const fetcher = stubFetch((_url, init) => {
    body = String(init.body ?? '')
    return jsonResponse(DEVICE_OK)
  })
  const auth = await startMinimaxLogin(AbortSignal.timeout(5_000), fetcher)
  const params = new URLSearchParams(body)
  assert.equal(params.get('code_challenge_method'), 'S256', '必须是 S256')
  assert.ok((params.get('code_challenge') ?? '').length > 20, 'code_challenge 不能为空')
  assert.equal(params.get('client_id'), 'mcode-public')
  assert.equal(params.get('scope'), 'agent.default')
  assert.equal(params.get('audience'), 'agent-backend')
  // ⚠️ code_verifier 必须留在返回值里（轮询时要用），但**不能**出现在申请请求里
  assert.ok(auth.codeVerifier.length > 20, 'codeVerifier 必须返回，供轮询使用')
  assert.equal(params.get('code_verifier'), null, '申请阶段不该发 code_verifier')
})

test('⚠️ `pending` 的两种形态都要认（HTTP 200+status 与 非 200+error）', async () => {
  const auth = {
    deviceCode: 'd', codeVerifier: 'v', userCode: 'u',
    verificationUri: 'x', verificationUriComplete: 'x', expiresInSec: 300, intervalSec: 5,
  }
  // 形态一：HTTP 200 + status
  const a = await pollMinimaxLoginOnce(auth, AbortSignal.timeout(5_000),
    stubFetch(() => jsonResponse({ status: 'pending' })))
  assert.equal(a.kind, 'pending', 'HTTP 200 + status=pending 应判 pending')

  // 形态二：非 200 + error（OAuth 标准）
  const b = await pollMinimaxLoginOnce(auth, AbortSignal.timeout(5_000),
    stubFetch(() => jsonResponse({ error: 'authorization_pending' }, 400)))
  assert.equal(b.kind, 'pending', '非 200 + error=authorization_pending 应判 pending')

  // ⚠️ 只看状态码会把「还在等授权」误判成「拿到令牌了」，
  // 报错是「令牌响应缺少 access_token」—— 用户还没来得及点授权就看到失败。
})

test('⚠️ slow_down 的退避是 +5 秒且累积（与 Cline 的 +1 不同）', async () => {
  const auth = {
    deviceCode: 'd', codeVerifier: 'v', userCode: 'u',
    verificationUri: 'x', verificationUriComplete: 'x', expiresInSec: 300, intervalSec: 5,
  }
  const r = await pollMinimaxLoginOnce(auth, AbortSignal.timeout(5_000),
    stubFetch(() => jsonResponse({ status: 'slow_down' })))
  assert.equal(r.kind, 'pending')
  assert.equal(r.kind === 'pending' ? r.intervalSec : 0, 10, '应是 5 + 5 = 10')

  // 非 200 + error=slow_down 同样要 +5
  const r2 = await pollMinimaxLoginOnce(auth, AbortSignal.timeout(5_000),
    stubFetch(() => jsonResponse({ error: 'slow_down' }, 400)))
  assert.equal(r2.kind === 'pending' ? r2.intervalSec : 0, 10, '两种形态都要 +5')
})

test('⚠️ 令牌校验照抄参考实现（bearer / scope 必须含 agent.default）', async () => {
  const auth = {
    deviceCode: 'd', codeVerifier: 'v', userCode: 'u',
    verificationUri: 'x', verificationUriComplete: 'x', expiresInSec: 300, intervalSec: 5,
  }
  // 正常
  const ok = await pollMinimaxLoginOnce(auth, AbortSignal.timeout(5_000),
    stubFetch(() => jsonResponse(TOKEN_OK)))
  assert.equal(ok.kind, 'success', '合法令牌应成功')

  // ⚠️ scope 不含 agent.default ⇒ `invalid_token_response`，必须判失败
  const badScope = await pollMinimaxLoginOnce(auth, AbortSignal.timeout(5_000),
    stubFetch(() => jsonResponse({ ...TOKEN_OK, scope: 'other' })))
  assert.equal(badScope.kind, 'failed', 'scope 不符必须失败')

  // ⚠️ token_type 不是 bearer ⇒ 必须失败
  const badType = await pollMinimaxLoginOnce(auth, AbortSignal.timeout(5_000),
    stubFetch(() => jsonResponse({ ...TOKEN_OK, token_type: 'mac' })))
  assert.equal(badType.kind, 'failed', 'token_type 不符必须失败')
})

test('⚠️ 用户拒绝 / 设备码过期必须判失败，不能继续等', async () => {
  const auth = {
    deviceCode: 'd', codeVerifier: 'v', userCode: 'u',
    verificationUri: 'x', verificationUriComplete: 'x', expiresInSec: 300, intervalSec: 5,
  }
  for (const [body, status] of [[{ status: 'denied' }, 200], [{ error: 'access_denied' }, 400]] as const) {
    const r = await pollMinimaxLoginOnce(auth, AbortSignal.timeout(5_000),
      stubFetch(() => jsonResponse(body, status)))
    assert.equal(r.kind, 'failed', `${JSON.stringify(body)} 应判失败`)
  }
})

test('⚠️ 网络抖动不能判终态（否则用户点授权的机会被白白放弃）', async () => {
  const auth = {
    deviceCode: 'd', codeVerifier: 'v', userCode: 'u',
    verificationUri: 'x', verificationUriComplete: 'x', expiresInSec: 300, intervalSec: 5,
  }
  const r = await pollMinimaxLoginOnce(auth, AbortSignal.timeout(5_000),
    stubFetch(() => { throw new Error('network down') }))
  assert.equal(r.kind, 'pending', '网络失败应判 pending 让面板继续轮询')
})

test('minimax 必须声明 login=true（已接线设备码登录）', async () => {
  const { minimaxProvider } = await import('../src/providers/minimax.ts')
  assert.equal(minimaxProvider.capabilities.login, true)
  assert.equal(minimaxProvider.capabilities.loginBlockedReason, undefined,
    '已接线就不该再有阻塞原因')
})

test('⚠️ 本文件必须零 `node:` 网络导入（Workers 只认 Web 标准）', () => {
  const src = readFileSync('src/providers/minimax.ts', 'utf8')
  // 只看真正的 import 语句，不看注释里提到的
  const imports = [...src.matchAll(/^import .*from '([^']+)'/gm)].map((m) => m[1] ?? '')
  for (const spec of imports) {
    assert.ok(!spec.startsWith('node:'), `不得导入 ${spec}`)
  }
})
