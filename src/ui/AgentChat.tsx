"use client";

import { useEffect, useRef, useState } from "react";
import { useAgentStore, type ViewItem } from "@/src/agent/store";

// The agent conversation view. The composer lives in the Omnibox so there's a
// single input; provider/model/effort config lives in Settings → AI. Streaming
// bubbles, animated tool cards, nested subagent cards — driven by the store.
//
// Three ask-mode surfaces (Omnibox decides which is shown):
//   AgentTicker      — slim glass strip while working: live tool/commentary
//   FloatingExchange — after a turn: just the question + answer, floating over
//                      the map (map stays visible + interactive behind)
//   AgentMessages    — the full transcript, on demand ("history")

/** What is the agent doing right now — one line for the ticker. */
function deriveActivity(items: ViewItem[]): { label: string; actions: number } {
  let actions = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "user") break;
    if (items[i].kind === "tool") actions++;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") break;
    if (it.kind === "tool" && it.status === "running") return { label: `${it.name} ${compact(it.input)}`, actions };
    if (it.kind === "subagent" && it.status === "running") return { label: `recon: ${it.task.slice(0, 60)}`, actions };
    if (it.kind === "assistant") {
      // just the last few words — the pill is a status line, not a transcript
      const t = (it.text || it.reasoning).trim();
      if (t) {
        const words = t.split(/\s+/);
        return { label: `…${words.slice(-4).join(" ").slice(-48)}`, actions };
      }
    }
    if (it.kind === "tool") return { label: `${it.name} ✓`, actions };
  }
  return { label: "thinking…", actions };
}

/** Slim status strip shown while the agent works — map stays fully visible. */
export function AgentTicker({ onExpand }: { onExpand: () => void }) {
  const items = useAgentStore((s) => s.items);
  const abort = useAgentStore((s) => s.abort);
  const { label, actions } = deriveActivity(items);
  return (
    <div className="pointer-events-auto mb-2 flex w-full items-center gap-2.5 rounded-full border border-white/10 bg-black/55 px-4 py-2 backdrop-blur-md animate-[argus-rise_0.16s_ease-out]">
      <span className="argus-spinner shrink-0" />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-muted)]">{label}</span>
      {actions > 0 && <span className="tnum shrink-0 text-[10px] text-[var(--color-faint)]">{actions} act</span>}
      <button
        onClick={onExpand}
        title="Show the full transcript"
        className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--color-faint)] hover:text-[var(--color-text)]"
      >
        ▴ history
      </button>
      <button onClick={abort} className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--color-alert)]">
        stop
      </button>
    </div>
  );
}

/** After a turn: just the exchange (question + answer) floating over the map.
 *  Answer is height-capped and collapsible down to its footer bar. */
export function FloatingExchange({ onHistory, onDismiss }: { onHistory: () => void; onDismiss: () => void }) {
  const items = useAgentStore((s) => s.items);
  const [collapsed, setCollapsed] = useState(false); // resets naturally: unmounted while agent works
  let lastUser = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser === -1) return null;
  const q = (items[lastUser] as Extract<ViewItem, { kind: "user" }>).text;
  let answer = "";
  let error = "";
  let actions = 0;
  for (let i = lastUser + 1; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "assistant" && it.text.trim()) answer = it.text;
    if (it.kind === "error") error = it.text;
    if (it.kind === "tool") actions++;
  }
  return (
    <div className="pointer-events-auto mb-2 flex w-full flex-col gap-1.5 animate-[argus-rise_0.18s_ease-out]">
      <div
        className="max-w-[85%] self-end rounded-lg border border-white/10 px-3 py-1.5 text-[11px] leading-relaxed text-[var(--color-text)] backdrop-blur-md"
        style={{ background: "color-mix(in srgb, var(--color-accent) 16%, rgba(0,0,0,0.5))" }}
      >
        {q}
      </div>
      <div className="w-full self-start overflow-hidden rounded-lg border border-white/10 bg-black/55 backdrop-blur-md">
        {!collapsed && (
          <div className="thin-scroll max-h-[32vh] overflow-y-auto whitespace-pre-wrap px-3.5 py-2.5 text-[12px] leading-relaxed text-[var(--color-text)]">
            {answer || (error ? "" : "(no reply)")}
            {error && <span className="block text-[var(--color-alert)]">⚠︎ {error}</span>}
          </div>
        )}
        <div className={`flex items-center gap-3 px-3.5 py-1.5 ${collapsed ? "" : "border-t border-white/10"}`}>
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-faint)]">✦ argus</span>
          {actions > 0 && <span className="tnum text-[10px] text-[var(--color-faint)]">{actions} actions</span>}
          <span className="flex-1" />
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="text-[10px] uppercase tracking-wider text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            {collapsed ? "▴ expand" : "▾ collapse"}
          </button>
          <button onClick={onHistory} className="text-[10px] uppercase tracking-wider text-[var(--color-muted)] hover:text-[var(--color-text)]">
            history
          </button>
          <button onClick={onDismiss} aria-label="Dismiss" className="text-[11px] text-[var(--color-faint)] hover:text-[var(--color-text)]">
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

