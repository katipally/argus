import { Marker, type Map as MlMap } from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { useArgusStore } from "@/src/store/useArgusStore";
import { buildSitrep, type SitrepEvent } from "@/src/core/sitrep";
import { pointInBbox } from "@/src/core/bbox";

// Map-native HUD: the most severe events in view get small anchored callout
// tags with a leader line — hover grows them, click opens the entity panel.
// Recomputed on idle (debounced by MapLibre's own idle cadence). Also renders
// the sitrep-list hover tie: a bright ring on the event a list row points at.

const MAX_TAGS = 6;
let markers: Marker[] = [];

function tagEl(ev: SitrepEvent): HTMLElement {
  const el = document.createElement("div");
  el.className = "argus-callout";
  el.style.setProperty("--callout-color", ev.color);
  el.innerHTML = `
    <div class="argus-callout-line"></div>
    <div class="argus-callout-tag">
      <span class="argus-callout-title">${ev.title.replace(/</g, "&lt;").slice(0, 48)}</span>
      <span class="argus-callout-sub">${ev.layerLabel}</span>
    </div>`;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    useArgusStore.getState().setSelected({
      layerId: ev.layerId,
      title: ev.title,
      subtitle: ev.layerLabel,
      color: ev.color,
      center: ev.center,
      rows: [["Severity", String(ev.severity)]],
      url: ev.url,
      imageUrl: ev.imageUrl,
      streamUrl: ev.streamUrl,
    });
  });
  return el;
}

function refresh(map: MlMap): void {
  for (const m of markers) m.remove();
  markers = [];
  const st = useArgusStore.getState();
  if (!st.aoi) return; // callouts only make sense once a region is focused
  let events: SitrepEvent[];
  try {
    events = buildSitrep(map).topEvents;
  } catch {
    return;
  }
  const b = map.getBounds();
  const vp = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
  const inView = events
    .filter((e) => pointInBbox(e.center[0], e.center[1], vp) && e.severity >= 2)
    .slice(0, MAX_TAGS);
  for (const ev of inView) {
    markers.push(new Marker({ element: tagEl(ev), anchor: "bottom", offset: [0, -6] }).setLngLat(ev.center).addTo(map));
  }
}

const TIE_SRC = "tie-src";

export function initCallouts(map: MlMap): void {
  map.on("idle", () => refresh(map));
  // callouts vanish with the focus
  useArgusStore.subscribe((s, p) => {
    if (s.aoi !== p.aoi && !s.aoi) {
      for (const m of markers) m.remove();
      markers = [];
    }
  });

  // sitrep hover tie — bright ring at the event a list row points at
  map.addSource(TIE_SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "tie-ring",
    type: "circle",
    source: TIE_SRC,
    paint: {
      "circle-radius": 14,
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": "#4c90f0",
      "circle-stroke-width": 2.5,
      "circle-stroke-opacity": 0.95,
    },
  });
  useArgusStore.subscribe((s, p) => {
    if (s.tiePoint === p.tiePoint) return;
    const src = map.getSource(TIE_SRC) as GeoJSONSource | undefined;
    src?.setData({
      type: "FeatureCollection",
      features: s.tiePoint
        ? [{ type: "Feature", geometry: { type: "Point", coordinates: s.tiePoint }, properties: {} }]
        : [],
    });
  });
}
