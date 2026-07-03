"use client";

import { useState } from "react";
import { useArgusStore } from "@/src/store/useArgusStore";
import { layerManager } from "@/src/layers/registry";

const STATUS: Record<string, string> = {
  live: "var(--color-live)",
  cached: "var(--color-warn)",
  loading: "var(--color-accent)",
  down: "var(--color-alert)",
  idle: "#2b333d",
};

const GROUPS: [string, string][] = [
  ["earth", "Earth"],
  ["sky", "Sky"],
  ["signals", "Signals"],
  ["movement", "Movement"],
  ["ground", "Ground"],
];

export default function LayerRail() {
  const order = useArgusStore((s) => s.order);
  const layers = useArgusStore((s) => s.layers);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggle = (id: string, enabled: boolean) => {
    layerManager.toggleLayer(id, !enabled);
  };

  return (
    <div className="panel pointer-events-auto w-full shrink-0 overflow-hidden">
      <div className="panel-head">
        <span className="label">Layers</span>
        <span className="label tnum">{order.filter((id) => layers[id]?.enabled).length}/{order.length}</span>
      </div>
      {GROUPS.map(([group, title]) => {
        const ids = order.filter((id) => layers[id]?.group === group);
        if (!ids.length) return null;
        const isOpen = !collapsed[group];
        const liveCount = ids.reduce((n, id) => n + (layers[id]?.enabled ? layers[id].count : 0), 0);
        return (
          <div key={group}>
            <button
              onClick={() => setCollapsed((c) => ({ ...c, [group]: !c[group] }))}
              className="flex w-full items-center gap-2 border-b border-[var(--color-hairline)] bg-white/[0.02] px-3 py-1.5 text-left"
            >
              <span className="text-[9px] text-[var(--color-faint)]">{isOpen ? "▾" : "▸"}</span>
              <span className="label flex-1" style={{ color: "var(--color-muted)" }}>{title}</span>
              {!isOpen && (
                <span className="label tnum">
                  {ids.filter((id) => layers[id]?.enabled).length ? `${ids.filter((id) => layers[id]?.enabled).length} on${liveCount ? ` · ${liveCount.toLocaleString()}` : ""}` : ids.length}
                </span>
              )}
            </button>
            {isOpen &&
              ids.map((id) => {
                const l = layers[id];
                if (!l) return null;
                return (
                  <button
                    key={id}
                    onClick={() => toggle(id, l.enabled)}
                    className="group flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-white/[0.035]"
                  >
                    <span
                      className="h-5 w-[2px] transition-colors"
                      style={{ background: l.enabled ? l.color : "#2b333d" }}
                    />
                    <span
                      className="flex-1 text-[12px] font-medium tracking-wide"
                      style={{ color: l.enabled ? "var(--color-text)" : "var(--color-faint)" }}
                    >
                      {l.label}
                    </span>
                    {l.enabled && l.status === "loading" ? (
                      <span className="argus-pulse text-[9px] uppercase tracking-wider text-[var(--color-accent)]">
                        syncing
                      </span>
                    ) : l.enabled && l.status === "idle" && l.note ? (
                      <span
                        title={l.note}
                        className="max-w-[120px] truncate text-[9px] uppercase tracking-wider text-[var(--color-warn,#ffb020)]"
                      >
                        {l.note}
                      </span>
                    ) : l.enabled && l.count === 0 && (l.status === "live" || l.status === "cached") ? (
                      <span className="text-[9px] uppercase tracking-wider text-[var(--color-faint)]">
                        none
                      </span>
                    ) : l.enabled && l.status === "down" ? (
                      <span className="text-[9px] uppercase tracking-wider text-[var(--color-alert)]">
                        down
                      </span>
                    ) : (
                      <span className="tnum text-[10px] text-[var(--color-faint)]">
                        {l.count > 0 ? l.count.toLocaleString() : ""}
                      </span>
                    )}
                    {l.enabled && l.status === "loading" ? (
                      <span className="argus-spinner" title="fetching…" />
                    ) : (
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: l.enabled ? (STATUS[l.status] ?? STATUS.idle) : "#2b333d" }}
                        title={l.note ? `${l.status} · ${l.note}` : l.status}
                      />
                    )}
                  </button>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
