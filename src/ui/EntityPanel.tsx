"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { useArgusStore } from "@/src/store/useArgusStore";
import { layerManager } from "@/src/layers/registry";
import { enrichEntity, type EntityEnrichment } from "@/src/core/enrich";

export default function EntityPanel({
  dragProps,
  maxHeight,
}: {
  /** Pointer handlers from the geo-anchored wrapper — makes the header the drag handle. */
  dragProps?: React.HTMLAttributes<HTMLDivElement>;
  maxHeight?: number;
}) {
  const selected = useArgusStore((s) => s.selected);
  const setSelected = useArgusStore((s) => s.setSelected);
  const addPin = useArgusStore((s) => s.addPin);
  const ref = useRef<HTMLDivElement>(null);
  const [intel, setIntel] = useState<EntityEnrichment | null>(null);
  const [viewMore, setViewMore] = useState(false);
  const entityKey = selected ? `${selected.layerId}:${selected.title}` : "";

  // fresh entity → collapsed details, no stale enrichment
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setViewMore(false);
    setIntel(null);
  }, [entityKey]);

  // progressive: context/news/similar load only when "view more" opens
  useEffect(() => {
    if (!selected || !viewMore || intel) return;
    let stale = false;
    const map = (window as unknown as { argusMap?: import("maplibre-gl").Map }).argusMap;
    void enrichEntity(selected, map).then((e) => {
      if (!stale) setIntel(e);
    });
    return () => {
      stale = true;
    };
  }, [selected, viewMore, intel]);

  useGSAP(
    () => {
      if (selected && ref.current) {
        gsap.fromTo(
          ref.current,
          { y: 10, scale: 0.97, opacity: 0 },
          { y: 0, scale: 1, opacity: 1, duration: 0.32, ease: "power3.out" },
        );
      }
    },
    { dependencies: [selected?.title, selected?.layerId], scope: ref },
  );

  if (!selected) return null;

  const iconBtn =
    "text-[13px] leading-none text-[var(--color-faint)] transition-colors hover:text-[var(--color-accent)]";

  return (
    <div
      ref={ref}
      className="panel pointer-events-auto flex w-72 flex-col overflow-hidden"
      style={{
        resize: "both", // native corner-drag resize
        minWidth: 288,
        maxWidth: 620,
        minHeight: 120,
        maxHeight,
      }}
    >
      {/* pinned header: drag handle + title + every action */}
      <div
        className="flex shrink-0 cursor-grab items-center gap-2 px-3 py-2.5 active:cursor-grabbing"
        style={{ touchAction: "none" }}
        {...dragProps}
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: selected.color }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight text-[var(--color-text)]">
            {selected.title}
          </div>
          {selected.subtitle && <div className="label mt-px truncate">{selected.subtitle}</div>}
        </div>
        <div
          className="flex shrink-0 items-center gap-2"
          onPointerDown={(e) => e.stopPropagation() /* buttons never start a drag */}
        >
          <button
            onClick={() => {
              addPin(selected);
              setSelected(null);
            }}
            className={iconBtn}
            aria-label="Pin panel"
            title="Pin — keeps this panel floating on the map while you select other things"
          >
            ⚑
          </button>
          <button
            onClick={() => setSelected(null)}
            className="text-[13px] leading-none text-[var(--color-faint)] transition-colors hover:text-[var(--color-alert)]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="h-[2px] shrink-0" style={{ background: selected.color }} />

      {/* proper action buttons — pinned below the title, always visible */}
      <div className="flex shrink-0 flex-col gap-1.5 px-3 pb-2 pt-2.5">
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => layerManager.flyTo({ center: selected.center, zoom: 11, pitch: 55 })}
              className="rounded-md border border-[var(--color-hairline-strong)] py-1.5 text-[10px] uppercase tracking-widest text-[var(--color-accent)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]"
            >
              Zoom in ▸
            </button>
            <button
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("argus:ask", {
                    detail: `Tell me about this event: "${selected.title}" at ${selected.center[1].toFixed(2)}, ${selected.center[0].toFixed(2)} (${selected.subtitle ?? selected.layerId}). What's the situation and context?`,
                  }),
                )
              }
              className="rounded-md border border-[var(--color-hairline-strong)] py-1.5 text-[10px] uppercase tracking-widest text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              ✦ Ask Argus
            </button>
          </div>
          {selected.url && (
            <a
              href={selected.url}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full rounded-md border border-[var(--color-hairline-strong)] py-1.5 text-center text-[10px] uppercase tracking-widest text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)]"
            >
              Open source ↗
            </a>
          )}
        </div>

      <div className="min-h-0 flex-1 overflow-y-auto thin-scroll">
          {selected.embedUrl ? (
            <div className="aspect-video w-full bg-black">
              <iframe
                src={selected.embedUrl}
                title={selected.title}
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
                className="h-full w-full border-0"
              />
            </div>
          ) : (selected.streamUrl || selected.imageUrl) ? (
            <CameraView key={selected.streamUrl ?? selected.imageUrl} imageUrl={selected.imageUrl ?? ""} streamUrl={selected.streamUrl} />
          ) : null}

          {/* key facts — always visible */}
          <div className="flex flex-col gap-1 px-4 py-3">
            {selected.rows.slice(0, viewMore ? undefined : 3).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <span className="label">{k}</span>
                <span className="tnum text-[12px] text-[var(--color-muted)]">{v}</span>
              </div>
            ))}
          </div>

          <button
            onClick={() => setViewMore((v) => !v)}
            className="flex w-full items-center justify-center gap-1 border-t border-[var(--color-hairline)] py-2 text-[10px] uppercase tracking-widest text-[var(--color-accent)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]"
          >
            {viewMore ? "less ▴" : "view more ▾"}
          </button>

          {viewMore && (
            <>
              {/* WHERE — nearest place + conditions */}
              {intel?.where && (intel.where.label || intel.where.weather) && (
                <div className="border-t border-[var(--color-hairline)] px-4 py-2.5">
                  <span className="label">Where</span>
                  <div className="mt-1 text-[12px] leading-snug text-[var(--color-muted)]">
                    {intel.where.label}
                    {intel.where.weather && (
                      <span className="tnum block text-[11px] text-[var(--color-faint)]">{intel.where.weather}</span>
                    )}
                  </div>
                </div>
              )}

              {/* REPORTED NEARBY — GDELT headlines within ~200 km */}
              {intel && intel.news.length > 0 && (
                <div className="border-t border-[var(--color-hairline)] px-4 py-2.5">
                  <span className="label">Reported nearby</span>
                  <div className="mt-1.5 flex flex-col gap-1.5">
                    {intel.news.map((n) => (
                      <a
                        key={n.url}
                        href={n.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group text-[11px] leading-snug"
                      >
                        <span className="block truncate text-[var(--color-muted)] group-hover:text-[var(--color-text)]">▸ {n.title}</span>
                        <span className="text-[10px] text-[var(--color-faint)]">{n.domain}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* SIMILAR — same layer, closest first */}
              {intel && intel.similar.length > 0 && (
                <div className="border-t border-[var(--color-hairline)] px-4 py-2.5">
                  <span className="label">Similar in area</span>
                  <div className="mt-1.5 flex flex-col gap-1">
                    {intel.similar.map((s) => (
                      <button
                        key={s.title}
                        onClick={() => layerManager.flyTo({ center: s.center, zoom: 8 })}
                        className="flex items-center gap-2 text-left text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
                      >
                        <span className="flex-1 truncate">{s.title}</span>
                        <span className="tnum text-[10px] text-[var(--color-faint)]">{s.km} km</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {!intel && (
                <div className="flex items-center gap-2 border-t border-[var(--color-hairline)] px-4 py-2.5">
                  <span className="argus-spinner" />
                  <span className="text-[11px] text-[var(--color-faint)]">gathering context…</span>
                </div>
              )}
            </>
          )}
        </div>
    </div>
  );
}

// Live camera view: plays the HLS stream when there is one (hls.js in Chrome/Firefox,
// native in Safari) and falls back to the refreshing still image when there is no
// stream or the stream is offline (Caltrans streams rotate off often). Fullscreen uses
// the native Fullscreen API — no library. Shared with PinnedPanels.
export function CameraView({ imageUrl, streamUrl }: { imageUrl: string; streamUrl?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // keyed on the source by the parent, so a new camera remounts this with fresh state
  const [mode, setMode] = useState<"stream" | "image">(streamUrl ? "stream" : "image");

  useEffect(() => {
    const video = videoRef.current;
    if (mode !== "stream" || !streamUrl || !video) return;
    let hls: Hls | null = null;
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = streamUrl; // Safari plays HLS natively
      video.play().catch(() => {});
    } else if (Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 10, liveSyncDurationCount: 1 });
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        // stream rotated offline / fatal error → drop to the still image
        if (data.fatal) setMode(imageUrl ? "image" : "stream");
      });
      video.play().catch(() => {});
    } else {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMode("image");
    }
    return () => hls?.destroy();
  }, [mode, streamUrl, imageUrl]);

  if (mode === "image") return <CameraImage url={imageUrl} />;

  return (
    <div className="group relative mt-3">
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        className="max-h-52 w-full bg-black object-contain"
      />
      <FullscreenButton onClick={() => videoRef.current?.requestFullscreen?.()} />
    </div>
  );
}

// Live camera still, refreshed every 30s while the panel is open (bandwidth is
// lazy: only the opened camera's image loads, and only while visible).
function CameraImage({ url }: { url: string }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [bust, setBust] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setBust((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!url || failed) {
    return (
      <div className="mx-4 mt-3 flex h-40 items-center justify-center rounded-md border border-[var(--color-hairline)] text-[11px] text-[var(--color-faint)]">
        camera feed unavailable
      </div>
    );
  }
  const src = url + (url.includes("?") ? "&" : "?") + `t=${bust}`;
  return (
    <div className="group relative mt-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        src={src}
        alt="camera"
        onError={() => setFailed(true)}
        className="max-h-52 w-full object-cover"
      />
      <FullscreenButton onClick={() => imgRef.current?.requestFullscreen?.()} />
    </div>
  );
}

function FullscreenButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Fullscreen"
      className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-1 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100"
    >
      ⛶
    </button>
  );
}
