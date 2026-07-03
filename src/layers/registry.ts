import { LayerManager } from "./LayerManager";
import { useArgusStore } from "@/src/store/useArgusStore";
import { bboxIntersects, type Bbox } from "@/src/core/bbox";
import { earthquakes } from "./earthquakes";
import { volcanoes } from "./volcanoes";
import { planes } from "./planes";
import { ships } from "./ships";
import { disasters } from "./disasters";
import { hazards } from "./hazards";
import { news } from "./news";
import { conflict } from "./conflict";
import { unrest } from "./unrest";
import { health } from "./health";
import { wikipulse } from "./wikipulse";
import { space } from "./space";
import { radar } from "./radar";
import { alerts } from "./alerts";
import { airquality } from "./airquality";
import { spacewx } from "./spacewx";
import { fires } from "./fires";
import { cyclones } from "./cyclones";
import { launches } from "./launches";
import { cameras, webcams } from "./cameras";

/** Single app-wide manager instance; layers register at module load. */
export const layerManager = new LayerManager();

// registration order = display order within each LayerRail group
layerManager.register(earthquakes); // earth
layerManager.register(volcanoes);
layerManager.register(disasters);
layerManager.register(hazards);
layerManager.register(fires);
layerManager.register(cyclones);
layerManager.register(alerts); // sky
layerManager.register(radar);
layerManager.register(airquality);
layerManager.register(spacewx);
layerManager.register(news); // signals
layerManager.register(conflict);
layerManager.register(unrest);
layerManager.register(health);
layerManager.register(wikipulse);
layerManager.register(planes); // movement
layerManager.register(ships);
layerManager.register(space);
layerManager.register(launches);
layerManager.register(cameras); // ground
layerManager.register(webcams);

// ── default intel set ────────────────────────────────────────────────────────
// Focusing a region lights these up IF the user has nothing enabled yet — the
// map should never be blank after a focus. Region-aware: coverage-limited
// layers only join when the AOI actually intersects their coverage. Manual
// toggles are always respected afterwards.
const ALERT_COVERAGE: Bbox[] = [
  { west: -170, south: 18, east: -60, north: 72 }, // NWS (US incl. AK/HI-ish)
  { west: -25, south: 34, east: 45, north: 72 }, // MeteoAlarm Europe
];

export function enableIntelSet(aoi: Bbox): void {
  const st = useArgusStore.getState();
  const anyOn = st.order.some((id) => st.layers[id]?.enabled);
  if (anyOn) return; // never fight the user's own choices
  const set = ["news", "earthquakes", "disasters", "fires"];
  if (ALERT_COVERAGE.some((c) => bboxIntersects(aoi, c))) set.push("alerts");
  for (const id of set) layerManager.toggleLayer(id, true);
}
