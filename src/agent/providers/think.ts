/**
 * Splits inline `<think>…</think>` (and `<thinking>…</thinking>`) spans out of an
 * OpenAI-compatible content stream. Some models (DeepSeek-R1, Qwen, many local/Ollama
 * and OpenRouter models) emit their chain-of-thought inline in `delta.content` instead
 * of a separate `reasoning_content` field, which leaks the raw tags into the answer.
 *
 * The splitter is stateful across chunks: a tag can be split across SSE deltas
 * (e.g. "…<thi" then "nk>…"), so we hold back the longest suffix that could be the
 * start of a tag until the next chunk resolves it.
 */
const OPEN = ["<think>", "<thinking>"]
const CLOSE = ["</think>", "</thinking>"]

function earliest(hay: string, needles: string[]): { idx: number; len: number } | null {
  let best: { idx: number; len: number } | null = null
  for (const n of needles) {
    const i = hay.indexOf(n)
    if (i !== -1 && (!best || i < best.idx)) best = { idx: i, len: n.length }
  }
  return best
}

/** Longest suffix of `s` that is a proper prefix of any needle (a possibly-incomplete tag). */
function partialHold(s: string, needles: string[]): number {
  let max = 0
  for (const n of needles) {
    const lim = Math.min(s.length, n.length - 1)
    for (let k = lim; k > 0; k--) {
      if (s.endsWith(n.slice(0, k))) {
        if (k > max) max = k
        break
      }
    }
  }
  return max
}

export type ThinkChunk = { reasoning: string; text: string }

export function createThinkSplitter() {
  let inThink = false
  let carry = ""

  function process(chunk: string): ThinkChunk {
    carry += chunk
    let reasoning = ""
    let text = ""
    for (;;) {
      const needles = inThink ? CLOSE : OPEN
      const hit = earliest(carry, needles)
      if (hit) {
        const before = carry.slice(0, hit.idx)
        if (inThink) reasoning += before
        else text += before
        carry = carry.slice(hit.idx + hit.len)
        inThink = !inThink
        continue
      }
      const hold = partialHold(carry, needles)
      const emit = hold ? carry.slice(0, carry.length - hold) : carry
      if (inThink) reasoning += emit
      else text += emit
      carry = hold ? carry.slice(carry.length - hold) : ""
      break
    }
    return { reasoning, text }
  }

  /** Emit any held-back partial tag at end of stream (an unterminated span). */
  function flush(): ThinkChunk {
    const rem = carry
    carry = ""
    return inThink ? { reasoning: rem, text: "" } : { reasoning: "", text: rem }
  }

  return { process, flush }
}
