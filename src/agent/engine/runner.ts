import type { ChatRequest, Message, ProviderInfo, ToolCall, Effort } from "../shared/types";
import type { AgentEvent } from "./events";
import { streamViaProxy } from "./sse";

// Client-side agent loop, modeled on Friday's SessionRunner: stream a turn,
// fold ProviderEvents, execute tool calls against the live map, repeat until
// the model answers in plain text. Tools run in the browser; only the LLM
// stream crosses to the server.

const MAX_STEPS = 32;
const MAX_TOOL_ARGS = 200_000;

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(input: Record<string, unknown>): Promise<string>;
}

export interface RunnerConfig {
  provider: ProviderInfo;
  model: string;
  key?: string;
  effort?: Effort;
}

/** Friday's guard: never run a tool on corrupt streamed JSON — bounce it back. */
export function tryParseArgs(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? { ok: true, value: v as Record<string, unknown> } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Lightweight compaction: old tool results shrink to a stub (map data is refetchable). */
export function compactForSend(messages: Message[], keepRecent = 8): Message[] {
  if (messages.length <= keepRecent) return messages;
  const cutoff = messages.length - keepRecent;
  return messages.map((m, i) =>
    i < cutoff && m.role === "tool" && m.result.length > 240
      ? { ...m, result: `${m.result.slice(0, 200)}… [older result truncated]` }
      : m,
  );
}

export class Runner {
  readonly sessionId: string;
  messages: Message[] = [];
  private abortCtrl: AbortController | null = null;
  private cfg: RunnerConfig;
  private tools: AgentTool[];
  private emit: (e: AgentEvent) => void;
  private systemPrompt: () => string;

  constructor(opts: {
    sessionId: string;
    config: RunnerConfig;
    tools: AgentTool[];
    emit: (e: AgentEvent) => void;
    systemPrompt: () => string;
  }) {
    this.sessionId = opts.sessionId;
    this.cfg = opts.config;
    this.tools = opts.tools;
    this.emit = opts.emit;
    this.systemPrompt = opts.systemPrompt;
  }

  abort(): void {
    this.abortCtrl?.abort();
  }

  get busy(): boolean {
    return this.abortCtrl != null;
  }

  setConfig(cfg: RunnerConfig): void {
    this.cfg = cfg;
  }

  /** Run the loop for one user prompt. Resolves with the final assistant text. */
  async run(userText: string): Promise<string> {
    if (this.abortCtrl) throw new Error("already running");
    const ctrl = new AbortController();
    this.abortCtrl = ctrl;
    const sid = this.sessionId;
    this.messages.push({ role: "user", text: userText });
    let finalText = "";

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (ctrl.signal.aborted) break;
        // system prompt is rebuilt every turn so live map state stays current
        const req: ChatRequest = {
          model: this.cfg.model,
          messages: [{ role: "system", text: this.systemPrompt() }, ...compactForSend(this.messages)],
          tools: this.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
          effort: this.cfg.effort,
          maxTokens: 8192,
        };

        this.emit({ type: "message-start", sessionId: sid });
        const turn = await this.collectTurn(streamViaProxy(this.cfg.provider, this.cfg.key, req, ctrl.signal), ctrl.signal);

        const assistant: Message = { role: "assistant" };
        if (turn.text) assistant.text = turn.text;
        if (turn.reasoning) assistant.reasoning = turn.reasoning;
        if (turn.reasoningSignature) assistant.reasoningSignature = turn.reasoningSignature;
        if (turn.toolCalls.length) assistant.toolCalls = turn.toolCalls;
        this.messages.push(assistant);

        if (!turn.toolCalls.length || ctrl.signal.aborted) {
          finalText = turn.text;
          break;
        }

        for (const tc of turn.toolCalls) {
          if (ctrl.signal.aborted) break;
          const parsed = tryParseArgs(tc.arguments);
          this.emit({ type: "tool-call", sessionId: sid, callId: tc.id, name: tc.name, input: parsed.ok ? parsed.value : tc.arguments });
          let result: string;
          let isError = false;
          if (!parsed.ok) {
            result = "Error: tool arguments were not valid JSON — re-issue the call with valid JSON.";
            isError = true;
          } else {
            const tool = this.tools.find((t) => t.name === tc.name);
            if (!tool) {
              result = `Error: unknown tool "${tc.name}".`;
              isError = true;
            } else {
              try {
                result = await tool.run(parsed.value);
              } catch (e) {
                result = `Error: ${(e as Error).message}`;
                isError = true;
              }
            }
          }
          this.emit({ type: "tool-result", sessionId: sid, callId: tc.id, output: result, isError });
          this.messages.push({ role: "tool", callId: tc.id, name: tc.name, result, isError });
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        this.emit({ type: "error", sessionId: sid, message: (e as Error).message });
      }
    } finally {
      this.abortCtrl = null;
      this.emit({ type: "turn-done", sessionId: sid });
    }
    return finalText;
  }

  /** Fold the provider event stream into one assistant turn (Friday's collectTurn). */
  private async collectTurn(
    gen: AsyncGenerator<import("../shared/types").ProviderEvent>,
    signal: AbortSignal,
  ): Promise<{ text: string; reasoning: string; reasoningSignature: string; toolCalls: ToolCall[] }> {
    const sid = this.sessionId;
    let text = "";
    let reasoning = "";
    let reasoningSignature = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    try {
      for await (const ev of gen) {
        if (signal.aborted) break;
        switch (ev.type) {
          case "text":
            text += ev.delta;
            this.emit({ type: "text", sessionId: sid, delta: ev.delta });
            break;
          case "reasoning":
            reasoning += ev.delta;
            this.emit({ type: "reasoning", sessionId: sid, delta: ev.delta });
            break;
          case "reasoning_signature":
            reasoningSignature += ev.signature;
            break;
          case "tool_start": {
            const c = calls.get(ev.index) ?? { id: "", name: "", args: "" };
            if (ev.id) c.id = ev.id;
            if (ev.name) c.name = ev.name;
            calls.set(ev.index, c);
            break;
          }
          case "tool_delta": {
            const c = calls.get(ev.index) ?? { id: "", name: "", args: "" };
            if (c.args.length + ev.argsDelta.length > MAX_TOOL_ARGS) throw new Error("tool arguments exceeded the size limit");
            c.args += ev.argsDelta;
            calls.set(ev.index, c);
            break;
          }
          case "usage":
            this.emit({ type: "usage", sessionId: sid, input: ev.input, output: ev.output });
            break;
        }
      }
    } catch (e) {
      // an aborted stream rejects mid-read — keep the partial turn
      if (!signal.aborted) throw e;
    }
    let n = 0;
    const toolCalls: ToolCall[] = [...calls.values()]
      .filter((c) => c.name)
      .map((c) => ({ id: c.id || `call_${Date.now()}_${n++}`, name: c.name, arguments: c.args || "{}" }));
    return { text, reasoning, reasoningSignature, toolCalls };
  }
}
