"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useArgusStore } from "@/src/store/useArgusStore";
import { layerManager } from "@/src/layers/registry";
import { resolvePlace, eezShape } from "@/src/geo/resolve";
import { primaryBbox } from "@/src/core/bbox";

// ⌘K / Ctrl+K command palette — keyboard-first control of the whole console:
// focus a place, toggle layers, switch skins, open settings, ask the agent.

interface Action {
  id: string;
  label: string;
  hint: string;
  run(): void | Promise<void>;
}

// module-scope so the render-purity lint sees no impure call inside the component
const startReplay = () => useArgusStore.getState().setPlayback({ active: true, t: Date.now() });

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const layers = useArgusStore((s) => s.layers);
  const order = useArgusStore((s) => s.order);
  const view = useArgusStore((s) => s.view);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQ("");
        setIdx(0);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const st = useArgusStore.getState();

  const focusPlace = async (name: string) => {
    const shape = await resolvePlace({ name, label: name });
    if (!shape) return;
    st.addShape(shape, false);
    if (shape.kind === "country" && shape.ref) {
      void eezShape(shape.ref).then((z) => z && useArgusStore.getState().addShape(z, true));
    }
    const bb = primaryBbox(shape.geometry) ?? useArgusStore.getState().aoi?.bbox;
    if (bb) layerManager.fitBbox(bb, { pitch: 0 });
  };

  const actions = useMemo<Action[]>(() => {
    const base: Action[] = [
      ...order.map((id) => ({
        id: `layer:${id}`,
        label: `${layers[id]?.enabled ? "Disable" : "Enable"} ${layers[id]?.label ?? id}`,
        hint: "layer",
        run: () => layerManager.toggleLayer(id, !layers[id]?.enabled),
      })),
      ...(["dark", "light", "satellite"] as const).map((b) => ({
        id: `skin:${b}`,
        label: `Skin: ${b}`,
        hint: view.basemap === b ? "active" : "skin",
        run: () => st.setView({ basemap: b }),
      })),
      { id: "unfocus", label: "Unfocus (clear selection)", hint: "focus", run: () => st.clearSelection() },
      { id: "replay", label: "Replay last 24h", hint: "time", run: startReplay },
      { id: "settings", label: "Open settings", hint: "ui", run: () => st.setSettingsTab("appearance") },
      { id: "settings-ai", label: "Open AI settings", hint: "ui", run: () => st.setSettingsTab("ai") },
    ];
    const needle = q.trim().toLowerCase();
    const matched = needle ? base.filter((a) => a.label.toLowerCase().includes(needle)) : base;
    // free-text fallbacks: focus <query> and ask <query>
    if (needle) {
      matched.push({
        id: "focus-free",
        label: `Focus "${q.trim()}"`,
        hint: "search",
        run: () => void focusPlace(q.trim()),
      });
      matched.push({
        id: "ask-free",
        label: `Ask Argus: "${q.trim()}"`,
        hint: "agent",
        run: () => {
          window.dispatchEvent(new CustomEvent("argus:ask", { detail: q.trim() }));
        },
      });
    }
    return matched.slice(0, 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, order, layers, view.basemap]);

  if (!open) return null;

  const runAction = (a: Action) => {
    setOpen(false);
    void a.run();
  };

  return (
    <div className="pointer-events-auto absolute inset-0 z-50 flex items-start justify-center pt-[18vh]" onClick={() => setOpen(false)}>
      <div className="panel w-[480px] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => (i + 1) % actions.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => (i <= 0 ? actions.length - 1 : i - 1));
            } else if (e.key === "Enter" && actions[idx]) {
              runAction(actions[idx]);
            }
          }}
          placeholder="Type a command — focus tokyo · enable fires · dark · ask…"
          className="w-full border-b border-[var(--color-hairline)] bg-transparent px-4 py-3 text-[13px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
        />
        <div className="thin-scroll max-h-[300px] overflow-y-auto py-1">
          {actions.map((a, i) => (
            <button
              key={a.id}
              onMouseEnter={() => setIdx(i)}
              onClick={() => runAction(a)}
              className="flex w-full items-center justify-between px-4 py-2 text-left text-[12px]"
              style={{ background: i === idx ? "color-mix(in srgb, var(--color-accent) 14%, transparent)" : "transparent" }}
            >
              <span className="text-[var(--color-text)]">{a.label}</span>
              <span className="label">{a.hint}</span>
            </button>
          ))}
        </div>
        <div className="border-t border-[var(--color-hairline)] px-4 py-1.5 text-[10px] text-[var(--color-faint)]">
          ↑↓ navigate · ↵ run · esc close
        </div>
      </div>
    </div>
  );
}
