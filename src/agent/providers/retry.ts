/**
 * Pre-stream fetch with bounded retry + exponential backoff. Provider endpoints return transient
 * 5xx / 429 / overloaded (529) errors; without retry a single blip kills the whole turn.
 *
 * IMPORTANT: only safe to use BEFORE the SSE body is consumed — retrying after bytes have been
 * yielded would replay already-emitted text/tool deltas. Callers wrap the initial `fetch` only.
 */
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 529])

export interface RetryOpts {
  retries?: number
  baseMs?: number
  maxMs?: number
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"))
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  opts: RetryOpts = {},
): Promise<Response> {
  const retries = opts.retries ?? 3 // up to 4 attempts total
  const baseMs = opts.baseMs ?? 500
  const maxMs = opts.maxMs ?? 8000
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError")
    let res: Response | undefined
    try {
      res = await fetch(url, init)
    } catch (e) {
      if (signal.aborted) throw e // user abort — don't retry
      lastErr = e // network error — retryable
    }
    // Success, or a non-retryable status → hand back so the caller can read/throw the rich body.
    if (res && (res.ok || !RETRY_STATUS.has(res.status))) return res
    if (attempt === retries) {
      if (res) return res // exhausted on a retryable status — let the caller throw its HTTP error
      throw lastErr ?? new Error("network error")
    }
    // Honor Retry-After when present, else exponential backoff with full-ish jitter.
    let delay = Math.min(maxMs, baseMs * 2 ** attempt)
    const ra = res?.headers.get("retry-after")
    if (ra) {
      const secs = Number(ra)
      if (Number.isFinite(secs) && secs >= 0) delay = Math.min(maxMs, secs * 1000)
    }
    delay = delay / 2 + Math.random() * (delay / 2)
    await sleepAbortable(delay, signal)
  }
  throw lastErr ?? new Error("unreachable")
}
