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

// ─────────────── 面板：输入框不能被轮询刷掉（真实缺陷） ───────────────

test('🔴 轮询不得用 textContent 清空登录提示节点（否则输入框会消失）', async () => {
  // ## 用户报障（2026-11-21）
  //
  // > 「这些回调都有问题吧，我刚登录好连接就刷新了，输入框也莫名其妙消失了，
  // >   你这人我怎么登录」
  //
  // ## 根因
  //
  // `renderLoginPrompt` 的 **authUrl 分支**用
  // `el.textContent = '…'` 铺正文，然后在其后 append 链接与
  // 「粘贴回调链接」输入框。而它**从未设置 `el._loginStatus`**。
  //
  // 于是 3 秒后第一次轮询走进兜底分支 `else out.textContent = …`
  // —— `textContent` 赋值**会清空该节点的全部子元素** ⇒ 链接、输入框、
  // 提交按钮一起消失，只剩一行「等待授权中…」。
  //
  // 而那个输入框恰恰是这条登录流程**唯一**能完成的方式 ⇒ 用户彻底卡死。
  const { readFileSync } = await import('node:fs')
  const raw = readFileSync('src/panel/assets/app.js.txt', 'utf8')

  // ① 定位 `renderLoginPrompt` 的**完整函数体**。
  //
  // ⚠️ 不能用 `indexOf('\n}', start)` 找结尾 —— 函数里有嵌套块，
  // 那样会**提前截断**，断言变成「只检查了前半段」的假绿。
  // 改用「下一个顶层声明」作边界。
  const start = raw.indexOf('function renderLoginPrompt')
  assert.ok(start >= 0, '应有 renderLoginPrompt')
  const endCandidates = [
    raw.indexOf('const MANUAL_CALLBACK_PROVIDERS', start),
    raw.indexOf('const MANUAL_CALLBACK_HINTS', start),
    raw.indexOf('function renderManualCallbackInput', start),
  ].filter((i) => i > 0)
  assert.ok(endCandidates.length > 0, '应能找到 renderLoginPrompt 之后的顶层声明')
  const body = raw.slice(start, Math.min(...endCandidates))

  // ② ⚠️ **必须先剥注释**：本项目的注释习惯是逐字引用缺陷代码
  //（这里就有 `el.textContent = …` 的原文），不剥会产生假失败/假绿。
  // 与 `gateway.test.ts` / `panel.test.ts` 的 `stripComments` 同一口径。
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  // ③ 🔴 函数体内**不得**给 `el.textContent` 赋值 —— 唯一例外是
  //    「服务端没返回任何登录方式」那个**终态**分支（它之后不会再有轮询）。
  const assignments = [...code.matchAll(/\bel\.textContent\s*\+?=\s*([^\n]*)/g)]
    .map((m) => m[0].trim())
    .filter((line) => !line.includes('服务端未返回可用的登录方式'))
  assert.deepEqual(
    assignments,
    [],
    '⚠️ renderLoginPrompt 里不得给 el.textContent 赋值 —— 它会在下一次轮询时'
      + '清空整个节点（链接与输入框一起消失）。改用独立的状态节点 + el._loginStatus',
  )

  // ③ 而 link 分支**必须**设置 `_loginStatus`（漏了就落进兜底分支）
  assert.ok(
    body.includes('el._loginStatus = status'),
    '链接分支必须设置 el._loginStatus（否则轮询会走「清空节点」的兜底）',
  )
})

test('🔴 轮询兜底不得再写 textContent（找不到状态节点就地补一个）', async () => {
  const { readFileSync } = await import('node:fs')
  const js = readFileSync('src/panel/assets/app.js.txt', 'utf8')

  // 定位弹窗登录的轮询回调（`startModalLogin` 里的 setInterval）
  const start = js.indexOf('async function startModalLogin')
  assert.ok(start >= 0)
  const body = js.slice(start, start + 4000)

  // ⚠️ 兜底分支曾经写 `out.textContent = r.body.message` —— 那正是清空元凶。
  assert.ok(
    !/out\.textContent\s*=\s*r\.body\.message/.test(body),
    '轮询兜底不得用 out.textContent 覆盖整块内容（会清掉输入框）',
  )
  // 正确做法：找不到 `_loginStatus` 时**就地补一个**节点
  assert.ok(
    /out\._loginStatus\s*===\s*undefined/.test(body) && /out\.appendChild\(fallback\)/.test(body),
    '兜底应「就地补一个状态节点」，而不是覆盖整个容器',
  )
})
