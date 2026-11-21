/**
 * HTTP 响应助手（OpenAI 兼容形状）。
 *
 * 单独一个文件是为了避免**循环 import**：`server.ts` 需要 `jsonError`，
 * 而 `models.ts` 也需要它 —— 若放在 `server.ts` 里就会形成环。
 */

/** JSON 响应。 */
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** JSON 错误响应（OpenAI 兼容形状：`{error:{message,type,code}}`）。 */
export function jsonError(status: number, message: string, code: string): Response {
  return new Response(JSON.stringify({ error: { message, type: code, code } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * 解析标准 `Retry-After` 头 → 毫秒。
 *
 * ## 为什么放在共享层而不是某个 provider 里
 *
 * 它是 **HTTP 标准头**，与任何供应商无关。原先它只存在于 `opencode.ts`，
 * 而**别处也需要**（网关的模型级冷却要据此对齐上游墙钟）。
 * 放在 provider 里会逼着网关去 import 一个供应商模块 —— 层次颠倒。
 *
 * ## ⚠️ 只放行**纯数字**秒数
 *
 * `Date.parse('900')` 会得到 1970 年的时刻，算出巨大负数，
 * 再被 `Math.max(0, …)` 夹成 0 ⇒ 刚被限流的账号**马上又被选中**，
 * 形成无限空转。故先判纯数字，再退回 `Date` 解析（HTTP-date 形式）。
 */
export function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get('retry-after')
  if (raw === undefined || raw === null || raw === '') return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

/**
 * 读请求体为 JSON，并**强制请求体上限**。
 *
 * ## 为什么必须显式设上限（真实风险）
 *
 * `await request.json()` 会**完整读入并解析**整个体。对超大请求体：
 * - 免费档 Workers 的内存是 128 MB，超大体会在解析时被平台掐断；
 * - CPU 只计「实际执行」的时间，而 JSON 解析是**纯 CPU** ——
 *   一个几十 MB 的体会直接撞爆 10ms 预算；
 * - 更糟的是**报错形态**：平台给出的错误与本服务语义无关，用户看到的是
 *   一个莫名其妙的 500/1101，完全看不出是「body 太大」。
 *
 * ⇒ 在**读之前**用 `content-length` 拦一道（廉价、零 CPU），
 * 再在**读之后**用实际字节数兜一道（有些客户端不发/谎报 `content-length`，
 * 也可能是 chunked 编码）。
 *
 * ## ⚠️ 为什么不用 `request.body` 流式计数
 *
 * 那需要自己实现流式 JSON 解析（或先落盘到 buffer），复杂度远高于收益：
 * 免费档的请求体本来就不可能很大，`text()` + 一次字节数检查已经足够，
 * 且 `text()` 的真实内存成本被上限**提前**约束住了 —— 因为 `content-length`
 * 那道会在绝大多数情况下先生效。
 *
 * @param limit 字节上限；`0` = 不限制（`MAX_REQUEST_BYTES=0` 的合法配置）
 * @returns 解析结果，或一个**可直接返回**的错误响应（调用方 `return result.response`）
 */
export async function readJsonCapped(
  request: Request,
  limit: number,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (limit > 0) {
    const declared = request.headers.get('content-length')
    if (declared !== null && /^\d+$/.test(declared.trim())) {
      const declaredBytes = Number.parseInt(declared.trim(), 10)
      if (Number.isSafeInteger(declaredBytes) && declaredBytes > limit) {
        return { ok: false, response: bodyTooLarge(limit, declaredBytes) }
      }
    }
  }

  let text: string
  try {
    text = await request.text()
  } catch {
    return {
      ok: false,
      response: jsonError(400, '无法读取请求体（连接中断或编码异常）', 'invalid_request_error'),
    }
  }

  // ⚠️ 用**实际字节数**复查（`content-length` 可能缺失/谎报/chunked）。
  // `TextEncoder` 的字节数才是真正占用内存的量 —— `text.length` 是 UTF-16 码元数，
  // 对中文会**低估**三分之一。
  const actualBytes = new TextEncoder().encode(text).length
  if (limit > 0 && actualBytes > limit) {
    return { ok: false, response: bodyTooLarge(limit, actualBytes) }
  }

  if (text.trim() === '') {
    return { ok: false, response: jsonError(400, '请求体不能为空', 'invalid_request_error') }
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return {
      ok: false,
      response: jsonError(400, '请求体必须是合法 JSON', 'invalid_request_error'),
    }
  }
}

/**
 * 413 响应。
 *
 * ⚠️ 文案必须同时给出**三个**信息：实际多大、上限多少、**怎么改**。
 * 只说「请求体过大」的话，用户既不知道差多少，也不知道该调哪个环境变量。
 */
export function bodyTooLarge(limit: number, actual: number): Response {
  const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(2)} MiB`
  return jsonError(
    413,
    `请求体过大：${mb(actual)}（上限 ${mb(limit)}）。`
      + '如需更大，请设置环境变量 MAX_REQUEST_BYTES（单位是**字节**），或用更小的图片/更短的上下文。',
    'request_too_large',
  )
}
