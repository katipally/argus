/* eslint-disable @typescript-eslint/no-explicit-any */
// Vendored from the Friday harness (packages/providers) — keep diffs minimal.
import type { ChatRequest, Message, ProviderEvent, ToolDef } from "../shared/types"
import { thinkingBudget } from "./effort"
import { fetchWithRetry } from "./retry"
import { safeJsonParse, sseLines } from "./sse"

function toAnthropic(messages: Message[]): { system?: string; messages: unknown[] } {
  let system: string | undefined
  const out: Record<string, unknown>[] = []
  for (const m of messages) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.text}` : m.text
    } else if (m.role === "user") {
      const content: Record<string, unknown>[] = []
      if (m.text) content.push({ type: "text", text: m.text })
      for (const img of m.images ?? []) {
        content.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } })
      }
      out.push({ role: "user", content: content.length ? content : [{ type: "text", text: m.text }] })
    } else if (m.role === "assistant") {
      const content: Record<string, unknown>[] = []
      // Replay the signed thinking block first (required by Anthropic when thinking + tools are used).
      if (m.reasoning && m.reasoningSignature) {
        content.push({ type: "thinking", thinking: m.reasoning, signature: m.reasoningSignature })
      }
      if (m.text) content.push({ type: "text", text: m.text })
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: safeJsonParse(tc.arguments || "{}") })
      }
      // Skip assistant turns with no content at all rather than emitting an empty text block
      // (some providers reject `{type:"text",text:""}`).
      if (content.length) out.push({ role: "assistant", content })
    } else if (m.role === "tool") {
      // Tool results are normally a plain string, but when a tool returns images (e.g. a
      // computer-use screenshot) we send a content array of [text, image…] so the model can SEE
      // the result — the vision loop that makes screen control actually work.
      const trContent: unknown = m.images?.length
        ? [
            { type: "text", text: m.result },
            ...m.images.map((img) => ({
              type: "image",
              source: { type: "base64", media_type: img.mime, data: img.data },
            })),
          ]
        : m.result
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.callId, content: trContent, is_error: m.isError ?? false }],
      })
    }
  }
  // Rolling conversation-cache breakpoint: mark the last content block of the most recent message so
  // the whole message prefix is cached and re-read at ~10% price on the next turn (Anthropic caches
  // the longest matching prefix). Without this, the growing `messages` array is re-billed at full
  // input price every turn — the single biggest cost/latency lever in a long agentic loop. The
  // system block + last tool def carry their own breakpoints, so this is the 3rd of Anthropic's 4.
  const last = out[out.length - 1]
  const content = last?.content
  if (Array.isArray(content) && content.length) {
    const block = content[content.length - 1] as Record<string, unknown>
    block.cache_control = { type: "ephemeral" }
  }
  return { system, messages: out }
}

function toTools(tools: ToolDef[]): unknown[] {
  return tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
    // Cache the (stable) tool list prefix — marking the last tool caches all of them.
    ...(i === tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
  }))
}

export async function* streamAnthropic(opts: {
  baseURL: string
  apiKey?: string
  req: ChatRequest
  signal: AbortSignal
  headers?: Record<string, string>
}): AsyncGenerator<ProviderEvent> {
  const { baseURL, apiKey, req, signal } = opts
  const { system, messages } = toAnthropic(req.messages)
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 8192,
    messages,
    stream: true,
  }
  // Send the system prompt as a cacheable block (prompt caching → ~cheaper/faster repeats).
  if (system) body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
  if (req.tools.length) body.tools = toTools(req.tools)
  // Extended thinking: enable when a reasoning effort is requested. max_tokens must exceed the budget.
  if (req.effort) {
    const budget = thinkingBudget(req.effort)
    body.thinking = { type: "enabled", budget_tokens: budget }
    body.max_tokens = Math.min(budget + (req.maxTokens ?? 8192), 32000) // must exceed the budget, capped for safety
  }

  const res = await fetchWithRetry(
    `${baseURL.replace(/\/$/, "")}/messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
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

  for await (const line of sseLines(res.body)) {
    if (!line.startsWith("data:")) continue
    let json: any
    try {
      json = JSON.parse(line.slice(5).trim())
    } catch {
      continue
    }
    switch (json.type) {
      case "message_start": {
        const u = json.message?.usage
        if (u) {
          // Include cache read/creation so a fully-cached turn (input_tokens===0) still reports a
          // real context size — needed for the token bar and compaction trigger.
          const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
          yield { type: "usage", input, output: 0 }
        }
        break
      }
      case "content_block_start": {
        const block = json.content_block
        if (block?.type === "tool_use") {
          yield { type: "tool_start", index: json.index, id: block.id, name: block.name }
        }
        break
      }
      case "content_block_delta": {
        const d = json.delta
        if (d?.type === "text_delta") yield { type: "text", delta: d.text }
        else if (d?.type === "thinking_delta") yield { type: "reasoning", delta: d.thinking }
        else if (d?.type === "signature_delta") yield { type: "reasoning_signature", signature: d.signature }
        else if (d?.type === "input_json_delta")
          yield { type: "tool_delta", index: json.index, argsDelta: d.partial_json }
        break
      }
      case "content_block_stop":
        yield { type: "tool_stop", index: json.index }
        break
      case "message_delta":
        if (json.usage?.output_tokens) yield { type: "usage", input: 0, output: json.usage.output_tokens }
        if (json.delta?.stop_reason) yield { type: "done", stopReason: json.delta.stop_reason }
        break
      case "message_stop":
        yield { type: "done", stopReason: "stop" }
        return
    }
  }
  yield { type: "done", stopReason: "stop" }
}
