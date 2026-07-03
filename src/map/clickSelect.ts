import type { Map as MlMap, MapMouseEvent } from "maplibre-gl";
import { useArgusStore } from "@/src/store/useArgusStore";
import { resolveAtPoint, eezShape } from "@/src/geo/resolve";
import { primaryBbox } from "@/src/core/bbox";
import { layerManager, enableIntelSet } from "@/src/layers/registry";

// ONE selection gesture: RIGHT-CLICK. The level follows the zoom (continent →
// country → state → county → city), the region auto-focuses (camera fit + dim),
// the place card opens, and a default intel set lights up if nothing is on.
//  • right-click            = select + focus (replaces selection)
//  • shift + right-click    = ADD region to the selection
//  • right-click a selected = toggle it off
// Double-click stays what every map user expects: zoom.

let busy = false;

export function initClickSelect(map: MlMap): void {
  // click on empty map = dismiss the selected-entity callout (entity/cluster
  // clicks hit their own layer handlers; this only fires on true empty space)
  map.on("click", (e: MapMouseEvent) => {
    const st = useArgusStore.getState();
    if (!st.selected) return;
    const hitEntity = map
      .queryRenderedFeatures(e.point)
      .some((f) => f.properties && ("layerId" in f.properties || "point_count" in f.properties));
    if (!hitEntity) st.setSelected(null);
  });

  map.on("contextmenu", (e: MapMouseEvent) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    const { lat, lng } = e.lngLat;
    const zoom = map.getZoom();
    const additive = e.originalEvent.shiftKey || e.originalEvent.metaKey || e.originalEvent.ctrlKey;
    void (async () => {
      try {
        const shape = await resolveAtPoint(lat, lng, zoom);
        const st = useArgusStore.getState();
        if (!shape) {
          // open water / unresolvable — still show the place card for the point
          st.setPlace({ lat, lon: lng, zoom });
          return;
        }
        // toggle off when re-clicking an already-selected region
        if (st.selection.some((s) => s.id === shape.id)) {
          st.removeShape(shape.id);
          st.setPlace(null);
          return;
        }
        st.addShape(shape, additive);
        if (shape.kind === "country" && shape.ref) {
          void eezShape(shape.ref).then((z) => z && useArgusStore.getState().addShape(z, true));
        }
        // auto-focus: frame the mainland, not scattered territories
        const bb = primaryBbox(shape.geometry) ?? useArgusStore.getState().aoi?.bbox;
        if (bb) layerManager.fitBbox(bb, { pitch: 0 });
        // place card, scoped to what was selected
        st.setPlace({
          lat,
          lon: lng,
          zoom,
          scopeKind: shape.kind === "continent" || shape.kind === "country" ? shape.kind : undefined,
          scopeName: shape.kind === "continent" || shape.kind === "country" ? shape.label : undefined,
        });
        // light up the default intel set so the region is never a blank map
        const aoi = useArgusStore.getState().aoi;
        if (aoi) enableIntelSet(aoi.bbox);
      } finally {
        busy = false;
      }
    })();
  });
}
