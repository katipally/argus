import type { Map as MlMap } from "maplibre-gl";
import { useArgusStore } from "@/src/store/useArgusStore";
import { readEntities, describeEntity } from "./entities";

// Follow a MOVING entity (a plane/ship the agent selected): every ~800ms re-read
// its live position, refresh the EntityPanel + selection ring, and GENTLY
// recenter only when it drifts out of view (no jittery chase). Releases itself
// when the user selects something else, closes the panel, or the entity is gone.

const w = () => (window as unknown as { argusMap?: MlMap }).argusMap;

let timer: ReturnType<typeof setInterval> | null = null;
let tracked: { layerId: string; id: string; title: string } | null = null;
let misses = 0;

export function isTracking(): boolean {
  return tracked != null;
}

export function trackedTitle(): string | null {
  return tracked?.title ?? null;
}

export function stopTrack(): void {
  if (timer) clearInterval(timer);
  timer = null;
  tracked = null;
  misses = 0;
}

export function startTrack(layerId: string, id: string, title: string): void {
  stopTrack();
  tracked = { layerId, id, title };
  misses = 0;
  timer = setInterval(tick, 800);
}

function tick(): void {
  const map = w();
  const st = useArgusStore.getState();
  if (!map || !tracked) return stopTrack();
  // the user (or the agent) moved on to a different selection → release quietly
  if (!st.selected || st.selected.title !== tracked.title) return stopTrack();

  const match = readEntities(tracked.layerId).find((e) => e.id === tracked!.id);
  if (!match) {
    if (++misses > 15) stopTrack(); // ~12s with no sighting → it left / landed
    return;
  }
  misses = 0;
  st.setSelected(describeEntity(tracked.layerId, match)); // fresh center + rows
  try {
    if (!map.getBounds().contains(match.center)) {
      map.easeTo({ center: match.center, duration: 700 }); // gentle: only when off-screen
    }
  } catch {
    /* non-DOM map (tests) */
  }
}
