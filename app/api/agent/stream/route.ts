import type { ChatRequest, ProviderInfo } from "@/src/agent/shared/types";
import { streamProvider, BUILTIN_PROVIDERS } from "@/src/agent/providers";

// Streaming LLM proxy: the browser engine sends one neutral ChatRequest; this
// route runs the Friday-ported provider adapter server-side and pipes the
// normalized ProviderEvents back as SSE. Key from x-agent-key header (in-app
// KeyDialog) or a matching env var. Custom providers ride in the body but only
// with http(s) baseURLs.

export const dynamic = "force-dynamic";

const ENV_KEYS: Record<string, string | undefined> = {
  anthropic: process.env.ANTHROPIC_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  google: process.env.GOOGLE_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
  groq: process.env.GROQ_API_KEY,
  deepseek: process.env.DEEPSEEK_API_KEY,
};

interface Body extends ChatRequest {
  provider: ProviderInfo;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "bad body" }, { status: 400 });
  }
  // trust built-in provider definitions from our own catalog; custom ones only need a sane URL
  const builtin = BUILTIN_PROVIDERS.find((p) => p.id === body.provider?.id);
  const provider = builtin ?? body.provider;
  if (!provider?.baseURL || !/^https?:\/\//.test(provider.baseURL)) {
    return Response.json({ error: "bad provider" }, { status: 400 });
  }
  const key = req.headers.get("x-agent-key") || ENV_KEYS[provider.id] || "";
  if (!key && !provider.keyless && !provider.custom) {
    return Response.json(
      { error: `No API key for ${provider.name}. Add one in the agent panel.` },
      { status: 401 },
    );
  }

  const chatReq: ChatRequest = {
    model: body.model,
    messages: body.messages,
    tools: body.tools ?? [],
    effort: body.effort,
    maxTokens: body.maxTokens,
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of streamProvider(provider, key || undefined, chatReq, req.signal)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        }
      } catch (e) {
        const msg = req.signal.aborted ? "aborted" : (e as Error).message;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
