import type { AgentTool } from "../engine/runner";
import { layerManager } from "@/src/layers/registry";
import { useArgusStore, type Filters } from "@/src/store/useArgusStore";
import { argusCommands } from "../commands";
import { buildSitrep } from "@/src/core/sitrep";
import { resolveArea } from "@/src/geo/resolve";
import { readEntities, describeEntity, matchEntity, MOVEMENT_LAYERS, type Cond } from "../entities";
import { startTrack, stopTrack, isTracking } from "../track";
import { requestNotifyPermission } from "@/src/core/watches";

// The Argus tool surface: everything the user can do by hand, callable by the
// agent. Tools act on the live LayerManager/store/map in the browser and
// return raw strings/JSON for the model — never invented data.

const w = () => window as unknown as { argusMap?: import("maplibre-gl").Map };

async function geocode(place: string): Promise<{ name: string; lng: number; lat: number } | null> {
  const hits = await argusCommands.searchPlace(place);
  return hits[0] ?? null;
}

function sampleFeatures(layerId: string, n = 8): string[] {
  const map = w().argusMap;
  if (!map) return [];
  try {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const f of map.querySourceFeatures(`${layerId}-src`)) {
      const p = f.properties ?? {};
      if (p.point_count) continue;
      const title = String(p.title ?? p.name ?? p.place ?? p.label ?? p.flight ?? "").trim();
      if (title && !seen.has(title)) {
        seen.add(title);
        out.push(title);
        if (out.length >= n) break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

const str = (v: unknown) => String(v ?? "");
const dist2 = (a: [number, number], b: [number, number]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const scalarProps = (p: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(p).filter(([k, v]) => k !== "id" && v != null && typeof v !== "object" && v !== ""));

// ── map & camera control ────────────────────────────────────────────────────
const mapTools: AgentTool[] = [
  {
    name: "set_area",
    description:
      "Focus any named place by its REAL boundary — a country, state/province, city, sea/gulf, OR an informal region (e.g. 'the Balkans', 'Middle East', 'Horn of Africa', 'Scandinavia'). Replaces the current selection and fits the camera. This is the RIGHT way to focus a region — never draw_box for a named place. Most layers stream once an area is set. Use add_to_selection to add more shapes.",
    parameters: { type: "object", properties: { place: { type: "string" } }, required: ["place"] },
    async run({ place }) {
      const shape = await resolveArea(str(place));
      if (!shape) return `Could not resolve a boundary for "${place}". Try a more specific or nearby named place — do NOT fall back to draw_box for a named region.`;
      useArgusStore.getState().addShape(shape, false);
      const bb = useArgusStore.getState().aoi?.bbox;
      if (bb) layerManager.fitBbox(bb, { pitch: 0 });
      return `Focused ${shape.label} (real boundary). Layers now stream for this area.`;
    },
  },
  {
    name: "add_to_selection",
    description: "Add another named place's real boundary to the current selection (multi-select). Same resolver as set_area (countries, states, cities, seas, informal regions). Does not replace existing shapes.",
    parameters: { type: "object", properties: { place: { type: "string" } }, required: ["place"] },
    async run({ place }) {
      const shape = await resolveArea(str(place));
      if (!shape) return `Could not resolve a boundary for "${place}".`;
      useArgusStore.getState().addShape(shape, true);
      const bb = useArgusStore.getState().aoi?.bbox;
      if (bb) layerManager.fitBbox(bb);
      return `Added ${shape.label} to the selection (${useArgusStore.getState().selection.length} shapes).`;
    },
  },
  {
    name: "clear_selection",
    description: "Clear all selected areas (return to a clean globe).",
    parameters: { type: "object", properties: {} },
    async run() {
      useArgusStore.getState().clearSelection();
      return "Selection cleared.";
    },
  },
  {
    name: "draw_box",
    description:
      "Focus an exact rectangle (west,south,east,north in degrees). ONLY for a deliberate custom bounding box the user gave in coordinates, or a corridor with no name. NEVER use this to focus a named place or region — use set_area (it resolves countries, states, cities, seas, and informal regions to real boundaries).",
    parameters: {
      type: "object",
      properties: {
        west: { type: "number" }, south: { type: "number" }, east: { type: "number" }, north: { type: "number" },
        label: { type: "string" },
      },
      required: ["west", "south", "east", "north"],
    },
    async run(i) {
      const w2 = Number(i.west), s = Number(i.south), e = Number(i.east), n = Number(i.north);
      if ([w2, s, e, n].some((v) => !Number.isFinite(v))) return "Invalid bbox.";
      const ring: [number, number][] = [[w2, s], [e, s], [e, n], [w2, n], [w2, s]];
      useArgusStore.getState().addShape(
        { id: `box:${w2},${s},${e},${n}`, kind: "box", label: str(i.label) || "Agent box", geometry: { type: "Polygon", coordinates: [ring] } },
        false,
      );
      const bb = useArgusStore.getState().aoi?.bbox;
      if (bb) layerManager.fitBbox(bb);
      return `Focused box ${JSON.stringify({ west: w2, south: s, east: e, north: n })}.`;
    },
  },
  {
    name: "fly_to",
    description: "Move the camera to a named place without changing the area of interest.",
    parameters: {
      type: "object",
      properties: { place: { type: "string" }, zoom: { type: "number" }, pitch: { type: "number" } },
      required: ["place"],
    },
    async run({ place, zoom, pitch }) {
      const hit = await geocode(str(place));
      if (!hit) return `Could not locate "${place}".`;
      argusCommands.flyTo(hit.lng, hit.lat, typeof zoom === "number" ? zoom : 9, typeof pitch === "number" ? pitch : 0);
      return `Flew to ${hit.name}.`;
    },
  },
  {
    name: "set_view",
    description:
      "Change map presentation. basemap/skin: dark|light|satellite · projection: globe|mercator · terrain/labels/buildings/daynight: booleans.",
    parameters: {
      type: "object",
      properties: {
        basemap: { type: "string", enum: ["dark", "light", "satellite"] },
        projection: { type: "string", enum: ["globe", "mercator"] },
        terrain: { type: "boolean" },
        labels: { type: "boolean" },
        buildings: { type: "boolean" },
        daynight: { type: "boolean" },
      },
    },
    async run(input) {
      const patch: Record<string, unknown> = {};
      for (const k of ["basemap", "projection", "terrain", "labels", "buildings", "daynight"]) {
        if (input[k] !== undefined) patch[k] = input[k];
      }
      useArgusStore.getState().setView(patch);
      return `View updated: ${JSON.stringify(patch)}.`;
    },
  },
  {
    name: "set_time",
    description: "Set the day/night terminator clock. iso: an ISO datetime to freeze at, or omit/null to follow live time. Enables day/night shading.",
    parameters: { type: "object", properties: { iso: { type: "string" } } },
    async run({ iso }) {
      const ms = iso ? Date.parse(str(iso)) : NaN;
      useArgusStore.getState().setView({ daynight: true, clockMs: Number.isFinite(ms) ? ms : null });
      return iso && Number.isFinite(ms) ? `Time set to ${iso}.` : "Following live time.";
    },
  },
  {
    name: "open_detail_modal",
    description: "Open the detail workspace (place overview · live events · agent hand-off) for a named place or lat/lon.",
    parameters: { type: "object", properties: { place: { type: "string" }, lat: { type: "number" }, lon: { type: "number" } } },
    async run({ place, lat, lon }) {
      let la = Number(lat), lo = Number(lon);
      if (!Number.isFinite(la) || !Number.isFinite(lo)) {
        const hit = place ? await geocode(str(place)) : null;
        if (!hit) return `Could not locate "${place}".`;
        la = hit.lat; lo = hit.lng;
      }
      useArgusStore.getState().setPlace({ lat: la, lon: lo });
      useArgusStore.getState().setDetailOpen(true);
      return `Opened detail workspace at ${la.toFixed(3)}, ${lo.toFixed(3)}.`;
    },
  },
];

// ── layers ──────────────────────────────────────────────────────────────────
const layerTools: AgentTool[] = [
  {
    name: "list_layers",
    description: "List all data layers with id, label, enabled state, live count, and status.",
    parameters: { type: "object", properties: {} },
    async run() {
      return JSON.stringify(argusCommands.listLayers());
    },
  },
  {
    name: "toggle_layer",
    description: "Turn a data layer on or off by id (from list_layers).",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, on: { type: "boolean" } },
      required: ["id", "on"],
    },
    async run({ id, on }) {
      argusCommands.toggleLayer(str(id), Boolean(on));
      return `Layer ${id} ${on ? "enabled" : "disabled"}.`;
    },
  },
  {
    name: "query_layer",
    description: "Current count, status, and sample entities for one layer in the active area.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run({ id }) {
      const layer = argusCommands.listLayers().find((l) => l.id === str(id));
      if (!layer) return `No layer "${id}".`;
      return JSON.stringify({ ...layer, sample: sampleFeatures(str(id)) });
    },
  },
  {
    name: "set_filter",
    description:
      'Adjust a layer\'s VISUAL filter (hides non-matching dots on the map). Filterable: earthquakes {minMag}, planes {minAlt,maxAlt,category:"all|mil|civ"}, ships {category (e.g. "Cargo"|"Tanker"|"Passenger"|"Fishing"|"all"), minSpeed}, disasters {types,alerts}, hazards {categories}, radar {opacity}. To filter/count layers WITHOUT a visual filter, use query_entities instead.',
    parameters: {
      type: "object",
      properties: { layer: { type: "string" }, patch: { type: "object" } },
      required: ["layer", "patch"],
    },
    async run({ layer, patch }) {
      const key = str(layer) as keyof Filters;
      const filters = useArgusStore.getState().filters;
      if (!(key in filters)) return `Layer "${layer}" has no filters. Filterable: ${Object.keys(filters).join(", ")}.`;
      useArgusStore.getState().setFilter(key, patch as Partial<Filters[typeof key]>);
      return `Filter for ${key} updated: ${JSON.stringify(patch)}.`;
    },
  },
];

// ── situational awareness ───────────────────────────────────────────────────
const sitrepTools: AgentTool[] = [
  {
    name: "situation_report",
    description: "Full structured report for the current area: per-layer counts/status, severity-ranked top events, headlines, nearest cameras.",
    parameters: { type: "object", properties: {} },
    async run() {
      const map = w().argusMap;
      if (!map) return "Map not ready.";
      const aoi = useArgusStore.getState().aoi;
      const rep = buildSitrep(map);
      return JSON.stringify({
        area: aoi?.label ?? "none set",
        layers: rep.layers.map((l) => ({ id: l.id, label: l.label, count: l.count, status: l.status })),
        topEvents: rep.topEvents.map((e) => ({ layer: e.layerLabel, title: e.title, severity: e.severity, lngLat: e.center })),
        headlines: rep.headlines.map((h) => h.title),
        cameras: rep.cameras.map((c) => c.title),
      });
    },
  },
  {
    name: "area_headlines",
    description: "Latest news headlines rendered in the current area (news layer must be on).",
    parameters: { type: "object", properties: {} },
    async run() {
      const titles = sampleFeatures("news", 12);
      return titles.length ? JSON.stringify(titles) : "No headlines — is the news layer on and an area set?";
    },
  },
  {
    name: "nearest_cameras",
    description: "Live cameras nearest the current area center (traffic cams / webcams layers must be on).",
    parameters: { type: "object", properties: {} },
    async run() {
      const map = w().argusMap;
      if (!map) return "Map not ready.";
      const rep = buildSitrep(map);
      return rep.cameras.length
        ? JSON.stringify(rep.cameras.map((c) => ({ title: c.title, lngLat: c.center, hasStream: !!c.streamUrl })))
        : "No cameras rendered — enable the cameras/webcams layer and set an area.";
    },
  },
];

// ── data lookups ────────────────────────────────────────────────────────────
const dataTools: AgentTool[] = [
  {
    name: "place_info",
    description: "Encyclopedic + weather brief for a named place (Wikipedia, address, current conditions).",
    parameters: { type: "object", properties: { place: { type: "string" } }, required: ["place"] },
    async run({ place }) {
      const hit = await geocode(str(place));
      if (!hit) return `Could not locate "${place}".`;
      const r = await fetch(`/api/place?lat=${hit.lat}&lon=${hit.lng}`);
      if (!r.ok) return `No place data for ${hit.name}.`;
      const d = await r.json();
      return JSON.stringify({ name: hit.name, wiki: d.wiki?.extract ?? "", address: d.address, weather: d.weather });
    },
  },
  {
    name: "geocode_place",
    description: "Resolve a place name to coordinates without moving the camera.",
    parameters: { type: "object", properties: { place: { type: "string" } }, required: ["place"] },
    async run({ place }) {
      const hit = await geocode(str(place));
      return hit ? JSON.stringify(hit) : `Could not locate "${place}".`;
    },
  },
];

// ── cameras ─────────────────────────────────────────────────────────────────
const cameraTools: AgentTool[] = [
  {
    name: "open_camera",
    description: "Open the live view of a rendered camera whose name matches the query (cameras/webcams layer must be on).",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run({ query }) {
      const map = w().argusMap;
      if (!map) return "Map not ready.";
      const q = str(query).toLowerCase();
      for (const layerId of ["cameras", "webcams"]) {
        try {
          for (const f of map.querySourceFeatures(`${layerId}-src`)) {
            const p = f.properties ?? {};
            const label = String(p.label ?? "");
            if (!label.toLowerCase().includes(q)) continue;
            const g = f.geometry;
            if (g.type !== "Point") continue;
            const center: [number, number] = [g.coordinates[0], g.coordinates[1]];
            useArgusStore.getState().setSelected({
              layerId,
              title: label,
              subtitle: `${String(p.provider ?? "")} · live`,
              rows: [["Source", String(p.provider ?? "—")]],
              color: "#7dd3fc",
              center,
              imageUrl: String(p.imageUrl ?? ""),
              streamUrl: p.streamUrl ? String(p.streamUrl) : undefined,
              embedUrl: p.embedUrl ? String(p.embedUrl) : undefined,
            });
            layerManager.flyTo({ center, zoom: 13 });
            return `Opened camera "${label}" — live view is on screen.`;
          }
        } catch {
          /* layer not rendered */
        }
      }
      return `No rendered camera matches "${query}". Enable the cameras layer, set an area, or try another name.`;
    },
  },
];

// ── entities: select / track / filter any layer's LIVE rendered features ──────
const entityTools: AgentTool[] = [
  {
    name: "list_entities",
    description:
      "List the live rendered entities of a layer (planes, ships, earthquakes, fires, news, cameras, volcanoes, …) with id, title, position and attributes. Optional `query` filters by text. The layer must be ON and, for clustered hotspot layers, zoomed in enough to show individual points.",
    parameters: {
      type: "object",
      properties: { layer: { type: "string" }, query: { type: "string" }, limit: { type: "number" } },
      required: ["layer"],
    },
    async run({ layer, query, limit }) {
      const rows = readEntities(str(layer), { query: query ? str(query) : undefined, limit: typeof limit === "number" ? limit : 30 });
      if (!rows.length) return `No rendered entities in "${layer}"${query ? ` matching "${query}"` : ""}. Is the layer on and zoomed in past clusters?`;
      return JSON.stringify(rows.map((r) => ({ id: r.id, title: r.title, lngLat: r.center.map((x) => +x.toFixed(3)), ...scalarProps(r.props) })));
    },
  },
  {
    name: "select_entity",
    description:
      "Select ONE live entity the way a click does: opens its detail panel, flies to it, highlights it. Find it by `query` (name/callsign/id/text) in `layer`, or the nearest to `place`. For MOVING entities (planes/ships) pass track:true to keep the panel + highlight following it as it moves — this is how to 'select/track that plane/ship', never draw_box.",
    parameters: {
      type: "object",
      properties: { layer: { type: "string" }, query: { type: "string" }, place: { type: "string" }, track: { type: "boolean" } },
      required: ["layer"],
    },
    async run({ layer, query, place, track }) {
      const lid = str(layer);
      const rows = readEntities(lid, { query: query ? str(query) : undefined, limit: 300 });
      if (!rows.length) return `No rendered "${lid}" entities${query ? ` matching "${query}"` : ""}. Enable the layer and set/zoom an area first.`;
      let pick = rows[0];
      if (place) {
        const hit = await geocode(str(place));
        if (hit) pick = rows.reduce((a, b) => (dist2(b.center, [hit.lng, hit.lat]) < dist2(a.center, [hit.lng, hit.lat]) ? b : a));
      }
      const info = describeEntity(lid, pick);
      useArgusStore.getState().setSelected(info);
      const z = useArgusStore.getState().viewport?.zoom;
      layerManager.flyTo({ center: pick.center, zoom: z && z > 6 ? z : 8 });
      const willTrack = Boolean(track) && MOVEMENT_LAYERS.has(lid);
      if (willTrack) startTrack(lid, pick.id, info.title);
      else stopTrack();
      return `Selected ${info.title} in ${lid}${willTrack ? " — tracking it live (gentle recenter)" : ""}.`;
    },
  },
  {
    name: "query_entities",
    description:
      "Count + filter the live entities of a layer by attribute — the way to answer 'how many cargo ships', 'military jets above 30000 ft', 'quakes over M5', 'ships bound for India'. `where` maps property→condition: a string (case-insensitive substring), number (equals), boolean, or {min,max,eq,contains}. Returns match count + a sample. Use list_entities first to see available properties.",
    parameters: {
      type: "object",
      properties: { layer: { type: "string" }, where: { type: "object" }, limit: { type: "number" } },
      required: ["layer"],
    },
    async run({ layer, where, limit }) {
      const lid = str(layer);
      const rows = readEntities(lid, { limit: 5000 });
      if (!rows.length) return `No rendered "${lid}" entities. Enable the layer and set/zoom an area.`;
      const cond = where && typeof where === "object" ? (where as Record<string, Cond>) : {};
      const matched = rows.filter((r) => matchEntity(r.props, cond));
      const lim = typeof limit === "number" ? limit : 15;
      return JSON.stringify({
        layer: lid,
        total: rows.length,
        matched: matched.length,
        where: cond,
        sample: matched.slice(0, lim).map((r) => ({ id: r.id, title: r.title, lngLat: r.center.map((x) => +x.toFixed(3)), ...scalarProps(r.props) })),
      });
    },
  },
  {
    name: "stop_tracking",
    description: "Stop following a tracked moving entity (release the chase started by select_entity track:true).",
    parameters: { type: "object", properties: {} },
    async run() {
      const was = isTracking();
      stopTrack();
      return was ? "Stopped tracking." : "Nothing was being tracked.";
    },
  },
];

// ── monitoring: watch rules + time playback + pinned panels ─────────────────
const monitorTools: AgentTool[] = [
  {
    name: "pin_panel",
    description:
      "Pin a floating live panel for an entity so it STAYS on screen (geo-anchored to its map point) while other things are selected — e.g. keep a camera's live view up, or build a multi-camera wall. Finds the entity like select_entity (layer + optional query/place); with no args, pins the currently selected entity. Max 24 pins.",
    parameters: {
      type: "object",
      properties: { layer: { type: "string" }, query: { type: "string" }, place: { type: "string" } },
    },
    async run({ layer, query, place }) {
      const st = useArgusStore.getState();
      let info = st.selected;
      if (layer) {
        const lid = str(layer);
        const rows = readEntities(lid, { query: query ? str(query) : undefined, limit: 300 });
        if (!rows.length) return `No rendered "${lid}" entities${query ? ` matching "${query}"` : ""}.`;
        let pick = rows[0];
        if (place) {
          const hit = await geocode(str(place));
          if (hit) pick = rows.reduce((a, b) => (dist2(b.center, [hit.lng, hit.lat]) < dist2(a.center, [hit.lng, hit.lat]) ? b : a));
        }
        info = describeEntity(lid, pick);
      }
      if (!info) return "Nothing to pin — select an entity first or pass layer/query.";
      st.addPin(info);
      return `Pinned "${info.title}" (${useArgusStore.getState().pinned.length}/24 pins). It stays on screen until unpinned.`;
    },
  },
  {
    name: "list_pins",
    description: "List the pinned floating panels (id, title, layer).",
    parameters: { type: "object", properties: {} },
    async run() {
      const pins = useArgusStore.getState().pinned;
      return pins.length
        ? JSON.stringify(pins.map((p) => ({ id: p.id, title: p.entity.title, layer: p.entity.layerId })))
        : "No pinned panels.";
    },
  },
  {
    name: "unpin_panel",
    description: "Remove pinned panel(s): by id (from list_pins), by title substring `query`, or all:true.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, query: { type: "string" }, all: { type: "boolean" } },
    },
    async run({ id, query, all }) {
      const st = useArgusStore.getState();
      const before = st.pinned.length;
      if (all) st.pinned.forEach((p) => st.removePin(p.id));
      else if (id) st.removePin(str(id));
      else if (query) {
        const q = str(query).toLowerCase();
        st.pinned.filter((p) => p.entity.title.toLowerCase().includes(q)).forEach((p) => st.removePin(p.id));
      } else return "Pass id, query, or all:true.";
      const removed = before - useArgusStore.getState().pinned.length;
      return removed ? `Unpinned ${removed} panel${removed > 1 ? "s" : ""}.` : "No matching pin.";
    },
  },
  {
    name: "add_watch",
    description:
      "Create a watch rule: browser-notify the user when a NEW event of `layer` with severity ≥ `minSeverity` (scale 0–4; quakes: 2≈M4, 3≈M5, 4≈M6+) appears in the loaded area. This is how to 'alert me if…'. Rules persist across reloads.",
    parameters: {
      type: "object",
      properties: { layer: { type: "string" }, minSeverity: { type: "number" } },
      required: ["layer", "minSeverity"],
    },
    async run({ layer, minSeverity }) {
      const lid = str(layer);
      const st = useArgusStore.getState();
      if (!st.layers[lid]) return `No layer "${lid}". Valid ids: ${st.order.join(", ")}.`;
      const sev = Math.min(4, Math.max(0, Number(minSeverity) || 0));
      requestNotifyPermission();
      st.addWatch({ layerId: lid, minSeverity: sev });
      if (!st.layers[lid].enabled) layerManager.toggleLayer(lid, true);
      return `Watch added: ${st.layers[lid].label} severity ≥ ${sev} (layer enabled; scans every minute while Argus is open).`;
    },
  },
  {
    name: "list_watches",
    description: "List active watch rules (id, layer, min severity).",
    parameters: { type: "object", properties: {} },
    async run() {
      const st = useArgusStore.getState();
      return st.watches.length
        ? JSON.stringify(st.watches.map((w) => ({ id: w.id, layer: w.layerId, minSeverity: w.minSeverity })))
        : "No watch rules set.";
    },
  },
  {
    name: "remove_watch",
    description: "Remove a watch rule by its id (from list_watches), or all rules for a layer id.",
    parameters: { type: "object", properties: { id: { type: "string" }, layer: { type: "string" } } },
    async run({ id, layer }) {
      const st = useArgusStore.getState();
      const before = st.watches.length;
      if (id) st.removeWatch(str(id));
      else if (layer) st.watches.filter((w) => w.layerId === str(layer)).forEach((w) => st.removeWatch(w.id));
      else return "Pass id or layer.";
      const removed = before - useArgusStore.getState().watches.length;
      return removed ? `Removed ${removed} watch rule${removed > 1 ? "s" : ""}.` : "No matching rule.";
    },
  },
  {
    name: "set_playback",
    description:
      "Time-scrub the last 24h of event layers (quakes, news, fires, unrest…). hoursAgo: 0–24 rewinds the map to that moment; omit or pass off:true to return to live.",
    parameters: { type: "object", properties: { hoursAgo: { type: "number" }, off: { type: "boolean" } } },
    async run({ hoursAgo, off }) {
      const st = useArgusStore.getState();
      const h = Number(hoursAgo);
      if (off || !Number.isFinite(h)) {
        st.setPlayback({ active: false, t: 0 });
        return "Playback off — map is live.";
      }
      const clamped = Math.min(24, Math.max(0, h));
      st.setPlayback({ active: true, t: Date.now() - clamped * 3600_000 });
      return `Replaying events as of ${clamped}h ago (scrubber shown top-center).`;
    },
  },
];

