import { describe, it, expect } from "vitest";
import { tryParseArgs, compactForSend, Runner } from "@/src/agent/engine/runner";
import type { Message, ProviderEvent } from "@/src/agent/shared/types";
import type { AgentTool } from "@/src/agent/engine/runner";

describe("tryParseArgs", () => {
  it("accepts valid JSON and empty args", () => {
    expect(tryParseArgs('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(tryParseArgs("")).toEqual({ ok: true, value: {} });
  });
  it("rejects corrupt JSON and non-objects", () => {
    expect(tryParseArgs('{"a":').ok).toBe(false);
    expect(tryParseArgs("42").ok).toBe(false);
  });
});

describe("compactForSend", () => {
  it("truncates old tool results but keeps recent ones", () => {
    const long = "x".repeat(500);
    const msgs: Message[] = Array.from({ length: 12 }, (_, i) => ({ role: "tool", callId: `c${i}`, name: "t", result: long }));
    const out = compactForSend(msgs, 4);
    expect((out[0] as { result: string }).result.length).toBeLessThan(260);
    expect((out[11] as { result: string }).result.length).toBe(500);
  });
});

// scripted StreamFn: the Runner streams via streamViaProxy, but we can drive the
// loop end-to-end by injecting tools + a fake provider through a Runner subclass-free
// path — here we exercise collectTurn's public contract via a stubbed generator.
async function* scripted(events: ProviderEvent[]): AsyncGenerator<ProviderEvent> {
  for (const e of events) yield e;
}

describe("Runner tool loop (via injected collectTurn)", () => {
  it("executes a tool call then finishes on plain text", async () => {
    const emitted: string[] = [];
    const tool: AgentTool = {
      name: "ping",
      description: "",
      parameters: { type: "object", properties: {} },
      async run() {
        return "pong";
      },
    };
    const runner = new Runner({
      sessionId: "test",
      config: { provider: { id: "x", name: "x", protocol: "openai", baseURL: "http://x" }, model: "m" },
      tools: [tool],
      emit: (e) => emitted.push(e.type),
      systemPrompt: () => "sys",
    });

    // first turn: a tool call; second turn: final text. Patch the private stream source.
    const turns = [
      [
        { type: "tool_start", index: 0, id: "c1", name: "ping" },
        { type: "tool_delta", index: 0, argsDelta: "{}" },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "text", delta: "all good" }, { type: "done", stopReason: "stop" }],
    ] as ProviderEvent[][];
    let call = 0;
    // @ts-expect-error — override the private stream method for the test
    runner.collectTurn = async () => {
      const t = turns[call++];
      // reuse the real fold by feeding scripted events through a tiny inline reducer
      let text = "";
      const calls: { id: string; name: string; args: string }[] = [];
      for await (const ev of scripted(t)) {
        if (ev.type === "text") text += ev.delta;
        if (ev.type === "tool_start") calls.push({ id: ev.id, name: ev.name, args: "" });
        if (ev.type === "tool_delta") calls[ev.index].args += ev.argsDelta;
      }
      return { text, reasoning: "", reasoningSignature: "", toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args || "{}" })) };
    };

    const final = await runner.run("hi");
    expect(final).toBe("all good");
    expect(emitted).toContain("tool-call");
    expect(emitted).toContain("tool-result");
    expect(runner.messages.some((m) => m.role === "tool" && m.result === "pong")).toBe(true);
  });
});
