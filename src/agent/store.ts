import { create } from "zustand";
import type { ProviderInfo, Effort } from "./shared/types";
import type { AgentEvent } from "./engine/events";
import { Runner, type RunnerConfig } from "./engine/runner";
import { BUILTIN_PROVIDERS } from "./providers";
import { buildTools } from "./tools";
import { makeSubagentTool } from "./tools/subagent";
import { systemPrompt } from "./prompt";

// Agent UI store. The engine.subscribe switch from Friday's TUI store, ported
// to Zustand: fold AgentEvents into renderable view items. Text deltas are
// buffered and flushed on a ~60ms timer so a fast stream can't thrash React.

export type ViewItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; reasoning: string }
  | { kind: "tool"; callId: string; name: string; input: unknown; output: string; status: "running" | "ok" | "error"; depth: number }
  | { kind: "subagent"; childId: string; task: string; status: "running" | "done" }
  | { kind: "error"; text: string };

export interface AgentCfg {
  providerId: string;
  model: string;
  effort?: Effort;
}

interface AgentStore {
  items: ViewItem[];
  busy: boolean;
  cfg: AgentCfg;
  providers: ProviderInfo[];
  lastUserText: string | null;

  setCfg(patch: Partial<AgentCfg>): void;
  addCustomProvider(p: { name: string; baseURL: string; protocol: ProviderInfo["protocol"] }): void;
  send(text: string): void;
  retryLast(): void;
  abort(): void;
  clear(): void;
}

const CFG_LS = "argus:agentcfg";
const PROV_LS = "argus:providers";

function load<T>(k: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(k: string, v: unknown) {
  if (typeof window !== "undefined") window.localStorage.setItem(k, JSON.stringify(v));
}

let runner: Runner | null = null;

// ── streaming buffer: coalesce text/reasoning deltas, flush at ~16fps ────────
const buf = new Map<string, { text: string; reasoning: string }>(); // sessionId -> pending
let flushTimer: ReturnType<typeof setInterval> | null = null;

function ensureFlusher(apply: () => void) {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (buf.size === 0) {
      clearInterval(flushTimer!);
      flushTimer = null;
      return;
    }
    apply();
  }, 60);
}

