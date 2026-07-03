// Resolve a place to its REAL boundary polygon (not a bbox). Keyless via
// Nominatim `polygon_geojson=1`. Three lookup modes — by osm id, by free text,
// or by ground point (reverse) — plus a best-effort EEZ (maritime) branch via
// Marine Regions. Geometry is Douglas–Peucker simplified so the focus mask and
// highlight stay cheap even for high-detail coastlines.
import type { Polygon, MultiPolygon, Position } from "geojson";
import { upstreamJson } from "@/src/core/upstream";
import { geometryBbox } from "@/src/core/bbox";

export const dynamic = "force-dynamic";

interface NomItem {
  display_name?: string;
  name?: string;
  type?: string;
  addresstype?: string;
  geojson?: { type: string; coordinates: unknown };
}

const NOM = "https://nominatim.openstreetmap.org";

/** Perpendicular-distance Douglas–Peucker on a lng/lat ring. */
function simplifyRing(ring: Position[], tol: number): Position[] {
  if (ring.length < 5) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let maxD = 0,
      idx = -1;
    const [ax, ay] = ring[lo];
    const [bx, by] = ring[hi];
    const dx = bx - ax,
      dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    for (let i = lo + 1; i < hi; i++) {
      const [px, py] = ring[i];
      const t = ((px - ax) * dx + (py - ay) * dy) / len2;
      const cx = ax + t * dx,
        cy = ay + t * dy;
      const d = (px - cx) ** 2 + (py - cy) ** 2;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx > 0 && maxD > tol * tol) {
      keep[idx] = 1;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

function simplify(geom: Polygon | MultiPolygon, tol = 0.01): Polygon | MultiPolygon {
  if (geom.type === "Polygon") {
    return { type: "Polygon", coordinates: geom.coordinates.map((r) => simplifyRing(r, tol)) };
  }
  return {
    type: "MultiPolygon",
    coordinates: geom.coordinates.map((poly) => poly.map((r) => simplifyRing(r, tol))),
  };
}

function asPolygon(g: NomItem["geojson"]): Polygon | MultiPolygon | null {
  if (!g) return null;
  if (g.type === "Polygon" || g.type === "MultiPolygon") return g as unknown as Polygon | MultiPolygon;
  return null; // Point/LineString places have no area to focus
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const q = sp.get("q")?.trim();
  const osmId = sp.get("osmId")?.trim();
  const osmType = sp.get("osmType")?.trim(); // R | W | N
  const lat = sp.get("lat");
  const lon = sp.get("lon");
  const eez = sp.get("eez")?.trim();

  try {
    // ── EEZ (maritime control) — best effort via Marine Regions ──
    if (eez) {
      const geom = await eezFor(eez);
      if (!geom) return Response.json({ error: "no eez" }, { status: 404 });
      const s = simplify(geom, 0.05);
      return Response.json(
        { label: `${eez} EEZ`, geometry: s, bbox: geometryBbox(s) },
        { headers: { "Cache-Control": "s-maxage=604800" } },
      );
    }

    let url: string;
    if (osmId && osmType) {
      url = `${NOM}/lookup?osm_ids=${osmType}${osmId}&polygon_geojson=1&format=jsonv2`;
    } else if (lat && lon) {
      const rz = Number(sp.get("rzoom")) || 8; // Nominatim admin level (3=country…14=suburb)
      url = `${NOM}/reverse?lat=${lat}&lon=${lon}&polygon_geojson=1&format=jsonv2&zoom=${rz}`;
    } else if (q) {
      // limit=5, not 1: an informal region's top hit is often a Point (e.g.
      // "Horn of Africa" peninsula) while a lower hit is the real admin polygon.
      url = `${NOM}/search?q=${encodeURIComponent(q)}&polygon_geojson=1&format=jsonv2&limit=5`;
    } else {
      return Response.json({ error: "need q, osmId+osmType, or lat+lon" }, { status: 400 });
    }

    const data = await upstreamJson<NomItem | NomItem[]>(url, { minGapMs: 1000, timeoutMs: 9000 });
    const list = Array.isArray(data) ? data : [data];
    // pick the first result that actually has an area (skip Point/LineString hits)
    const item = list.find((it) => asPolygon(it?.geojson)) ?? list[0];
    const poly = asPolygon(item?.geojson);
    if (!item || !poly) return Response.json({ error: "no polygon" }, { status: 404 });
    const geometry = simplify(poly);
    return Response.json(
      {
        label: item.name || item.display_name?.split(",")[0] || "Area",
        displayName: item.display_name ?? "",
        kind: item.addresstype || item.type || "place",
        geometry,
        bbox: geometryBbox(geometry),
      },
      { headers: { "Cache-Control": "s-maxage=604800" } },
    );
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}

/** Marine Regions: name → MRGID → EEZ geometry (GeoJSON). Returns null on any miss. */
async function eezFor(country: string): Promise<Polygon | MultiPolygon | null> {
  try {
    const recs = await upstreamJson<{ MRGID?: number; preferredGazetteerName?: string; placeType?: string }[]>(
      `https://marineregions.org/rest/getGazetteerRecordsByName.json/${encodeURIComponent(
        country + " Exclusive Economic Zone",
      )}/true/false/`,
      { minGapMs: 1000, timeoutMs: 9000, headers: { Accept: "application/json" } },
    );
    const rec = recs.find((r) => /economic zone/i.test(r.placeType ?? "")) ?? recs[0];
    if (!rec?.MRGID) return null;
    const geo = await upstreamJson<{ type: string; coordinates?: unknown; geometries?: unknown }>(
      `https://marineregions.org/rest/getGazetteerGeometries.jsonld/${rec.MRGID}/`,
      { minGapMs: 1000, timeoutMs: 12000, headers: { Accept: "application/json" } },
    );
    return asPolygon(geo as NomItem["geojson"]);
  } catch {
    return null;
  }
}
