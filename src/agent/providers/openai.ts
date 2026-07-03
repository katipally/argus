/* eslint-disable @typescript-eslint/no-explicit-any */
// Vendored from the Friday harness (packages/providers) — keep diffs minimal.
import type { ChatRequest, Message, ProviderEvent, ToolDef } from "../shared/types"
import { fetchWithRetry } from "./retry"
import { sseLines } from "./sse"
import { createThinkSplitter } from "./think"

/** Convert canonical messages to OpenAI Chat Completions format. */
function toMessages(messages: Message[]): unknown[] {
  const out: Record<string, unknown>[] = []
  for (const m of messages) {
    if (m.role === "system") out.push({ role: "system", content: m.text })
    else if (m.role === "user") {
      if (m.images?.length) {
        const content: Record<string, unknown>[] = []
        if (m.text) content.push({ type: "text", text: m.text })
        for (const img of m.images)
          content.push({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } })
        out.push({ role: "user", content })
      } else out.push({ role: "user", content: m.text })
    } else if (m.role === "assistant") {
      const msg: Record<string, unknown> = { role: "assistant", content: m.text ?? "" }
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments || "{}" },
        }))
      }
      out.push(msg)
    } else if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.callId, content: m.result })
    }
  }
  return out
}

function toTools(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

const EFFORT_MAP: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
}

export async function* streamOpenAI(opts: {
  baseURL: string
  apiKey?: string
  req: ChatRequest
  signal: AbortSignal
  headers?: Record<string, string>
}): AsyncGenerator<ProviderEvent> {
  const { baseURL, apiKey, req, signal } = opts
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toMessages(req.messages),
    stream: true,
    stream_options: { include_usage: true },
  }
  if (req.tools.length) {
    body.tools = toTools(req.tools)
    body.tool_choice = "auto"
  }
  if (req.effort) body.reasoning_effort = EFFORT_MAP[req.effort]
  if (req.maxTokens) body.max_tokens = req.maxTokens

  const res = await fetchWithRetry(
    `${baseURL.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...opts.headers,
      },
      body: JSON.stringify(body),
      signal,
    },
    signal,
  )

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "")
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 400) || res.statusText}`)
  }

  // Splits inline <think> spans out of `content` for models that leak them there.
  const think = createThinkSplitter()
  for await (const line of sseLines(res.body)) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (payload === "[DONE]") {
      const tail = think.flush()
      if (tail.reasoning) yield { type: "reasoning", delta: tail.reasoning }
      if (tail.text) yield { type: "text", delta: tail.text }
      yield { type: "done", stopReason: "stop" }
      return
    }
    let json: any
    try {
      json = JSON.parse(payload)
    } catch {
      continue
    }
    if (json.usage) {
      yield {
        type: "usage",
        input: json.usage.prompt_tokens ?? 0,
        output: json.usage.completion_tokens ?? 0,
      }
    }
    const choice = json.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === "string" && reasoning) yield { type: "reasoning", delta: reasoning }
    if (typeof delta.content === "string" && delta.content) {
      // Route any inline <think> spans to reasoning; the rest is the real answer.
      const split = think.process(delta.content)
      if (split.reasoning) yield { type: "reasoning", delta: split.reasoning }
      if (split.text) yield { type: "text", delta: split.text }
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = tc.index ?? 0
        if (tc.id || tc.function?.name) {
          yield { type: "tool_start", index, id: tc.id ?? `call_${index}`, name: tc.function?.name ?? "" }
        }
        if (tc.function?.arguments) yield { type: "tool_delta", index, argsDelta: tc.function.arguments }
      }
    }
  }
  const tail = think.flush()
  if (tail.reasoning) yield { type: "reasoning", delta: tail.reasoning }
  if (tail.text) yield { type: "text", delta: tail.text }
  yield { type: "done", stopReason: "stop" }
}
