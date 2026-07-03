"use client";

import { useArgusStore } from "@/src/store/useArgusStore";

/**
 * Bottom-left status strip: names every layer currently doing its first fetch,
 * so the user always sees "something is happening" rather than empty ground
 * while data streams in. Disappears once nothing is loading.
 */
export default function SyncIndicator() {
  const layers = useArgusStore((s) => s.layers);
  const order = useArgusStore((s) => s.order);
  const loading = order
    .map((id) => layers[id])
    .filter((l) => l && l.enabled && l.status === "loading");

  if (loading.length === 0) return null;

  return (
    <div className="panel pointer-events-none absolute bottom-5 left-1/2 flex -translate-x-1/2 translate-y-[-52px] items-center gap-2.5 px-3 py-1.5">
      <span className="argus-spinner" />
      <span className="label !text-[var(--color-accent)]">syncing</span>
      <span className="text-[11px] tracking-wide text-[var(--color-muted)]">
        {loading.map((l) => l!.label).join(" · ")}
      </span>
    </div>
  );
}