export const useAgentStore = create<AgentStore>((set, get) => {
  const initialProviders = [...BUILTIN_PROVIDERS, ...load<ProviderInfo[]>(PROV_LS, [])];
  // No default model — the user picks provider + model explicitly (send is
  // blocked until they do). We only restore a previously saved choice.
  const savedCfg = load<AgentCfg>(CFG_LS, { providerId: "", model: "" });

  // fold one engine event into view items (buffered deltas flushed separately)
  const onEvent = (e: AgentEvent) => {
    const depthOf = (sessionId: string) => (sessionId.includes("/sub-") ? 1 : 0);
    if (e.type === "text" || e.type === "reasoning") {
      const b = buf.get(e.sessionId) ?? { text: "", reasoning: "" };
      if (e.type === "text") b.text += e.delta;
      else b.reasoning += e.delta;
      buf.set(e.sessionId, b);
      ensureFlusher(() => {
        set((s) => {
          const items = [...s.items];
          for (const pending of buf.values()) {
            // find or create the trailing assistant bubble for this session
            let idx = -1;
            for (let i = items.length - 1; i >= 0; i--) {
              if (items[i].kind === "assistant") {
                idx = i;
                break;
              }
              if (items[i].kind === "tool" || items[i].kind === "user") break;
            }
            if (idx === -1) {
              items.push({ kind: "assistant", text: pending.text, reasoning: pending.reasoning });
            } else {
              const a = items[idx] as Extract<ViewItem, { kind: "assistant" }>;
              items[idx] = { kind: "assistant", text: a.text + pending.text, reasoning: a.reasoning + pending.reasoning };
            }
          }
          buf.clear();
          return { items };
        });
      });
      return;
    }
    // structural events apply immediately
    set((s) => {
      const items = [...s.items];
      switch (e.type) {
        case "message-start":
          // a fresh assistant bubble only if the previous item isn't an empty one
          break;
        case "tool-call":
          items.push({ kind: "tool", callId: e.callId, name: e.name, input: e.input, output: "", status: "running", depth: depthOf(e.sessionId) });
          break;
        case "tool-result": {
          const ti = items.findIndex((it) => it.kind === "tool" && it.callId === e.callId);
          if (ti >= 0) {
            const t = items[ti] as Extract<ViewItem, { kind: "tool" }>;
            items[ti] = { ...t, output: e.output, status: e.isError ? "error" : "ok" };
          }
          break;
        }
        case "subagent-start":
          items.push({ kind: "subagent", childId: e.childId, task: e.task, status: "running" });
          break;
        case "subagent-done": {
          const si = items.findIndex((it) => it.kind === "subagent" && it.childId === e.childId);
          if (si >= 0) items[si] = { ...(items[si] as Extract<ViewItem, { kind: "subagent" }>), status: "done" };
          break;
        }
        case "error":
          items.push({ kind: "error", text: e.message });
          break;
        case "turn-done":
          if (e.sessionId === runner?.sessionId) return { items, busy: false };
          break;
      }
      return { items };
    });
  };

  const currentConfig = (): RunnerConfig => {
    const s = get();
    const provider = s.providers.find((p) => p.id === s.cfg.providerId) ?? BUILTIN_PROVIDERS[0];
    // no client key — the SSE route reads the provider key from .env server-side
    return { provider, model: s.cfg.model, key: undefined, effort: s.cfg.effort };
  };

  const ensureRunner = (): Runner => {
    if (!runner) {
      const tools = buildTools();
      const subTool = makeSubagentTool(currentConfig, onEvent, "main");
      runner = new Runner({
        sessionId: "main",
        config: currentConfig(),
        tools: [...tools, subTool],
        emit: onEvent,
        systemPrompt,
      });
    } else {
      runner.setConfig(currentConfig());
    }
    return runner;
  };

  return {
    items: [],
    busy: false,
    cfg: savedCfg,
    providers: initialProviders,
    lastUserText: null,

    setCfg: (patch) =>
      set((s) => {
        // No auto-default model: switching provider clears the model so the
        // user must consciously pick one (honors "I will select the model").
        const cfg = { ...s.cfg, ...patch };
        if (patch.providerId && patch.model === undefined) cfg.model = "";
        save(CFG_LS, cfg);
        return { cfg };
      }),
    addCustomProvider: (p) =>
      set((s) => {
        const id = `custom-${p.name.toLowerCase().replace(/\s+/g, "-")}`;
        const prov: ProviderInfo = { id, name: p.name, protocol: p.protocol, baseURL: p.baseURL, custom: true };
        const customs = [...s.providers.filter((x) => x.custom), prov];
        save(PROV_LS, customs);
        return { providers: [...BUILTIN_PROVIDERS, ...customs], cfg: { ...s.cfg, providerId: id } };
      }),

    send: (text) => {
      const t = text.trim();
      if (!t || get().busy) return;
      const { providerId, model } = get().cfg;
      if (!providerId || !model) {
        set((s) => ({
          items: [...s.items, { kind: "user", text: t }, { kind: "error", text: "Pick a provider and model first (⚙ settings)." }],
          input: "",
        }));
        return;
      }
      set((s) => ({ items: [...s.items, { kind: "user", text: t }], busy: true, input: "", lastUserText: t }));
      void ensureRunner().run(t);
    },
    retryLast: () => {
      const last = get().lastUserText;
      if (last && !get().busy) get().send(last);
    },
    abort: () => {
      runner?.abort();
      set({ busy: false });
    },
    clear: () => {
      runner?.abort();
      runner = null;
      set({ items: [], busy: false, lastUserText: null });
    },
  };
});
