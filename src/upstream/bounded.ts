/**
 * 有界请求的**信号**工具。
 *
 * ## 🔴 为什么需要（真实缺陷，2026-11-28）
 *
 * 各供应商原先都写成：
 *
 * ```ts
 * signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
 * ```
 *
 * ⚠️ **`AbortSignal.timeout` 的计时器在 `fetch` 返回之后仍然有效**，
 * 它一旦触发，**响应体的读取会一起被 abort**（实测：fetch 先返回 200，
 * 随后读取 body 抛 `TimeoutError: The operation was aborted due to timeout`）。
 *
 * ⇒ 把「30 秒」当成**整个请求**的上限时，所有**长于 30 秒的回答都会被截断**
 *（推理型模型的首字本身就可达 60s+，长回答更常见）。
 *
 * ## 正确的分工
 *
 * | 阶段 | 由谁兜底 | 依据 |
 * |---|---|---|
 * | 请求发出 → 拿到响应头 | 这里的**有界信号**（超时即放弃） | 该阶段不可能有合法的长等待 |
 * | 响应头已到 → 流式读取 | **网关的流空闲超时**（`gateway/server.ts` 的 `STREAM_IDLE_TIMEOUT_MS`） | 长回答合法，只有「持续无数据」才是挂住 |
 *
 * ⇒ 本助手只给**前半段**设上限：调用方拿到响应后必须调用返回的 `stop()`，
 * 把计时器关掉，否则超时信号会带着「切断流」的副作用继续生效。
 *
 * ⚠️ **客户端取消不受影响**：`AbortSignal.any` 里始终保留了调用方传入的
 * `request.signal`，`stop()` 只清掉本地计时器，客户端随时断开仍会中断流。
 */

/**
 * 构造一个「只覆盖请求发出到响应头返回」的有界信号。
 *
 * @param requestSignal 调用方传入的信号（客户端取消），`undefined` 表示无。
 * @param timeoutMs 拿到响应头前的上限（毫秒）。
 * @returns `signal` 用于 fetch；`stop()` 在**拿到响应后必须调用**，
 *          以解除超时对响应体读取的影响。
 */
export function boundedSignal(
  requestSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; stop: () => void } {
  // ⚠️ `controller` **必须先声明**：`setTimeout` 的回调会引用它，
  // 声明在后会命中 TDZ（回调虽然在未来执行，但闭包捕获的是绑定本身）。
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)
  const parts = requestSignal === undefined ? [] : [requestSignal]
  return {
    signal: AbortSignal.any([...parts, controller.signal]),
    stop: () => {
      clearTimeout(timer)
    },
  }
}
