"use client";

import { useEffect, useState } from "react";
import { useArgusStore } from "@/src/store/useArgusStore";

// One thin Gotham status line, top-right: UTC clock · live layers · feature
// count · degraded feeds · ⚙ settings. Replaces the old SystemPanel.
export default function StatusStrip() {
  const layers = useArgusStore((s) => s.layers);
  const order = useArgusStore((s) => s.order);
  const viewport = useArgusStore((s) => s.viewport);
  const setSettingsTab = useArgusStore((s) => s.setSettingsTab);
  const settingsTab = useArgusStore((s) => s.settingsTab);
  const playback = useArgusStore((s) => s.playback);
  const setPlayback = useArgusStore((s) => s.setPlayback);
  const [now, setNow] = useState("");

  useEffect(() => {
    const tick = () => setNow(new Date().toISOString().slice(11, 19));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  const live = order.filter((id) => layers[id]?.enabled);
  const count = live.reduce((n, id) => n + (layers[id]?.count ?? 0), 0);
  const down = live.filter((id) => layers[id]?.status === "down").length;

  return (
    <div className="panel pointer-events-auto absolute right-5 top-5 flex h-9 items-center gap-3 px-3">
      <span className="tnum text-[11px] text-[var(--color-muted)]" suppressHydrationWarning>{now}Z</span>
      <span className="h-3 w-px bg-[var(--color-hairline)]" />
      <span className="tnum text-[11px] text-[var(--color-muted)]">
        {live.length} layers{count > 0 ? ` · ${count >= 1000 ? `${(count / 1000).toFixed(1)}k` : count}` : ""}
      </span>
      {viewport && (
        <>
          <span className="h-3 w-px bg-[var(--color-hairline)]" />
          <span className="tnum text-[11px] text-[var(--color-faint)]">z{viewport.zoom.toFixed(1)}</span>
        </>
      )}
      {down > 0 && (
        <span className="text-[11px] text-[var(--color-alert)]" title={`${down} feed(s) degraded`}>⚠ {down}</span>
      )}
      <span className="h-3 w-px bg-[var(--color-hairline)]" />
      <button
        onClick={() => setPlayback({ active: !playback.active, t: Date.now() })}
        className="text-[12px] transition-colors"
        style={{ color: playback.active ? "var(--color-accent)" : "var(--color-muted)" }}
        title="Replay last 24h"
      >
        ◷
      </button>
      <button
        onClick={() => setSettingsTab(settingsTab ? null : "appearance")}
        className="text-[13px] transition-colors"
        style={{ color: settingsTab ? "var(--color-accent)" : "var(--color-muted)" }}
        title="Settings"
      >
        ⚙
      </button>
    </div>
  );
}
