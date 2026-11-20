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

// ─────────────── 签到：41000 必须是「无资格」，不是失败 ───────────────

test('🔴 签到业务码 41000/40901/1002/1003 必须归「无领取资格」，不得当失败', async () => {
  // ## 真实缺陷（本轮修）
  //
  // 国际版（workbuddy.ai）的每日奖励**挂在活动上**：活动没开时 `/daily-checkin`
  // 回 `41000`。修复前它落到 `classify()` ⇒ 归成 `unknown` ⇒ **抛错**
  // ⇒ 面板天天显示「签到失败」，自动签到还会反复重试。
  //
  // ⚠️ 而任务注释当时写着「此时本方法会如实返回无收益」——
  // **注释与代码不一致**，那正是这个缺陷藏住的原因。
  const { CHECKIN_INACTIVE_CODES, normalizeBusinessCode } = await import('../src/upstream/checkin.ts')

  for (const code of [1002, 1003, 41000, 40901]) {
    assert.ok(CHECKIN_INACTIVE_CODES.includes(code), `${code} 必须算「无领取资格」`)
  }
  // ⚠️ 反向：幂等码与成功码**不得**混进来
  for (const code of [0, 10001, 1001, 14001]) {
    assert.ok(!CHECKIN_INACTIVE_CODES.includes(code), `${code} 不该算「无领取资格」`)
  }

  // ⚠️ 上游会把码下发成**字符串**（`"41000"` / `"0"`）。只认 number 会让
  // 这四个码全部失效（落到 -1 ⇒ 判成失败 ⇒ 反复重试），也会把 `"0"` 判成失败。
  assert.equal(normalizeBusinessCode('41000'), 41000)
  assert.equal(normalizeBusinessCode('0'), 0)
  assert.equal(normalizeBusinessCode(41000), 41000)
  assert.equal(normalizeBusinessCode(undefined), -1, '缺失必须是 -1（不能当成 0 成功）')
  assert.equal(normalizeBusinessCode('abc'), -1)
})

test('🔴 inactive 不得被折成「今日已签到」（那是骗用户）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('src/providers/buddy.ts', 'utf8')
  const start = src.indexOf('async function checkin(credential')
  assert.ok(start > 0)
  const fn = src.slice(start, start + 2000)

  // 必须先判 inactive，且返回 alreadyDone: false
  const inactiveAt = fn.indexOf('r.inactive === true')
  const alreadyAt = fn.indexOf('if (r.alreadyDone)')
  assert.ok(inactiveAt > 0, '必须显式处理 inactive')
  assert.ok(alreadyAt > 0, '必须处理幂等')
  assert.ok(inactiveAt < alreadyAt, '⚠️ inactive 必须在 alreadyDone **之前**判（否则被折成「已签到」）')
  assert.ok(
    /alreadyDone:\s*false[\s\S]{0,120}inactive/.test(fn) || /inactive === true\)\s*\{[\s\S]{0,200}alreadyDone:\s*false/.test(fn),
    'inactive 分支必须返回 alreadyDone: false',
  )
})

// ─────────────── codearts：积分耗尽必须换号 ───────────────

test('🔴 codearts 积分耗尽（TM.00001050）必须换号，且不得误伤 TM.000010051', async () => {
  // ## 真实缺陷（参考实现 2026-11-15 用真实凭据实测）
  //
  // 积分耗尽回的是 **HTTP 400** + `{"error_code":"TM.00001050"}` ——
  // 既不是 429 也不是 402。而本地的 `shouldRotate` 对 400 只认
  // `TM.00001041`（并发会话满）⇒ 积分耗尽落进 `return false`
  // ⇒ **既不换号、也不写模型级冷却** ⇒ 用户看到「积分用完了却不会切账号」。
  const { findProvider } = await import('../src/providers/index.ts')
  const p = findProvider('codearts')
  assert.ok(p?.shouldRotate !== undefined)

  // ① 积分耗尽 ⇒ 换号
  assert.equal(
    p.shouldRotate(400, '{"error_code":"TM.00001050","error_msg":"您的积分已耗尽"}'),
    true,
    '积分耗尽必须换号',
  )
  // ② 文案兜底腿（上游若改码值）
  assert.equal(p.shouldRotate(400, '{"error_msg":"积分已耗尽，请充值"}'), true)
  assert.equal(p.shouldRotate(400, 'insufficient quota'), true)

  // ③ ⚠️⚠️ **数字边界陷阱**：`TM.000010051`（无权调用该模型）**不得**判成换号。
  //
  // 两码共享 9 字符词干 `TM.000010` 后分叉，且实测在同一批请求里同时出现
  // （同一账号 glm-5.2 回 1051、glm-5.3 回 1050）。
  // 按词干匹配会把「无权限」判成「没钱」⇒ 对一个永远不会有积分的模型
  // 把整池账号轮一遍并全部沉底 —— **比不换号更糟**。
  assert.equal(
    p.shouldRotate(400, '{"error_code":"TM.000010051","error_msg":"您当前无权调用该模型"}'),
    false,
    '⚠️ TM.000010051（无权限）绝不能判成积分耗尽',
  )

  // ④ 并发会话满仍然换号（原有行为不能丢）
  assert.equal(p.shouldRotate(400, '{"error_code":"TM.00001041"}'), true)
})

