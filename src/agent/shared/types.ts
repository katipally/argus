// Canonical agent-engine types, ported from the Friday harness (packages/shared).
// Wire-format-agnostic; each provider adapter converts to/from its own shape.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** A pending or completed tool call as the model expressed it. */
export interface ToolCall {
  id: string;
  name: string;
  /** raw JSON string of arguments (may be partial while streaming) */
  arguments: string;
}

/** An image attached to a user message (base64-encoded). */
export interface ImagePart {
  data: string;
  mime: string;
}

/** Canonical conversation message kept by the engine. */
export type Message =
  | { role: "system"; text: string }
  | { role: "user"; text: string; images?: ImagePart[] }
  | { role: "assistant"; text?: string; reasoning?: string; reasoningSignature?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; callId: string; name: string; result: string; isError?: boolean; images?: ImagePart[] };

/** Tool description handed to the model (JSON-Schema parameters). */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** What a request to a provider needs. */
export interface ChatRequest {
  model: string;
  messages: Message[];
  tools: ToolDef[];
  effort?: Effort;
  maxTokens?: number;
}

/** Provider wire protocol — selects the adapter. */
export type Protocol = "openai" | "anthropic" | "google";

/** A configured provider the user can connect to. */
export interface ProviderInfo {
  id: string;
  name: string;
  protocol: Protocol;
  baseURL: string;
  /** true for OpenAI-compatible local servers (ollama) that need no key */
  keyless?: boolean;
  /** supports the OpenAI Responses API (/v1/responses) */
  supportsResponses?: boolean;
  /** user added this as a custom endpoint */
  custom?: boolean;
}

/** Normalized streaming event emitted by every provider adapter. */
export type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "reasoning_signature"; signature: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_delta"; index: number; argsDelta: string }
  | { type: "tool_stop"; index: number }
  | { type: "usage"; input: number; output: number }
  | { type: "done"; stopReason: string };
