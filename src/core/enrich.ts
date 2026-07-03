import type { Map as MlMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { EntityInfo } from "@/src/store/useArgusStore";

// On-demand enrichment for a clicked event: where it is, what's being reported
// nearby, and similar events from the same layer. Fetched ONLY when a panel
// opens (progressive loading — nothing is preloaded).

export interface EntityEnrichment {
  where: { label: string; weather: string } | null;
  news: { title: string; domain: string; url: string }[];
  similar: { title: string; center: [number, number]; km: number }[];
}

// one shared GDELT snapshot for enrichment lookups (route is edge-cached 15 min)
let gdeltMemo: { t: number; fc: FeatureCollection } | null = null;
async function gdeltSnapshot(): Promise<FeatureCollection | null> {
  if (gdeltMemo && Date.now() - gdeltMemo.t < 10 * 60_000) return gdeltMemo.fc;
  try {
    const r = await fetch("/api/gdelt");
    if (!r.ok) return null;
    const fc = (await r.json()) as FeatureCollection;
    gdeltMemo = { t: Date.now(), fc };
    return fc;
  } catch {
    return null;
  }
}

const kmBetween = (a: [number, number], b: [number, number]) => {
  const dLat = (b[1] - a[1]) * 111;
  const dLon = (b[0] - a[0]) * 111 * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return Math.sqrt(dLat * dLat + dLon * dLon);
};

/** Short "City, Country" from a Nominatim display_name. */
function shortAddress(display: string): string {
  const parts = display.split(",").map((s) => s.trim());
  if (parts.length <= 2) return display;
  return `${parts[0]}, ${parts[parts.length - 1]}`;
}

async function whereContext(e: EntityInfo): Promise<EntityEnrichment["where"]> {
  try {
    const r = await fetch(`/api/place?lat=${e.center[1]}&lon=${e.center[0]}&zoom=8`);
    if (!r.ok) return null;
    const d = (await r.json()) as {
      address?: string;
      weather?: { temp?: number; desc?: string };
    };
    return {
      label: d.address ? shortAddress(d.address) : "",
      weather: d.weather?.temp != null ? `${d.weather.temp}°C · ${d.weather.desc ?? ""}` : "",
    };
  } catch {
    return null;
  }
}

async function nearbyNews(e: EntityInfo): Promise<EntityEnrichment["news"]> {
  const fc = await gdeltSnapshot();
  if (!fc) return [];
  const scored: { title: string; domain: string; url: string; mentions: number; km: number }[] = [];
  for (const f of fc.features) {
    if (f.geometry?.type !== "Point") continue;
    const p = f.properties ?? {};
    const url = String(p.url ?? "");
    if (!url || url === e.url) continue;
    const km = kmBetween(e.center, f.geometry.coordinates as [number, number]);
    if (km > 200) continue;
    scored.push({
      title: String(p.place ?? "Reported event"),
      domain: String(p.domain ?? ""),
      url,
      mentions: Number(p.mentions) || 1,
      km,
    });
  }
  return scored
    .sort((a, b) => b.mentions - a.mentions || a.km - b.km)
    .slice(0, 4);
}

function similarEvents(e: EntityInfo, map: MlMap | undefined): EntityEnrichment["similar"] {
  if (!map) return [];
  const out: EntityEnrichment["similar"] = [];
  const seen = new Set<string>([e.title]);
  try {
    for (const f of map.querySourceFeatures(`${e.layerId}-src`)) {
      const p = f.properties ?? {};
      if (p.point_count) continue;
      const title = String(p.title ?? p.name ?? "").trim();
      if (!title || seen.has(title)) continue;
      if (f.geometry.type !== "Point") continue;
      const center = f.geometry.coordinates as [number, number];
      const km = kmBetween(e.center, center);
      seen.add(title);
      out.push({ title, center, km: Math.round(km) });
    }
  } catch {
    /* source not rendered */
  }
  return out.sort((a, b) => a.km - b.km).slice(0, 3);
}

export async function enrichEntity(e: EntityInfo, map: MlMap | undefined): Promise<EntityEnrichment> {
  const [where, news] = await Promise.all([whereContext(e), nearbyNews(e)]);
  return { where, news, similar: similarEvents(e, map) };
}
