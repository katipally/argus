import type { Map as MlMap } from "maplibre-gl";
import { useArgusStore } from "@/src/store/useArgusStore";
import { buildSitrep } from "./sitrep";

// Export what's on screen: rendered features of every enabled layer as GeoJSON,
// or the current sitrep as a markdown brief. Pure client-side Blob downloads.

function download(name: string, mime: string, text: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "area";

/** Download every enabled layer's rendered features. Returns feature count. */
export function exportGeoJSON(map: MlMap): number {
  const s = useArgusStore.getState();
  const seen = new Set<string>();
  const features: GeoJSON.Feature[] = [];
  for (const id of s.order) {
    if (!s.layers[id]?.enabled) continue;
    let feats;
    try {
      feats = map.querySourceFeatures(`${id}-src`);
    } catch {
      continue;
    }
    for (const f of feats) {
      const p = f.properties ?? {};
      if (p.point_count) continue; // cluster bubbles aren't data
      // querySourceFeatures duplicates across tiles — dedupe by identity
      const key = `${id}:${String(p.id ?? p.title ?? JSON.stringify(f.geometry))}`;
      if (seen.has(key)) continue;
      seen.add(key);
      features.push({ type: "Feature", geometry: f.geometry, properties: { ...p, argusLayer: id } });
    }
  }
  download(
    `argus-${slug(s.aoi?.label ?? "view")}-${stamp()}.geojson`,
    "application/geo+json",
    JSON.stringify({ type: "FeatureCollection", features }),
  );
  return features.length;
}

/** Download the current situation report as a markdown brief. */
export function exportBrief(map: MlMap): void {
  const s = useArgusStore.getState();
  const rep = buildSitrep(map);
  const lines = [
    `# ARGUS sitrep — ${s.aoi?.label ?? "no area set"}`,
    ``,
    `Generated ${new Date().toISOString()} · share link: ${window.location.href}`,
    ``,
    `## Layers`,
    ...rep.layers.map((l) => `- ${l.label}: ${l.count} (${l.status})`),
  ];
  if (rep.topEvents.length) {
    lines.push(``, `## Top events`);
    lines.push(...rep.topEvents.map((e) => `- **${e.title}** — ${e.layerLabel}, severity ${e.severity} @ ${e.center[1].toFixed(3)}, ${e.center[0].toFixed(3)}`));
  }
  if (rep.headlines.length) {
    lines.push(``, `## Headlines`);
    lines.push(...rep.headlines.map((h) => `- ${h.title}${h.url ? ` (${h.url})` : ""}`));
  }
  if (rep.cameras.length) {
    lines.push(``, `## Nearest cameras`);
    lines.push(...rep.cameras.map((c) => `- ${c.title}`));
  }
  download(`argus-brief-${slug(s.aoi?.label ?? "view")}-${stamp()}.md`, "text/markdown", lines.join("\n"));
}
