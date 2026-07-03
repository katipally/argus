import type { ProviderInfo } from "@/src/agent/shared/types";
import { BUILTIN_PROVIDERS } from "@/src/agent/providers";

// Live model catalog: fetch the provider's own /models list server-side with the
// .env key so the Settings → AI picker always shows what the key can actually
// use. OpenRouter also returns context length + reasoning support metadata.

export const dynamic = "force-dynamic";

const ENV_KEYS: Record<string, string | undefined> = {
  anthropic: process.env.ANTHROPIC_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  google: process.env.GOOGLE_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
  groq: process.env.GROQ_API_KEY,
  deepseek: process.env.DEEPSEEK_API_KEY,
};

export interface ModelInfo {
  id: string;
  name?: string;
  context?: number;
  reasoning?: boolean;
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const r = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

async function listModels(p: ProviderInfo, key: string): Promise<ModelInfo[]> {
  const base = p.baseURL.replace(/\/$/, "");
  if (p.protocol === "anthropic") {
    const d = (await fetchJson(`${base}/models?limit=100`, {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    })) as { data?: { id: string; display_name?: string }[] };
    return (d.data ?? []).map((m) => ({ id: m.id, name: m.display_name, reasoning: true }));
  }
  if (p.protocol === "google") {
    const d = (await fetchJson(`${base}/models?key=${encodeURIComponent(key)}&pageSize=100`, {})) as {
      models?: { name: string; displayName?: string; inputTokenLimit?: number }[];
    };
    return (d.models ?? [])
      .map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName, context: m.inputTokenLimit, reasoning: true }))
      .filter((m) => m.id.includes("gemini"));
  }
  // openai-compatible (openai / openrouter / groq / deepseek / ollama / custom)
  const d = (await fetchJson(`${base}/models`, key ? { Authorization: `Bearer ${key}` } : {})) as {
    data?: { id: string; name?: string; context_length?: number; supported_parameters?: string[] }[];
  };
  return (d.data ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    context: m.context_length,
    reasoning: m.supported_parameters ? m.supported_parameters.includes("reasoning") : undefined,
  }));
}

export async function POST(req: Request) {
  let body: { provider?: ProviderInfo };
  try {
    body = (await req.json()) as { provider?: ProviderInfo };
  } catch {
    return Response.json({ error: "bad body" }, { status: 400 });
  }
  const builtin = BUILTIN_PROVIDERS.find((p) => p.id === body.provider?.id);
  const provider = builtin ?? body.provider;
  if (!provider?.baseURL || !/^https?:\/\//.test(provider.baseURL)) {
    return Response.json({ error: "bad provider" }, { status: 400 });
  }
  const key = ENV_KEYS[provider.id] ?? "";
  if (!key && !provider.keyless && !provider.custom && provider.id !== "openrouter") {
    // openrouter's model list is public; everyone else needs their env key
    return Response.json({ models: [], hint: `no ${provider.name} key in .env` });
  }
  try {
    const models = await listModels(provider, key);
    models.sort((a, b) => a.id.localeCompare(b.id));
    return Response.json({ models });
  } catch {
    return Response.json({ models: [], hint: "model list unavailable" });
  }
}
