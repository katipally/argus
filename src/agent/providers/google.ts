/* eslint-disable @typescript-eslint/no-explicit-any */
// Vendored from the Friday harness (packages/providers) — keep diffs minimal.
import type { ChatRequest, Message, ProviderEvent, ToolDef } from "../shared/types"
import { thinkingBudget } from "./effort"
import { fetchWithRetry } from "./retry"
import { sseLines } from "./sse"

/** Convert canonical messages to Gemini `contents` + systemInstruction. */
function toGoogle(messages: Message[]): { system?: string; contents: unknown[] } {
  let system: string | undefined
  const contents: Record<string, unknown>[] = []
  for (const m of messages) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.text}` : m.text
    } else if (m.role === "user") {
      const parts: Record<string, unknown>[] = []
      if (m.text) parts.push({ text: m.text })
      for (const img of m.images ?? []) parts.push({ inlineData: { mimeType: img.mime, data: img.data } })
      contents.push({ role: "user", parts: parts.length ? parts : [{ text: m.text }] })
    } else if (m.role === "assistant") {
      const parts: Record<string, unknown>[] = []
      if (m.text) parts.push({ text: m.text })
      for (const tc of m.toolCalls ?? []) {
        let args: unknown = {}
        try {
          args = JSON.parse(tc.arguments || "{}")
        } catch {
          /* keep {} */
        }
        parts.push({ functionCall: { name: tc.name, args } })
      }
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] })
    } else if (m.role === "tool") {
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: m.name, response: { result: m.result } } }],
      })
    }
  }
  return { system, contents }
}

function toTools(tools: ToolDef[]): unknown[] {
  if (!tools.length) return []
  return [
    {
      functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    },
  ]
}

export async function* streamGoogle(opts: {
  baseURL: string
  apiKey?: string
  req: ChatRequest
  signal: AbortSignal
}): AsyncGenerator<ProviderEvent> {
  const { baseURL, apiKey, req, signal } = opts
  const { system, contents } = toGoogle(req.messages)
  const body: Record<string, unknown> = { contents }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  const tools = toTools(req.tools)
  if (tools.length) body.tools = tools
  // Thinking: request a thinking budget + thought summaries when a reasoning effort is set.
  if (req.effort) {
    body.generationConfig = { thinkingConfig: { thinkingBudget: thinkingBudget(req.effort), includeThoughts: true } }
  }

  const url = `${baseURL.replace(/\/$/, "")}/models/${req.model}:streamGenerateContent?alt=sse${apiKey ? `&key=${apiKey}` : ""}`
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
    signal,
  )
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "")
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 400) || res.statusText}`)
  }

  let toolIndex = 0
  for await (const line of sseLines(res.body)) {
    if (!line.startsWith("data:")) continue
    let json: any
    try {
      json = JSON.parse(line.slice(5).trim())
    } catch {
      continue
    }
    if (json.usageMetadata) {
      yield {
        type: "usage",
        input: json.usageMetadata.promptTokenCount ?? 0,
        output: json.usageMetadata.candidatesTokenCount ?? 0,
      }
    }
    const cand = json.candidates?.[0]
    for (const part of cand?.content?.parts ?? []) {
      if (typeof part.text === "string" && part.text) {
        // Gemini marks thinking parts with `thought: true`.
        yield part.thought ? { type: "reasoning", delta: part.text } : { type: "text", delta: part.text }
      } else if (part.functionCall) {
        const i = toolIndex++
        yield { type: "tool_start", index: i, id: `${part.functionCall.name}_${i}`, name: part.functionCall.name }
        yield { type: "tool_delta", index: i, argsDelta: JSON.stringify(part.functionCall.args ?? {}) }
        yield { type: "tool_stop", index: i }
      }
    }
    if (cand?.finishReason) yield { type: "done", stopReason: cand.finishReason }
  }
  yield { type: "done", stopReason: "stop" }
}
