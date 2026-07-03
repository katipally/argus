import type { ChatRequest, ProviderEvent, ProviderInfo } from "../shared/types";

// Client-side StreamFn: POST the neutral request to /api/agent/stream and yield
// the normalized ProviderEvents back out of the SSE body.

export async function* streamViaProxy(
  provider: ProviderInfo,
  key: string | undefined,
  req: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  const res = await fetch("/api/agent/stream", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-agent-key": key } : {}) },
    body: JSON.stringify({ provider, ...req }),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        let ev: ProviderEvent | { type: "error"; message: string };
        try {
          ev = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (ev.type === "error") throw new Error(ev.message);
        yield ev;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
