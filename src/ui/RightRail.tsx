"use client";

import { useArgusStore } from "@/src/store/useArgusStore";
import { useAgentStore } from "@/src/agent/store";
import SitrepPanel from "./SitrepPanel";
import EntityPanel from "./EntityPanel";
import PlaceCard from "./PlaceCard";

// Right rail coordinator: EXACTLY ONE contextual panel by priority (clicked
// entity > right-clicked place > focused-area sitrep). It shares the right-5
// top-14 slot with the Settings and Detail panels, so it steps aside whenever
// either of those is open (otherwise they stack on the same spot).
export default function RightRail() {
  const selected = useArgusStore((s) => s.selected);
  const place = useArgusStore((s) => s.place);
  const aoi = useArgusStore((s) => s.aoi);
  const settingsOpen = useArgusStore((s) => s.settingsTab !== null);
  const detailOpen = useArgusStore((s) => s.detailOpen);
  const agentOpen = useAgentStore((s) => s.open);

  if (settingsOpen || detailOpen || agentOpen) return null;

  const contextual = selected ? "entity" : place ? "place" : aoi ? "sitrep" : null;

  return (
    <div className="pointer-events-none absolute bottom-14 right-5 top-14 flex w-80 flex-col items-end gap-3 overflow-y-auto thin-scroll">
      {contextual === "entity" && <EntityPanel />}
      {contextual === "place" && <PlaceCard />}
      {contextual === "sitrep" && <SitrepPanel />}
    </div>
  );
}