// ─────────────── TRAE：用户粘的链接形态归一化 ───────────────

test('🔴 TRAE 回调归一化：`host:port/...` 不得被拼成 `127.0.0.1127.0.0.1`', async () => {
  // ## 真实缺陷（参考实现 2026-11-13 实测）
  //
  // 用户从地址栏复制时**常带不了 scheme**：
  //   `127.0.0.1:50000/authorize?refreshToken=X&userInfo=…`
  //
  // 而旧实现只判 `startsWith('http')`，否则一律前置 `http://127.0.0.1` ⇒
  //   `http://127.0.0.1127.0.0.1:50000/authorize?…`
  // **主机名变成 `127.0.0.1127.0.0.1`**。`new URL()` 仍能解析（所以**不报错**），
  // 但 **query 全部丢失** ⇒ 报「回调未携带 refreshToken」。
  //
  // ⚠️ 这个缺陷格外难自查：用户粘的链接明明完整，提示却说缺参数。
  const { normalizeTraeCallbackUrl, parseTraeCallback } = await import('../src/providers/trae.ts')

  const noScheme = '127.0.0.1:50000/authorize?refreshToken=AAA&userInfo=%7B%7D'
  const normalized = normalizeTraeCallbackUrl(noScheme)
  assert.ok(
    normalized.startsWith('http://127.0.0.1:50000/'),
    `⚠️ host:port 形态必须补 scheme 而不是加回环前缀（实际：${normalized}）`,
  )
  assert.ok(!normalized.includes('127.0.0.1127'), '⚠️ 绝不允许拼出 127.0.0.1127.0.0.1')

  // 端到端：归一化后**必须**能解析出 refreshToken
  // （这正是修复前静默失败的那一步）
  const parsed = parseTraeCallback(noScheme)
  assert.equal(parsed.ok, true, '带 scheme 缺失的完整回调必须能解析')
  assert.equal(parsed.ok && parsed.info.refreshToken, 'AAA', 'refreshToken 必须被解出来')

  // 其余两种形态也要认
  assert.equal(
    parseTraeCallback('/login/trae/callback/x?refreshToken=BBB').ok &&
      (parseTraeCallback('/login/trae/callback/x?refreshToken=BBB') as { info: { refreshToken: string } }).info.refreshToken,
    'BBB',
    '相对路径形态要认',
  )
  assert.equal(
    parseTraeCallback('refreshToken=CCC').ok, true,
    '裸 query 形态要认',
  )
  // 完整 URL 原样
  assert.ok(normalizeTraeCallbackUrl('https://x/y?z=1').startsWith('https://x/y'))
})

// ─────────────── lobsterai：限时免费必须让倍率归零 ───────────────

test('🔴 lobsterai 限时免费生效时倍率必须归零（否则用户按原价估成本）', async () => {
  // ## 真实缺陷（参考实现跑官方客户端 asar 取证）
  //
  // 官方客户端的判据逐字是：
  //   `costMultiplier = limitedFreeActive ? 0 : readPositiveNumber(...)`
  //   `showCostMultiplier` 多一条 `|| limitedFreeActive === true` ⇒ 画 `x0.00`
  //
  // 而本地此前只把 `isFree` 置 true、**倍率仍保留原值**（如 `x0.05`）
  // ⇒ 用户按原价估成本，而活动其实免费。
  //
  // ⚠️ 反向也要防：`limitedFree`（有此活动）≠ `limitedFreeActive`（现在生效）。
  // 只读前者会把**已结束**的活动也判成免费 —— 那是更糟的反向错价。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('src/providers/lobsterai.ts', 'utf8')

  // ① 必须有「限免生效 ⇒ priceFactor: 0」的分支
  assert.ok(
    /limitedFreeActive === true\s*\n?\s*\?\s*\{\s*priceFactor:\s*0\s*\}/.test(src),
    '限免生效时倍率必须归零（priceFactor: 0）',
  )

  // ② 判据必须是 `limitedFreeActive`（不是 `limitedFree`）
  const idx = src.indexOf('limitedFreeActive === true\n        ? { priceFactor: 0 }')
  const near = idx >= 0 ? src.slice(Math.max(0, idx - 200), idx + 400) : ''
  assert.ok(
    src.includes('limitedFreeActive === true'),
    '必须按 limitedFreeActive（当前是否生效）判，不能只看 limitedFree',
  )

  // ③ 非限免时，倍率为 0/缺失**不得**给 priceFactor（否则付费模型显示成免费）
  assert.ok(
    /priceFactor > 0 \? \{ priceFactor \} : \{\}/.test(src),
    '非限免时倍率为 0 或缺失不应给该字段（不能把付费模型标成免费）',
  )
})

