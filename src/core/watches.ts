import type { Map as MlMap } from "maplibre-gl";
import { useArgusStore } from "@/src/store/useArgusStore";

// Watch rules: scan rendered features every minute; a NEW feature matching a
// rule (layer + severity ≥ min) fires a browser notification while the tab is
// open. Seen-set is in-memory — a reload re-baselines quietly (no re-notify
// storm because the first scan after load only baselines).

const seen = new Set<string>();
let baselined = false;

function scan(map: MlMap): void {
  const st = useArgusStore.getState();
  if (!st.watches.length) return;
  const fresh: { title: string; layer: string }[] = [];
  for (const w of st.watches) {
    let feats;
    try {
      feats = map.querySourceFeatures(`${w.layerId}-src`);
    } catch {
      continue;
    }
    for (const f of feats) {
      const p = f.properties ?? {};
      if (p.point_count) continue;
      if ((Number(p.severity) || 0) < w.minSeverity) continue;
      const key = `${w.layerId}:${String(p.id ?? p.title ?? "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (baselined) {
        fresh.push({ title: String(p.title ?? "Event"), layer: st.layers[w.layerId]?.label ?? w.layerId });
      }
    }
  }
  baselined = true;
  if (!fresh.length) return;
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    for (const f of fresh.slice(0, 3)) {
      new Notification(`ARGUS · ${f.layer}`, { body: f.title, silent: false });
    }
  }
}

export function initWatches(map: MlMap): void {
  setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    scan(map);
  }, 60_000);
}

/** Ask for notification permission when the first rule is created. */
export function requestNotifyPermission(): void {
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission();
  }
}
