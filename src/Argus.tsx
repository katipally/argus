"use client";

import { useCallback, useState } from "react";
import type { Map as MlMap } from "maplibre-gl";
import GlobeMap from "@/src/map/GlobeMap";
import { initCountries } from "@/src/map/countriesLayer";
import { initClickSelect } from "@/src/map/clickSelect";
import { initPanoramax } from "@/src/map/panoramaxLayer";
import { initMapillary } from "@/src/map/mapillaryLayer";
import { initFocusMask } from "@/src/map/focusMask";
import { initCallouts } from "@/src/map/callouts";
import { initWatches } from "@/src/core/watches";
import { initUrlState } from "@/src/core/urlState";
import { initTerminator } from "@/src/map/terminator";
import { initPinLayer } from "@/src/map/pinLayer";
import DetailModal from "@/src/ui/DetailModal";
import PanoViewer from "@/src/ui/PanoViewer";
import PanoPreview from "@/src/ui/PanoPreview";
import SelectionPanel from "@/src/ui/SelectionPanel";
import LayerRail from "@/src/ui/LayerRail";
import FilterPanel from "@/src/ui/FilterPanel";
import StatusStrip from "@/src/ui/StatusStrip";
import SettingsModal from "@/src/ui/SettingsModal";
import RightRail from "@/src/ui/RightRail";
import HoverTooltip from "@/src/ui/HoverTooltip";
import SelectHint from "@/src/ui/SelectHint";
import SyncIndicator from "@/src/ui/SyncIndicator";
import EventTicker from "@/src/ui/EventTicker";
import Omnibox from "@/src/ui/Omnibox";
import CommandPalette from "@/src/ui/CommandPalette";
import PlaybackBar from "@/src/ui/PlaybackBar";
import ErrorBoundary from "@/src/ui/ErrorBoundary";
import PinnedPanels from "@/src/ui/PinnedPanels";
import SelectedCallout from "@/src/ui/SelectedCallout";
import Preloader from "@/src/ui/Preloader";
import { layerManager } from "@/src/layers/registry";

export default function Argus() {
  const [booted, setBooted] = useState(false);
  const onBootDone = useCallback(() => setBooted(true), []);
  const onMapReady = useCallback((map: MlMap) => {
    void layerManager.start(map);
    // initCountries wires the selection-outline sync + hover preview; picking
    // itself is via double-click (initClickSelect).
    void initCountries(map);
    initClickSelect(map);
    initPanoramax(map);
    initMapillary(map); // no-op unless NEXT_PUBLIC_MAPILLARY_TOKEN is set
    initFocusMask(map);
    initCallouts(map);
    initWatches(map);
    initTerminator(map);
    initPinLayer(map);
    initUrlState();
    const w = window as unknown as { argus?: unknown; argusMap?: unknown };
    w.argus = layerManager;
    w.argusMap = map;
    window.dispatchEvent(new Event("argus:map-ready")); // preloader milestone
  }, []);

  return (
    <main className="relative h-screen w-screen overflow-hidden">
      <ErrorBoundary name="globe">
        <GlobeMap onMapReady={onMapReady} />
      </ErrorBoundary>

      {/* HUD stays invisible until the preloader hands off, then rises in */}
      <div
        className="pointer-events-none absolute inset-0 z-10 transition-all duration-700 ease-out"
        style={{
          opacity: booted ? 1 : 0,
          transform: booted ? "none" : "translateY(8px)",
          visibility: booted ? "visible" : "hidden",
        }}
      >
        <ErrorBoundary name="hud">
          {/* Title */}
          <div className="panel pointer-events-auto absolute left-5 top-5 flex items-center gap-3 px-4 py-2.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-accent)] opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-accent)]" />
            </span>
            <span className="font-display text-[17px] font-semibold tracking-[0.3em] text-[var(--color-text)]">
              ARGUS
            </span>
            <span className="label">live world dashboard</span>
          </div>

          {/* Left rail: focus → layers → filters */}
          <div className="pointer-events-none absolute bottom-14 left-5 top-20 flex w-64 flex-col gap-3 overflow-y-auto thin-scroll pb-2">
            <SelectionPanel />
            <LayerRail />
            <FilterPanel />
          </div>

          {/* Right side: thin status strip + one contextual panel */}
          <StatusStrip />
          <RightRail />
          <PinnedPanels />
          <SelectedCallout />

          <Omnibox />
          <CommandPalette />
          <PlaybackBar />
          <SettingsModal />
          <PanoViewer />
          <PanoPreview />
          <SyncIndicator />
          <HoverTooltip />
          <SelectHint />
          <DetailModal />
          <EventTicker />
        </ErrorBoundary>
      </div>

      <Preloader onDone={onBootDone} />
    </main>
  );
}
