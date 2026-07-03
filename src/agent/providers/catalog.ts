import type { ProviderInfo } from "../shared/types";

/** Built-in providers. Users can add custom OpenAI-compatible endpoints in the dock. */
export const BUILTIN_PROVIDERS: ProviderInfo[] = [
  { id: "anthropic", name: "Anthropic", protocol: "anthropic", baseURL: "https://api.anthropic.com/v1" },
  { id: "openai", name: "OpenAI", protocol: "openai", baseURL: "https://api.openai.com/v1", supportsResponses: true },
  { id: "google", name: "Google Gemini", protocol: "google", baseURL: "https://generativelanguage.googleapis.com/v1beta" },
  { id: "openrouter", name: "OpenRouter", protocol: "openai", baseURL: "https://openrouter.ai/api/v1" },
  { id: "groq", name: "Groq", protocol: "openai", baseURL: "https://api.groq.com/openai/v1" },
  { id: "deepseek", name: "DeepSeek", protocol: "openai", baseURL: "https://api.deepseek.com/v1" },
  { id: "ollama", name: "Ollama (local)", protocol: "openai", baseURL: "http://localhost:11434/v1", keyless: true },
];

export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o",
  google: "gemini-2.5-flash",
  openrouter: "anthropic/claude-sonnet-4.5",
  groq: "llama-3.3-70b-versatile",
  deepseek: "deepseek-chat",
  ollama: "llama3.2",
};

/** Suggested model ids per provider for the picker (free-text still allowed). */
export const MODEL_OPTIONS: Record<string, string[]> = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-fable-5"],
  openai: ["gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
  google: ["gemini-2.5-pro", "gemini-2.5-flash"],
  openrouter: ["anthropic/claude-sonnet-4.5", "openai/gpt-4o", "google/gemini-2.5-flash"],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  ollama: ["llama3.2", "qwen2.5", "mistral"],
};
