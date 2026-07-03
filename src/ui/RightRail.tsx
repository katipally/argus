"use client";

import { useArgusStore } from "@/src/store/useArgusStore";
import SitrepPanel from "./SitrepPanel";
import PlaceCard from "./PlaceCard";

// Right rail coordinator: EXACTLY ONE contextual panel by priority
// (right-clicked place > focused-area sitrep). The clicked entity panel is
// geo-anchored on the map itself (SelectedCallout), not here. Shares the
// right-5 top-14 slot with the Settings and Detail panels, so it steps aside
// whenever either of those is open (otherwise they stack on the same spot).
export default function RightRail() {
  const place = useArgusStore((s) => s.place);
  const aoi = useArgusStore((s) => s.aoi);
  const settingsOpen = useArgusStore((s) => s.settingsTab !== null);
  const detailOpen = useArgusStore((s) => s.detailOpen);

  if (settingsOpen || detailOpen) return null;

  const contextual = place ? "place" : aoi ? "sitrep" : null;

  return (
    <div className="pointer-events-none absolute bottom-14 right-5 top-14 flex w-80 flex-col items-end gap-3 overflow-y-auto thin-scroll">
      {contextual === "place" && <PlaceCard />}
      {contextual === "sitrep" && <SitrepPanel />}
    </div>
  );
}