export function AgentMessages() {
  const items = useAgentStore((s) => s.items);
  const busy = useAgentStore((s) => s.busy);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, busy]);

  return (
    <div ref={scrollRef} className="thin-scroll flex flex-1 flex-col gap-2 overflow-y-auto px-3.5 py-3">
      {items.length === 0 && (
        <div className="text-[12px] leading-relaxed text-[var(--color-faint)]">
          Ask about the world. e.g. &ldquo;What&apos;s happening around Kyiv?&rdquo;, &ldquo;Focus Japan and show earthquakes&rdquo;, or &ldquo;Any protests in Europe today?&rdquo;.
        </div>
      )}
      {items.map((it, i) => (
        <Item key={i} item={it} />
      ))}
      {busy && (
        <div className="flex items-center gap-2 self-start">
          <span className="argus-spinner" />
          <span className="text-[11px] text-[var(--color-muted)]">working…</span>
        </div>
      )}
    </div>
  );
}

function Item({ item }: { item: ViewItem }) {
  if (item.kind === "user") {
    return (
      <div className="self-end" style={{ maxWidth: "90%" }}>
        <div className="rounded-lg px-3 py-2 text-[12px] leading-relaxed text-[var(--color-text)]" style={{ background: "color-mix(in srgb, var(--color-accent) 14%, transparent)" }}>
          {item.text}
        </div>
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div className="self-start" style={{ maxWidth: "92%" }}>
        {item.reasoning && <ReasoningBlock text={item.reasoning} />}
        {item.text && (
          <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-[12px] leading-relaxed text-[var(--color-text)] whitespace-pre-wrap">{item.text}</div>
        )}
      </div>
    );
  }
  if (item.kind === "tool") return <ToolCard item={item} />;
  if (item.kind === "subagent") {
    return (
      <div className="self-start rounded border border-[var(--color-secondary)]/40 bg-[var(--color-secondary)]/5 px-2 py-1 text-[10px]" style={{ marginLeft: 8 }}>
        <span className="text-[var(--color-secondary)]">◇ subagent</span>{" "}
        <span className="text-[var(--color-muted)]">{item.task.slice(0, 60)}</span>{" "}
        <span className="text-[var(--color-faint)]">{item.status === "running" ? "· working…" : "· done"}</span>
      </div>
    );
  }
  return <div className="self-start rounded border border-[var(--color-alert)]/40 px-2 py-1 text-[11px] text-[var(--color-alert)]">⚠︎ {item.text}</div>;
}

function ToolCard({ item }: { item: Extract<ViewItem, { kind: "tool" }> }) {
  const [expanded, setExpanded] = useState(false);
  const icon = item.status === "running" ? "◌" : item.status === "error" ? "✕" : "◉";
  const color = item.status === "error" ? "var(--color-alert)" : "var(--color-accent)";
  return (
    <div className="self-start w-full" style={{ marginLeft: item.depth * 10, maxWidth: "94%" }}>
      <button onClick={() => setExpanded((e) => !e)} className="flex w-full items-center gap-1.5 rounded border border-[var(--color-hairline)] px-2 py-1 text-left font-mono text-[10px]">
        <span style={{ color }}>{icon}</span>
        <span className="text-[var(--color-accent)]">{item.name}</span>
        <span className="truncate text-[var(--color-faint)]">{compact(item.input)}</span>
      </button>
      {expanded && item.output && (
        <pre className="thin-scroll mt-1 max-h-40 overflow-auto rounded bg-black/30 px-2 py-1 text-[10px] text-[var(--color-muted)] whitespace-pre-wrap">{item.output.slice(0, 2000)}</pre>
      )}
    </div>
  );
}

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1">
      <button onClick={() => setOpen((o) => !o)} className="text-[10px] text-[var(--color-faint)] hover:text-[var(--color-muted)]">
        {open ? "▾" : "▸"} reasoning
      </button>
      {open && <div className="mt-1 rounded bg-black/20 px-2 py-1 text-[10px] italic leading-relaxed text-[var(--color-faint)] whitespace-pre-wrap">{text}</div>}
    </div>
  );
}

function compact(input: unknown): string {
  if (typeof input === "string") return input.slice(0, 40);
  if (!input || typeof input !== "object") return "";
  return Object.entries(input as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 22)}`)
    .join(", ");
}