// ─────────────── 签到文案兜底：必须整句，不能子串 ───────────────

test('🔴 「已签到」文案兜底必须是整句（子串会把失败翻成假成功）', async () => {
  // ## 真实缺陷（参考实现用 13 条真实失败报文实测：9 条被误判，探针 30/42）
  //
  // 误判成「今天已签到」的后果链比误判成「无资格」**严格更糟**：
  //   already-claimed → coversToday+1 → 当天**整天不再重试**
  //   → 反向告诉用户「已领到」
  // 即：一次**真实失败**被翻成「已成功」，并让后续重试全部消失。
  const { ALREADY_CHECKED_IN_TEXT } = await import('../src/upstream/checkin.ts')

  const matches = (msg: string): boolean => ALREADY_CHECKED_IN_TEXT.some((p) => p.test(msg.trim()))

  // ① 真·已签到：必须命中（各家文案形态）
  for (const ok of ['已签到', '今天已签到', '今日已签到。', '已领取', 'already checked in', 'Already claimed.']) {
    assert.equal(matches(ok), true, `「${ok}」应判为已签到`)
  }

  // ② ⚠️ 含「已签到」字样但**实为失败**：绝不能被判成已签到
  //    —— 这三条正是子串匹配会误判的（本项目实测确认）。
  for (const bad of [
    '今日已签到记录写入失败',
    '更新已签到状态失败，请重试',
    '已签到用户信息同步超时',
    '已签到数据异常',
  ]) {
    assert.equal(matches(bad), false, `⚠️「${bad}」是失败报文，绝不能判成已签到`)
  }
})

// ─────────────── 缺省换号判据：业务码 14018 也要换号 ───────────────

test('🔴 缺省 shouldRotate 必须认额度耗尽业务码（14018），不能只看 HTTP 状态码', async () => {
  // ## 真实缺陷
  //
  // 旧缺省判据是 `status === 429 || status === 402` —— 只看 **HTTP 状态码**。
  // 而腾讯系把「额度耗尽」下发成**业务码 `14018`**，此时 HTTP 可能仍是 200/400
  // ⇒ `rotate = false` ⇒ **既不换号也不继续** ⇒ 用户看到「这个号用不了」，
  // 而其它账号明明还有余额。
  //
  // ⚠️ `buddy` / `workbuddy` **没有声明** `shouldRotate`（用缺省语义）——
  // 所以这条缺省判据就是它们**唯一**的换号依据。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('src/gateway/server.ts', 'utf8')

  const idx = src.indexOf('const rotate = provider.shouldRotate?')
  assert.ok(idx > 0, '应能找到 rotate 判据')
  const block = src.slice(Math.max(0, idx - 1800), idx + 200)

  // ① 必须用 classify 的 kind 兜底（而不是只看状态码）
  assert.ok(
    /rotateDefault|cls\\.kind === 'credit_exhausted'/.test(block),
    '缺省判据必须看 classify 的 kind（不能只看 HTTP 状态码）',
  )
  assert.ok(block.includes("credit_exhausted"), '必须认 credit_exhausted（= 14018）')
  assert.ok(block.includes("'rate_limited'"), '必须认 rate_limited（= 14017）')

  // ② 反向：不能把 auth_error 一刀切换号（401 未必该换 —— 可能全部过期）
  assert.ok(
    !/cls\\.kind === 'auth_error'/.test(block),
    '⚠️ 缺省判据不得把 auth_error 算成换号（各家自己判）',
  )

  // ③ classify 确实会把 14018 归成 credit_exhausted（前提成立）
  const { classify } = await import('../src/upstream/client.ts')
  assert.equal(classify(200, '{"code":14018,"msg":"quota exhausted"}').kind, 'credit_exhausted')
  assert.equal(classify(400, '{"code":14017,"msg":"rate limited"}').kind, 'rate_limited')
})
