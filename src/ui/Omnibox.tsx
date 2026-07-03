"use client";

import { useEffect, useRef, useState } from "react";
import { useArgusStore } from "@/src/store/useArgusStore";
import { useAgentStore } from "@/src/agent/store";
import { layerManager } from "@/src/layers/registry";
import { primaryBbox } from "@/src/core/bbox";
import { resolvePlace, eezShape } from "@/src/geo/resolve";
import { AgentMessages, AgentTicker, FloatingExchange } from "@/src/ui/AgentChat";

// The unified command bar (Palantir-style omnibox). Find mode = typeahead place
// search that focuses/selects the REAL boundary. Ask mode = the Argus agent.
// Ask-mode is compact-first so the MAP stays visible: while working, a slim
// status ticker; after a turn, just the floating question+answer; the full
// transcript only on demand ("history"/"full").

type Mode = "find" | "ask";
type AskView = "compact" | "full";
interface Sugg {
  name: string;
  lng: number;
  lat: number;
}

const COORD = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

export default function Omnibox() {
  const [mode, setMode] = useState<Mode>("find");
  const [text, setText] = useState("");
  const [sugg, setSugg] = useState<Sugg[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [askView, setAskView] = useState<AskView>("compact"); // compact-first: map stays visible
  const [dismissed, setDismissed] = useState(false); // floating answer hidden until next turn
  const prevBusy = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addShape = useArgusStore((s) => s.addShape);
  const setSettingsTab = useArgusStore((s) => s.setSettingsTab);
  const agentBusy = useAgentStore((s) => s.busy);
  const agentItems = useAgentStore((s) => s.items);
  const send = useAgentStore((s) => s.send);
  const abort = useAgentStore((s) => s.abort);
  const retryLast = useAgentStore((s) => s.retryLast);
  const clear = useAgentStore((s) => s.clear);
  const cfg = useAgentStore((s) => s.cfg);

  // external "Ask Argus about this area" trigger
  useEffect(() => {
    const onAsk = (e: Event) => {
      setMode("ask");
      setDismissed(false);
      send((e as CustomEvent<string>).detail);
    };
    window.addEventListener("argus:ask", onAsk);
    return () => window.removeEventListener("argus:ask", onAsk);
  }, [send]);

  // a new turn auto-minimizes to the ticker (map visible while the agent
  // works) and re-surfaces the floating answer when done
  useEffect(() => {
    if (agentBusy && !prevBusy.current) {
      setAskView("compact");
      setDismissed(false);
    }
    prevBusy.current = agentBusy;
  }, [agentBusy]);

  // Find typeahead (debounced)
  useEffect(() => {
    if (mode !== "find" || text.trim().length < 2 || COORD.test(text)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSugg([]);
      return;
    }
    const q = text.trim();
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
        if (r.ok) {
          setSugg((await r.json()) as Sugg[]);
          setActiveIdx(-1);
        }
      } catch {
        /* ignore */
      }
    }, 220);
    return () => clearTimeout(t);
  }, [text, mode]);

  const focusPlace = async (name: string, lat: number, lng: number) => {
    setBusy(true);
    setSugg([]);
    try {
      const label = name.split(",")[0].trim();
      // query the primary token (commas break Nominatim); fall back to reverse
      // geocoding the coordinates, then finally a plain camera fly.
      let shape = await resolvePlace({ name: label, label });
      if (!shape && Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) {
        shape = await resolvePlace({ lat, lon: lng, label });
      }
      if (shape) {
        addShape(shape, false);
        if (shape.kind === "country") void eezShape(label).then((s) => s && addShape(s, true));
        const bb = primaryBbox(shape.geometry) ?? useArgusStore.getState().aoi?.bbox;
        if (bb) layerManager.fitBbox(bb, { pitch: 15 });
      } else {
        layerManager.flyTo({ center: [lng, lat], zoom: 9 });
      }
    } finally {
      setBusy(false);
      setText("");
    }
  };

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    if (mode === "ask") {
      send(t);
      setText("");
      return;
    }
    const m = COORD.exec(t);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      void focusPlace(`${lat},${lng}`, lat, lng);
      return;
    }
    const pick = activeIdx >= 0 ? sugg[activeIdx] : sugg[0];
    if (pick) void focusPlace(pick.name, pick.lat, pick.lng);
    else void focusPlace(t, 0, 0);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (mode === "find" && sugg.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % sugg.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (i <= 0 ? sugg.length - 1 : i - 1));
        return;
      }
      if (e.key === "Escape") {
        setSugg([]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const needsModel = !cfg.providerId || !cfg.model;
  const showFull = mode === "ask" && (agentItems.length > 0 || agentBusy) && askView === "full";
  const showTicker = mode === "ask" && agentBusy && askView === "compact";
  const showExchange = mode === "ask" && !agentBusy && askView === "compact" && !dismissed && agentItems.length > 0;
  const showResume = mode === "ask" && !agentBusy && askView === "compact" && dismissed && agentItems.length > 0;

  return (
    <div className="pointer-events-none absolute bottom-9 left-1/2 z-20 flex w-[min(560px,46vw)] -translate-x-1/2 flex-col">
      {/* panels expand UPWARD (rendered above the input row) */}
      {mode === "find" && sugg.length > 0 && (
        <div className="panel pointer-events-auto thin-scroll mb-2 max-h-64 overflow-y-auto animate-[argus-rise_0.16s_ease-out]">
          {sugg.map((s, i) => (
            <button
              key={i}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => void focusPlace(s.name, s.lat, s.lng)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors"
              style={{ background: i === activeIdx ? "color-mix(in srgb, var(--color-accent) 14%, transparent)" : "transparent", color: "var(--color-text)" }}
            >
              <span className="text-[var(--color-faint)]">⌖</span>
              <span className="truncate">{s.name}</span>
            </button>
          ))}
        </div>
      )}

      {showFull && (
        <div className="panel pointer-events-auto mb-2 flex max-h-[46vh] min-h-[180px] flex-col overflow-hidden animate-[argus-rise_0.18s_ease-out]">
          <div className="panel-head">
            <span className="label">Argus · analyst</span>
            <span className="flex items-center gap-3">
              {agentItems.length > 0 && !agentBusy && (
                <button onClick={retryLast} title="Retry last question" className="text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)]">↻</button>
              )}
              {agentItems.length > 0 && (
                <button
                  onClick={clear}
                  title="Clear — permanently deletes this conversation"
                  className="text-[10px] uppercase tracking-wider text-[var(--color-muted)] hover:text-[var(--color-alert)]"
                >
                  clear
                </button>
              )}
              {/* Minimize = back to the compact floating view — distinct from
                  Clear so users stop confusing "hide" with "delete". */}
              <button
                onClick={() => { setAskView("compact"); setDismissed(false); }}
                title="Minimize — compact floating view, conversation kept"
                className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--color-muted)] hover:text-[var(--color-text)]"
              >
                ▾ minimize
              </button>
            </span>
          </div>
          {needsModel && (
            <button onClick={() => setSettingsTab("ai")} className="border-b border-[var(--color-hairline)] bg-[var(--color-alert)]/10 px-3 py-1.5 text-left text-[11px] text-[var(--color-alert)]">
              No model selected — open Settings → AI to choose a provider &amp; model ⚙
            </button>
          )}
          <AgentMessages />
        </div>
      )}
      {showTicker && <AgentTicker onExpand={() => setAskView("full")} />}
      {showExchange && (
        <FloatingExchange onHistory={() => setAskView("full")} onDismiss={() => setDismissed(true)} />
      )}
      {showResume && (
        <button
          onClick={() => setDismissed(false)}
          className="pointer-events-auto mb-2 self-center rounded-full border border-white/10 bg-black/55 px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--color-accent)] backdrop-blur-md hover:brightness-125"
        >
          ▴ last answer ({agentItems.length})
        </button>
      )}

      <div className="panel pointer-events-auto overflow-hidden">
        {/* input row */}
        <div className="flex items-center gap-2 px-3 py-2">
          <div className="flex rounded-md bg-black/30 p-0.5 text-[10px] uppercase tracking-wider">
            {(["find", "ask"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setDismissed(false); }}
                className="rounded px-2 py-1 transition-colors"
                style={{
                  background: mode === m ? "color-mix(in srgb, var(--color-accent) 20%, transparent)" : "transparent",
                  color: mode === m ? "var(--color-accent)" : "var(--color-muted)",
                }}
              >
                {m}
              </button>
            ))}
          </div>
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setDismissed(false)}
            onKeyDown={onKey}
            placeholder={mode === "find" ? "Search a place, country, coordinates…" : "Ask Argus about the world…"}
            className="flex-1 bg-transparent text-[13px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
          />
          {busy && <span className="argus-spinner h-3.5 w-3.5" />}
          {mode === "ask" &&
            (agentBusy ? (
              <button onClick={abort} className="text-[11px] uppercase tracking-wider text-[var(--color-alert)]">stop</button>
            ) : (
              <button onClick={submit} className="text-[11px] uppercase tracking-wider text-[var(--color-accent)]">send</button>
            ))}
        </div>
      </div>
    </div>
  );
}
