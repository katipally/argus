import type { ChatRequest, ProviderEvent, ProviderInfo } from "../shared/types";
import { streamAnthropic } from "./anthropic";
import { streamGoogle } from "./google";
import { streamOpenAI } from "./openai";
import { streamOpenAIResponses } from "./openai-responses";

export * from "./catalog";

/** Dispatch a streaming chat request to the right wire adapter (Friday port). */
export function streamProvider(
  provider: ProviderInfo,
  apiKey: string | undefined,
  req: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  const headers =
    provider.id === "openrouter" ? { "HTTP-Referer": "https://argus.local", "X-Title": "Argus" } : undefined;
  if (provider.protocol === "anthropic")
    return streamAnthropic({ baseURL: provider.baseURL, apiKey, req, signal, headers });
  if (provider.protocol === "google") return streamGoogle({ baseURL: provider.baseURL, apiKey, req, signal });
  if (provider.supportsResponses)
    return streamOpenAIResponses({ baseURL: provider.baseURL, apiKey, req, signal, headers });
  return streamOpenAI({ baseURL: provider.baseURL, apiKey, req, signal, headers });
}
