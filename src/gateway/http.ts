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