// ── internet (keyless: DuckDuckGo + page fetch) ───────────────────────────────
const webTools: AgentTool[] = [
  {
    name: "web_search",
    description:
      "Search the web (keyless). Returns top result titles, URLs and snippets. Use for facts, current events, or context beyond the rendered map — then open_url to read a result. Cross-check anything you put on the map against live layers.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run({ query }) {
      const r = await fetch(`/api/agent/web?q=${encodeURIComponent(str(query))}`);
      if (!r.ok) return `Search failed (${r.status}).`;
      const d = (await r.json()) as { results?: unknown[]; error?: string };
      if (d.error) return `Search error: ${d.error}`;
      if (!d.results?.length) return `No results for "${query}".`;
      return JSON.stringify(d.results);
    },
  },
  {
    name: "open_url",
    description: "Fetch a web page and return its readable text (HTML stripped). Use after web_search to read a source.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run({ url }) {
      const r = await fetch(`/api/agent/web?url=${encodeURIComponent(str(url))}`);
      if (!r.ok) return `Fetch failed (${r.status}).`;
      const d = (await r.json()) as { text?: string; error?: string };
      return d.error ? `Error: ${d.error}` : str(d.text).slice(0, 12000);
    },
  },
];

/** Full tool surface (top-level agent). */
export function buildTools(): AgentTool[] {
  return [...mapTools, ...layerTools, ...entityTools, ...sitrepTools, ...dataTools, ...cameraTools, ...monitorTools, ...webTools];
}

/** Read-only subset for recon subagents: query and look up, never mutate the map. */
export function buildReadonlyTools(): AgentTool[] {
  const allow = new Set([
    "list_layers", "query_layer", "list_entities", "query_entities",
    "situation_report", "area_headlines", "nearest_cameras",
    "place_info", "geocode_place", "web_search", "open_url",
  ]);
  return buildTools().filter((t) => allow.has(t.name));
}
