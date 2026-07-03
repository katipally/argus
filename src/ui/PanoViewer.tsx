"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useArgusStore } from "@/src/store/useArgusStore";

// Chrome-free street-imagery viewer. Instead of embedding a provider's whole
// website (OSM-FR's iframe now ships a welcome banner + nav that swamp the
// picture), we pull the raw image and render it ourselves — zero dependencies,
// no third-party chrome, instant.
//  · Panoramax image URLs are deterministic (no metadata round-trip needed).
//  · Mapillary needs a one-shot graph-API lookup (uses the public client token).
// Flat photos (≈16:9) show contain-fit with pan/zoom; 360° equirectangular
// panos (≈2:1) default to fill-height with wrap-around horizontal look-around.

const PANO_BASE = "https://panoramax.openstreetmap.fr/api/pictures";
const MLY_TOKEN = process.env.NEXT_PUBLIC_MAPILLARY_TOKEN;

/** Panoramax thumb (fast first paint) + full SD are deterministic by id. */
const panoThumb = (id: string) => `${PANO_BASE}/${id}/thumb.jpg`;
const panoSd = (id: string) => `${PANO_BASE}/${id}/sd.jpg`;

async function resolveImage(
  id: string,
  source: "panoramax" | "mapillary",
): Promise<{ url: string; thumb?: string; link: string }> {
  if (source === "mapillary") {
    const link = `https://www.mapillary.com/app/?pKey=${id}`;
    if (!MLY_TOKEN) throw new Error("no mapillary token");
    const r = await fetch(
      `https://graph.mapillary.com/${id}?access_token=${MLY_TOKEN}&fields=thumb_2048_url,thumb_1024_url`,
    );
    if (!r.ok) throw new Error(`mapillary ${r.status}`);
    const j = (await r.json()) as { thumb_2048_url?: string; thumb_1024_url?: string };
    const url = j.thumb_2048_url || j.thumb_1024_url;
    if (!url) throw new Error("mapillary: no image url");
    return { url, thumb: j.thumb_1024_url, link };
  }
  return {
    url: panoSd(id),
    thumb: panoThumb(id),
    link: `https://panoramax.openstreetmap.fr/#focus=pic&pic=${id}`,
  };
}

export default function PanoViewer() {
  const pano = useArgusStore((s) => s.panoImageId);
  const setPanoImageId = useArgusStore((s) => s.setPanoImageId);
  if (!pano) return null;
  // keyed remount = fresh zoom/pan/loading state per picture, no reset effects
  return (
    <PanoFrame
      key={`${pano.source}:${pano.id}`}
      pano={pano}
      onClose={() => setPanoImageId(null)}
    />
  );
}

function PanoFrame({
  pano,
  onClose,
}: {
  pano: { id: string; source: "panoramax" | "mapillary" };
  onClose: () => void;
}) {
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "error"; msg: string }
    | { phase: "ready"; url: string; link: string; is360: boolean }
  >({ phase: "loading" });

  // pan/zoom
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const pan = useRef({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const imgWrap = useRef<HTMLDivElement>(null);

  const applyTransform = useCallback((is360: boolean) => {
    const el = imgWrap.current;
    if (!el) return;
    el.style.transform = `translate(${pan.current.x}px, ${pan.current.y}px) scale(${is360 ? 1 : zoom})`;
  }, [zoom]);

  // resolve + preload the image (component is keyed per picture, so state
  // always starts fresh at "loading" — no sync resets needed here)
  useEffect(() => {
    let cancelled = false;
    resolveImage(pano.id, pano.source)
      .then(({ url }) => {
        const img = new Image();
        img.onload = () => {
          if (cancelled) return;
          // equirectangular panos are exactly 2:1; flat photos (incl. wide
          // dashcam ~1.9:1) stay under this so they get contain-fit + zoom.
          const is360 = img.naturalWidth / Math.max(1, img.naturalHeight) >= 1.98;
          setState({ phase: "ready", url, link: url, is360 });
        };
        img.onerror = () => !cancelled && setState({ phase: "error", msg: "image failed to load" });
        img.src = url;
      })
      .catch((e) => !cancelled && setState({ phase: "error", msg: String(e.message ?? e) }));

    return () => {
      cancelled = true;
    };
  }, [pano.id, pano.source]);

  const is360 = state.phase === "ready" && state.is360;

  // keep the transform in sync with wheel-zoom and first paint
  useEffect(() => {
    if (state.phase === "ready") applyTransform(state.is360);
  }, [zoom, state, applyTransform]);

  const onPointerDown = (e: React.PointerEvent) => {
    // a contained flat photo at 1× has nowhere to pan — only drag once zoomed
    // in (or always, for a 360° pano).
    if (!is360 && zoom <= 1) return;
    drag.current = { x: e.clientX - pan.current.x, y: e.clientY - pan.current.y };
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    pan.current = { x: e.clientX - drag.current.x, y: e.clientY - drag.current.y };
    applyTransform(is360);
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
  };
  const onWheel = (e: React.WheelEvent) => {
    if (is360) return; // 360 pans, doesn't zoom
    setZoom((z) => Math.min(5, Math.max(1, z - e.deltaY * 0.002)));
  };

  return (
    <div className="panel pointer-events-auto absolute bottom-24 left-1/2 z-30 w-[min(1000px,92vw)] -translate-x-1/2 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2">
        <span className="label">
          street view · {pano.source}
          {is360 ? " · 360°" : ""}
        </span>
        <div className="flex items-center gap-3">
          {state.phase === "ready" && (
            <a
              href={state.link}
              target="_blank"
              rel="noopener"
              className="text-[10px] uppercase tracking-wider text-[var(--color-faint)] transition-colors hover:text-[var(--color-text)]"
            >
              original ↗
            </a>
          )}
          <button
            onClick={onClose}
            className="text-[var(--color-faint)] transition-colors hover:text-[var(--color-text)]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      </div>

      <div
        className="relative h-[min(600px,72vh)] w-full touch-none select-none overflow-hidden bg-black"
        style={{ cursor: state.phase === "ready" ? (dragging ? "grabbing" : "grab") : "default" }}
        onPointerDown={state.phase === "ready" ? onPointerDown : undefined}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={onWheel}
      >
        {state.phase === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center gap-2.5">
            <span className="argus-spinner" />
            <span className="label !text-[var(--color-accent)]">loading imagery</span>
          </div>
        )}
        {state.phase === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
            <span className="text-[13px] text-[var(--color-text)]">Street imagery unavailable</span>
            <span className="text-[11px] text-[var(--color-faint)]">{state.msg}</span>
          </div>
        )}
        {state.phase === "ready" && (
          <div
            ref={imgWrap}
            className="absolute inset-0 flex items-center justify-center will-change-transform"
            style={{ transform: `translate(0px,0px) scale(1)` }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={state.url}
              alt="street imagery"
              draggable={false}
              className={is360 ? "h-full max-w-none" : "max-h-full max-w-full"}
              style={is360 ? undefined : { objectFit: "contain" }}
            />
          </div>
        )}

        {/* attribution — always visible, never chrome-heavy */}
        <span className="pointer-events-none absolute bottom-2 right-3 text-[10px] text-[var(--color-faint)]">
          {pano.source === "panoramax" ? "Panoramax · CC-BY-SA" : "© Mapillary"}
        </span>
        {is360 && (
          <span className="pointer-events-none absolute bottom-2 left-3 text-[10px] uppercase tracking-wider text-[var(--color-faint)]">
            drag to look around
          </span>
        )}
      </div>
    </div>
  );
}
