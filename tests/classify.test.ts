/**
 * 上游错误分类的单测。
 *
 * ## 这些用例为什么重要
 *
 * 分类错误的代价是**不对称**的（AGENTS.md §6.7）：
 * - 把「临时限流」当「账号死亡」→ 误杀健康账号；
 * - 把「WAF 拦截」当「凭据过期」→ 排查方向完全错。
 *
 * 尤其 **WAF 判据**：本项目出口验证探针**真的踩过**这个坑 ——
 * 最初把「401 无信封」也当 WAF，而实测 APISIX 对缺凭据就是回 401。
 * 下面的用例把这个边界钉死。
 *
 * 运行：`node --test --experimental-strip-types tests/classify.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classify, isWafBlocked, parseEnvelope, shouldPunish, shouldRotate } from '../src/upstream/client.ts'

/** 真实抓到的 401 HTML（APISIX / openresty）。 */
const HTML_401 =
  '<html>\r\n<head><title>401 Authorization Required</title></head>\r\n<body>\r\n<center><h1>401 Authorization Required</h1></center>\r\n<hr><center>openresty</center>\r\n</body>\r\n</html>\r\n'

/** 真实的 WAF 403 拦截页形态。 */
const HTML_403 = '<html>\r\n<head><title>403 Forbidden</title></head>\r\n<body><center><h1>403 Forbidden</h1></center></body></html>'

/** 真实抓到的成功信封。 */
const OK_200 =
  '{"code":0,"msg":"OK","requestId":"30a5de2f","data":{"state":"0443bd6c","authUrl":"https://copilot.tencent.com/login"}}'

test('parseEnvelope：只认 JSON 对象里带数字 code 的形态', () => {
  assert.notEqual(parseEnvelope(OK_200), undefined)
  assert.equal(parseEnvelope(HTML_401), undefined, 'HTML 不是信封')
  assert.equal(parseEnvelope(''), undefined)
  assert.equal(parseEnvelope('[]'), undefined)
  assert.equal(parseEnvelope('{"code":"abc"}'), undefined, 'code 必须可转成数字')
  assert.notEqual(parseEnvelope('{"code":"0"}'), undefined, '字符串数字应接受')
})

test('⚠️ WAF 判据：只有「403 + 无信封」才算', () => {
  assert.equal(isWafBlocked(403, HTML_403), true)
  assert.equal(isWafBlocked(403, ''), true)
  assert.equal(isWafBlocked(403, 'Forbidden'), true)
})

test('⚠️ 401 不是 WAF —— 探针踩过的真实误判', () => {
  assert.equal(isWafBlocked(401, HTML_401), false)
  assert.equal(classify(401, HTML_401).kind, 'auth_error')
})

test('⚠️ 403 但带业务信封不是 WAF（如 11140）', () => {
  const body = '{"code":11140,"msg":"request illegal"}'
  assert.equal(isWafBlocked(403, body), false)
  assert.equal(classify(403, body).kind, 'request_illegal')
})

test('成功信封 → code 0 不被当作错误类别', () => {
  const r = classify(200, OK_200)
  assert.equal(r.code, 0)
})

test('已知业务码映射到正确类别', () => {
  const cases: Array<[number, string]> = [
    [6004, 'rate_limited'],
    [11102, 'model_unavailable'],
    [14018, 'credit_exhausted'],
    [14017, 'rate_limited'],
    [11140, 'request_illegal'],
    [12153, 'session_dead'],
    [11115, 'context_exceeded'],
    [11135, 'image_invalid'],
    [10001, 'already_done'],
    [1001, 'already_done'],
  ]
  for (const [code, kind] of cases) {
    const r = classify(200, `{"code":${code},"msg":"x"}`)
    assert.equal(r.kind, kind, `code ${code} 应映射为 ${kind}`)
  }
})

test('5xx → server（可重试且喂熔断）', () => {
  assert.equal(classify(500, 'oops').kind, 'server')
  assert.equal(classify(503, '{"code":10000,"msg":"API request failed"}').kind, 'server')
})

test('402 → credit_exhausted（硬冷却至次日 04:00）', () => {
  assert.equal(classify(402, '').kind, 'credit_exhausted')
})

test('404 → not_found（可能需换 fallback 路径）', () => {
  assert.equal(classify(404, '').kind, 'not_found')
})

test('⚠️ 参数类错误不换号（换号会重放同样的非法请求）', () => {
  assert.equal(shouldRotate('context_exceeded'), false)
  assert.equal(shouldRotate('image_invalid'), false)
  assert.equal(shouldRotate('request_illegal'), false)
  assert.equal(shouldRotate('network'), false)
})

test('限流/余额/鉴权类错误应换号', () => {
  assert.equal(shouldRotate('rate_limited'), true)
  assert.equal(shouldRotate('credit_exhausted'), true)
  assert.equal(shouldRotate('auth_error'), true)
  assert.equal(shouldRotate('session_dead'), true)
})

test('⚠️ 11115/11135 不罚号（是请求的问题，不是账号的问题）', () => {
  assert.equal(shouldPunish('context_exceeded'), false)
  assert.equal(shouldPunish('image_invalid'), false)
})

test('⚠️ 网络层错误不罚号（抖动量，不构成「这个号坏了」的证据）', () => {
  assert.equal(shouldPunish('network'), false)
  assert.equal(shouldRotate('network'), false, '网络错误也不该立刻换号 —— 可能是本地出口抖动')
})

test('应罚号：限流/余额/WAF/session 死亡/5xx', () => {
  assert.equal(shouldPunish('rate_limited'), true)
  assert.equal(shouldPunish('credit_exhausted'), true)
  assert.equal(shouldPunish('waf_blocked'), true)
  assert.equal(shouldPunish('session_dead'), true)
  assert.equal(shouldPunish('server'), true)
})

test('⚠️ auth_error 不罚号 —— 续期凭据即可，不该惩罚账号', () => {
  assert.equal(shouldPunish('auth_error'), false)
})
