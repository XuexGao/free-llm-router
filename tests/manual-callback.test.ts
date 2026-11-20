/**
 * 「手动粘贴回调链接」登录：**纯函数**的回归测试。
 *
 * ## 为什么需要这一组
 *
 * 这条路径的价值全在**解析**上：回调落在用户本机端口，我们收不到，
 * 只能靠用户把地址栏粘回来。而**粘回来的 URL 形态比我们构造的乱得多**：
 * 上游会自作主张加参数、把 query 拼到 hash 后面、或者干脆回一个错误页。
 *
 * 解析写错的后果是**静默的**：用户粘了链接、什么都没发生、面板一直「等待中」——
 * 与「用户没粘」完全同形，无法归因。
 *
 * ⚠️ 这些用例**不碰网络、不碰凭据**（纯函数），故可以在任何环境下跑。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseRaccoonCallback, createRaccoonAuthorizeSession } from '../src/providers/raccoon.ts'
import { parseLobsteraiCallbackCode, createLobsteraiLoginSession } from '../src/providers/lobsterai.ts'
import { parseGeminiCallback, buildGeminiAuthUrl } from '../src/providers/gemini.ts'

// ─────────────────────── raccoon（商汤） ───────────────────────

test('raccoon 授权会话：state 必须是 64 位小写 hex（官方页面规则）', () => {
  // ⚠️ 官方页面的解析器**只认** 64 位小写 hex。用 UUID（带连字符）会让整条链接被判 null
  // —— 而症状是「点了登录没反应」，完全看不出是 state 格式问题。
  const session = createRaccoonAuthorizeSession()
  assert.match(session.state, /^[a-f0-9]{64}$/)
})

test('raccoon 授权 URL：参数名必须全在官方白名单内（多一个键整条链接作废）', () => {
  const url = new URL(createRaccoonAuthorizeSession().authorizeUrl)
  const allowed = ['login_source', 'appname', 'state', 'redirect', 'ide', 'org', 'lang', 'desktop_callback']
  for (const key of url.searchParams.keys()) {
    assert.ok(allowed.includes(key), `参数 ${key} 不在官方白名单里 —— 整条链接会被页面判 null`)
  }
  // ① redirect 必须是回环地址形态（官方正则校验）
  assert.match(url.searchParams.get('redirect') ?? '', /^http:\/\/127\.0\.0\.1:\d{4,5}\/auth\/callback$/)
  // ② desktop_callback 必须是 loopback
  assert.equal(url.searchParams.get('desktop_callback'), 'loopback')
})

test('raccoon 回调解析：参数名是 `code`（不是 authorization_code）', () => {
  // ⚠️ `authorization_code` 是**换码端点的 body 字段**，两者是两回事。
  // 把投递参数名写成它会让解析恒为空。
  const parsed = parseRaccoonCallback('http://127.0.0.1:18082/auth/callback?code=ABC&state=xyz')
  assert.equal(parsed.code, 'ABC')
  assert.equal(parsed.state, 'xyz')
  // 空链接不炸（用户点了取消/啥也没粘）
  assert.equal(parseRaccoonCallback('').code, '')
})

// ─────────────────────── lobsterai（有道） ───────────────────────

test('lobsterai 登录会话：uuid 是 UUID、URL 带 hash 段', () => {
  const session = createLobsteraiLoginSession()
  assert.match(session.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  // ⚠️ `#/login` 是 fragment，`URL.searchParams` 拼不出「路径 + hash + ?query」
  assert.ok(session.loginUrl.includes('/portal#/login?'), '登录 URL 必须保留 hash 段')
  assert.ok(session.loginUrl.includes('source=electron'), 'portal 要求 source=electron')
})

test('lobsterai 回调解析：三种形态都要认（含 hash 段里的 query）', () => {
  // ① 主形态
  assert.equal(parseLobsteraiCallbackCode('http://127.0.0.1:18081/auth/callback?authCode=XYZ'), 'XYZ')
  // ② OAuth 惯例的 `code`
  assert.equal(parseLobsteraiCallbackCode('http://x/auth/callback?code=Q'), 'Q')
  // ③ ⚠️ fragment 里的 query —— `URL.search` **看不到**它，必须手工解。
  //    这是本项目在 `state?refreshToken=…` 上踩过的同一类问题。
  assert.equal(parseLobsteraiCallbackCode('http://a/portal#/login?authCode=H1'), 'H1')
  // ④ 空输入不炸
  assert.equal(parseLobsteraiCallbackCode(''), '')
})

// ─────────────────────── gemini ───────────────────────

test('gemini 授权 URL：必须带 offline + consent（否则拿不到 refresh_token）', () => {
  const url = new URL(buildGeminiAuthUrl('ST'))
  // ⚠️ 不带 `access_type=offline` ⇒ Google **不下发** refresh_token ⇒ 账号一小时就废。
  assert.equal(url.searchParams.get('access_type'), 'offline')
  // ⚠️ 不带 `prompt=consent` ⇒ **已授权过**的用户重登时不下发新的 refresh_token
  // ⇒ 表现为「重新登录了，但续期还是失败」。
  assert.equal(url.searchParams.get('prompt'), 'consent')
  // ⚠️ 主机名必须是 localhost（不是 127.0.0.1）—— 注册值如此，换一个就 redirect_uri_mismatch
  assert.ok((url.searchParams.get('redirect_uri') ?? '').startsWith('http://localhost:'))
  assert.equal(url.searchParams.get('state'), 'ST')
})

test('gemini 回调解析：code / state / error 三态都要认', () => {
  const good = parseGeminiCallback('http://localhost:8845/oauth-callback?code=4/0A&state=S')
  assert.equal(good.code, '4/0A')
  assert.equal(good.state, 'S')
  assert.equal(good.error, '')
  // ⚠️ 用户点「取消」时回来的**没有 code**、只有 error。
  // 把这种当成「还没授权」会让面板一直等到超时（本仓库在 loomy 上踩过同型问题）。
  const denied = parseGeminiCallback('http://localhost:8845/oauth-callback?error=access_denied')
  assert.equal(denied.error, 'access_denied')
  assert.equal(denied.code, '')
})
