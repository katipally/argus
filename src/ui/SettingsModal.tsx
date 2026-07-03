"use client";

import { useEffect, useState } from "react";
import { useArgusStore } from "@/src/store/useArgusStore";
import { useAgentStore } from "@/src/agent/store";
import { requestNotifyPermission } from "@/src/core/watches";
import type { Effort } from "@/src/agent/shared/types";
import { MODEL_OPTIONS } from "@/src/agent/providers";

// Settings — one floating Gotham panel, four tabs. Appearance absorbs the old
// View menu; AI absorbs the omnibox provider/model picker and adds live model
// lists + reasoning effort; Data documents the on-demand pipeline; Status shows
// key/feed health + attribution.

const TABS = [
  ["appearance", "Appearance"],
  ["ai", "AI"],
  ["watches", "Watches"],
  ["data", "Data"],
  ["status", "Status"],
] as const;

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

function Btn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="rounded px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider transition-colors"
      style={{
        border: `1px solid ${active ? "var(--color-accent)" : "var(--color-hairline-strong)"}`,
        color: active ? "var(--color-accent)" : "var(--color-muted)",
        background: active ? "color-mix(in srgb, var(--color-accent) 16%, transparent)" : "transparent",
      }}
    >
      {children}
    </button>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label">{title}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
      {hint && <span className="text-[10px] leading-snug text-[var(--color-faint)]">{hint}</span>}
    </div>
  );
}

export default function SettingsModal() {
  const tab = useArgusStore((s) => s.settingsTab);
  const setTab = useArgusStore((s) => s.setSettingsTab);
  if (!tab) return null;
  return (
    <div className="panel pointer-events-auto absolute right-5 top-14 z-30 flex max-h-[78vh] w-[380px] flex-col animate-[argus-rise_0.15s_ease-out]">
      <div className="panel-head">
        <span className="label">Settings</span>
        <button onClick={() => setTab(null)} className="text-[var(--color-faint)] hover:text-[var(--color-text)]">✕</button>
      </div>
      <div className="flex gap-1 border-b border-[var(--color-hairline)] px-3 py-2">
        {TABS.map(([id, name]) => (
          <Btn key={id} active={tab === id} onClick={() => setTab(id)}>{name}</Btn>
        ))}
      </div>
      <div className="thin-scroll flex flex-col gap-4 overflow-y-auto px-3.5 py-3.5">
        {tab === "appearance" && <AppearanceTab />}
        {tab === "ai" && <AiTab />}
        {tab === "watches" && <WatchesTab />}
        {tab === "data" && <DataTab />}
        {tab === "status" && <StatusTab />}
      </div>
    </div>
  );
}

function AppearanceTab() {
  const view = useArgusStore((s) => s.view);
  const setView = useArgusStore((s) => s.setView);
  const [offsetH, setOffsetH] = useState(0);
  const sliderH = view.clockMs == null ? 0 : offsetH;

  // Toggle a 3D layer, and when turning one ON from a flat top-down camera,
  // tilt the view so the relief/extrusions are actually visible — 3D at pitch 0
  // reads as 2D, which is what made these controls feel like they "did nothing".
  const toggle3D = (which: "terrain" | "buildings") => {
    const enabling = !view[which];
    setView({ [which]: enabling } as Partial<typeof view>);
    if (enabling) {
      const map = (window as unknown as { argusMap?: { getPitch(): number; easeTo(o: object): void } }).argusMap;
      if (map && map.getPitch() < 20) map.easeTo({ pitch: 55, duration: 900 });
    }
  };
  return (
    <>
      <Row title="Skin">
        <Btn active={view.basemap === "dark"} onClick={() => setView({ basemap: "dark" })}>Dark</Btn>
        <Btn active={view.basemap === "light"} onClick={() => setView({ basemap: "light" })}>Light</Btn>
        <Btn active={view.basemap === "satellite"} onClick={() => setView({ basemap: "satellite" })}>Satellite</Btn>
      </Row>
      <Row title="Projection">
        <Btn active={view.projection === "globe"} onClick={() => setView({ projection: "globe" })}>Globe</Btn>
        <Btn active={view.projection === "mercator"} onClick={() => setView({ projection: "mercator" })}>Flat</Btn>
      </Row>
      <Row title="Terrain & 3D" hint="Terrain = elevation relief · Buildings = extruded 3D massing (z13+). Enabling either tilts the view so the 3D is visible. Works over the Satellite skin too.">
        <Btn active={view.terrain} onClick={() => toggle3D("terrain")}>Terrain</Btn>
        <Btn active={view.buildings} onClick={() => toggle3D("buildings")}>Buildings</Btn>
      </Row>
      <Row title="Labels">
        <Btn active={view.labels} onClick={() => setView({ labels: !view.labels })}>
          {view.labels ? "On" : "Off"}
        </Btn>
      </Row>
      <Row title="Day / Night">
        <Btn active={view.daynight} onClick={() => setView({ daynight: !view.daynight })}>
          {view.daynight ? "On" : "Off"}
        </Btn>
        {view.daynight && (
          <div className="flex w-full items-center gap-2">
            <input
              type="range"
              min={-12}
              max={12}
              step={0.25}
              value={sliderH}
              onChange={(e) => {
                const h = Number(e.target.value);
                setOffsetH(h);
                setView({ clockMs: h === 0 ? null : Date.now() + h * 3_600_000 });
              }}
              className="flex-1 accent-[var(--color-accent)]"
            />
            <button
              onClick={() => setView({ clockMs: null })}
              className="text-[10px] uppercase tracking-wider text-[var(--color-faint)] hover:text-[var(--color-accent)]"
            >
              {view.clockMs == null ? "live" : `${sliderH > 0 ? "+" : ""}${sliderH.toFixed(1)}h`}
            </button>
          </div>
        )}
      </Row>
    </>
  );
}

interface ModelInfo {
  id: string;
  name?: string;
  context?: number;
  reasoning?: boolean;
}

function AiTab() {
  const cfg = useAgentStore((s) => s.cfg);
  const providers = useAgentStore((s) => s.providers);
  const setCfg = useAgentStore((s) => s.setCfg);
  const addCustomProvider = useAgentStore((s) => s.addCustomProvider);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [hint, setHint] = useState("");
  const [loading, setLoading] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [cn, setCn] = useState("");
  const [cu, setCu] = useState("");
  const [cp, setCp] = useState<"openai" | "anthropic" | "google">("openai");

  const provider = providers.find((p) => p.id === cfg.providerId);

  // live model list from the provider's own /models endpoint (env key, server-side)
  useEffect(() => {
    // reset for the newly selected provider before fetching (external-system sync)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModels([]);
    setHint("");
    if (!provider) return;
    let stale = false;
    setLoading(true);
    fetch("/api/agent/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    })
      .then((r) => r.json())
      .then((d: { models?: ModelInfo[]; hint?: string }) => {
        if (stale) return;
        setModels(d.models ?? []);
        setHint(d.hint ?? "");
      })
      .catch(() => !stale && setHint("model list unavailable"))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [provider]);

  const selected = models.find((m) => m.id === cfg.model);
  // suggestions fallback when the live list is empty
  const options = models.length ? models.map((m) => m.id) : (MODEL_OPTIONS[cfg.providerId] ?? []);

  return (
    <>
      <Row title="Provider">
        <select
          value={cfg.providerId}
          onChange={(e) => setCfg({ providerId: e.target.value })}
          className="w-full rounded border border-[var(--color-hairline-strong)] bg-transparent px-2 py-1.5 text-[12px] text-[var(--color-text)] [color-scheme:dark]"
        >
          <option value="">— select provider —</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Row>
      <Row title={`Model${loading ? " · fetching live list…" : models.length ? ` · ${models.length} live` : ""}`}>
        <input
          value={cfg.model}
          onChange={(e) => setCfg({ model: e.target.value })}
          placeholder="model id — pick or type"
          list="argus-model-options"
          className="w-full rounded border border-[var(--color-hairline-strong)] bg-transparent px-2 py-1.5 text-[12px] text-[var(--color-text)]"
        />
        <datalist id="argus-model-options">
          {options.map((m) => <option key={m} value={m} />)}
        </datalist>
        {hint && <span className="text-[10px] text-[var(--color-warn)]">{hint}</span>}
        {selected && (
          <span className="tnum text-[10px] text-[var(--color-faint)]">
            {selected.name && selected.name !== selected.id ? `${selected.name} · ` : ""}
            {selected.context ? `${Math.round(selected.context / 1000)}k ctx` : ""}
            {selected.reasoning === false ? " · no reasoning" : ""}
          </span>
        )}
      </Row>
      {selected?.reasoning !== false && (
        <Row title={`Reasoning effort${cfg.effort ? ` · ${cfg.effort}` : " · default"}`}>
          {EFFORTS.map((e) => (
            <Btn key={e} active={cfg.effort === e} onClick={() => setCfg({ effort: cfg.effort === e ? undefined : e })}>
              {e}
            </Btn>
          ))}
        </Row>
      )}
      <Row title="Custom provider">
        {!showCustom ? (
          <button onClick={() => setShowCustom(true)} className="text-[10px] text-[var(--color-faint)] hover:text-[var(--color-accent)]">+ add custom provider</button>
        ) : (
          <div className="flex w-full flex-col gap-1.5 rounded border border-[var(--color-hairline)] p-2">
            <input value={cn} onChange={(e) => setCn(e.target.value)} placeholder="name" className="rounded border border-[var(--color-hairline-strong)] bg-transparent px-2 py-1 text-[11px] text-[var(--color-text)]" />
            <input value={cu} onChange={(e) => setCu(e.target.value)} placeholder="base URL (https://…/v1)" className="rounded border border-[var(--color-hairline-strong)] bg-transparent px-2 py-1 text-[11px] text-[var(--color-text)]" />
            <select value={cp} onChange={(e) => setCp(e.target.value as typeof cp)} className="rounded border border-[var(--color-hairline-strong)] bg-transparent px-2 py-1 text-[11px] text-[var(--color-text)] [color-scheme:dark]">
              <option value="openai">openai-compatible</option>
              <option value="anthropic">anthropic</option>
              <option value="google">google</option>
            </select>
            <button
              onClick={() => { if (cn && cu) { addCustomProvider({ name: cn, baseURL: cu, protocol: cp }); setShowCustom(false); setCn(""); setCu(""); } }}
              className="self-start text-[10px] uppercase tracking-wider text-[var(--color-accent)]"
            >
              add
            </button>
          </div>
        )}
      </Row>
      <span className="text-[10px] leading-relaxed text-[var(--color-faint)]">
        Keys are read from .env only (ANTHROPIC_API_KEY, OPENAI_API_KEY, …). No default model — pick one explicitly.
      </span>
    </>
  );
}

function WatchesTab() {
  const watches = useArgusStore((s) => s.watches);
  const addWatch = useArgusStore((s) => s.addWatch);
  const removeWatch = useArgusStore((s) => s.removeWatch);
  const layers = useArgusStore((s) => s.layers);
  const order = useArgusStore((s) => s.order);
  const [layerId, setLayerId] = useState("earthquakes");
  const [minSev, setMinSev] = useState(3);
  const notifyState = typeof Notification !== "undefined" ? Notification.permission : "unsupported";

  return (
    <>
      <span className="text-[11px] leading-relaxed text-[var(--color-muted)]">
        Get a browser notification while Argus is open whenever a NEW event
        matches a rule. Rules apply to whatever area is loaded.
      </span>
      <Row title="Rules">
        {watches.length === 0 && <span className="text-[11px] text-[var(--color-faint)]">no rules yet</span>}
        <div className="flex w-full flex-col gap-1">
          {watches.map((w) => (
            <div key={w.id} className="flex items-center justify-between border-b border-[var(--color-hairline)] py-1.5 text-[12px]">
              <span className="text-[var(--color-text)]">
                {layers[w.layerId]?.label ?? w.layerId} · severity ≥ {w.minSeverity}
              </span>
              <button onClick={() => removeWatch(w.id)} className="text-[var(--color-faint)] hover:text-[var(--color-alert)]">✕</button>
            </div>
          ))}
        </div>
      </Row>
      <Row title="New rule">
        <select
          value={layerId}
          onChange={(e) => setLayerId(e.target.value)}
          className="flex-1 rounded border border-[var(--color-hairline-strong)] bg-transparent px-2 py-1 text-[12px] text-[var(--color-text)] [color-scheme:dark]"
        >
          {order.map((id) => <option key={id} value={id}>{layers[id]?.label ?? id}</option>)}
        </select>
        <select
          value={minSev}
          onChange={(e) => setMinSev(Number(e.target.value))}
          className="rounded border border-[var(--color-hairline-strong)] bg-transparent px-2 py-1 text-[12px] text-[var(--color-text)] [color-scheme:dark]"
        >
          <option value={2}>sev ≥ 2</option>
          <option value={3}>sev ≥ 3</option>
          <option value={4}>sev ≥ 4</option>
        </select>
        <button
          onClick={() => {
            requestNotifyPermission();
            addWatch({ layerId, minSeverity: minSev });
          }}
          className="rounded border border-[var(--color-accent)] px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--color-accent)]"
        >
          add
        </button>
      </Row>
      {notifyState === "denied" && (
        <span className="text-[10px] text-[var(--color-warn)]">Browser notifications are blocked for this site — allow them to receive watch alerts.</span>
      )}
    </>
  );
}

function DataTab() {
  const layers = useArgusStore((s) => s.layers);
  const order = useArgusStore((s) => s.order);
  return (
    <>
      <span className="text-[11px] leading-relaxed text-[var(--color-muted)]">
        Argus stores nothing. Every layer fetches public data on demand for the
        selected area, holds it in a short-lived in-memory cache, and drops it
        when you move on. Only your preferences (this panel, AI provider/model)
        live in this browser.
      </span>
      <Row title="Pipeline guards">
        <ul className="flex w-full flex-col gap-1 text-[11px] text-[var(--color-muted)]">
          <li>· fetches are bbox-bound to your selection, never global</li>
          <li>· TTL caches per source (2 min – 6 h by volatility)</li>
          <li>· circuit breakers back off failing feeds</li>
          <li>· polling pauses when this tab is hidden</li>
        </ul>
      </Row>
      <Row title="Live right now">
        <div className="flex w-full flex-col gap-0.5">
          {order.filter((id) => layers[id]?.enabled).map((id) => {
            const l = layers[id];
            return (
              <span key={id} className="tnum flex justify-between text-[10px] text-[var(--color-faint)]">
                <span>{l.label}</span>
                <span>{l.count.toLocaleString()} · {l.status}</span>
              </span>
            );
          })}
          {order.every((id) => !layers[id]?.enabled) && (
            <span className="text-[10px] text-[var(--color-faint)]">no layers enabled</span>
          )}
        </div>
      </Row>
    </>
  );
}

const ATTRIBUTION: [string, string][] = [
  ["USGS", "earthquakes · public domain"],
  ["USGS + EMSC", "earthquakes · merged multi-source, keyless"],
  ["Smithsonian GVP / USGS", "volcanic activity · public"],
  ["GDACS (EC/UN)", "disasters · free for all use"],
  ["NASA EONET / FIRMS", "hazards, fires · open data"],
  ["NWS / NOAA", "US weather alerts · public domain"],
  ["MeteoAlarm (EUMETNET)", "EU warnings · attribution required"],
  ["RainViewer", "radar composite · free tier"],
  ["Open-Meteo", "air quality, weather · CC-BY 4.0, non-commercial"],
  ["GDELT", "news/conflict/unrest events · open"],
  ["WHO", "disease outbreaks · keyless, public"],
  ["Wikimedia EventStreams", "live Wikipedia + Wikidata edit pulse · keyless, CC"],
  ["adsb.lol + airplanes.live + adsb.fi", "aircraft · merged multi-source, open data"],
  ["AISStream", "ships · live AIS · free key · SSE-proxied"],
  ["CelesTrak", "satellite TLEs · public"],
  ["Launch Library 2 (TheSpaceDevs)", "rocket launches · open API"],
  ["NOAA NHC", "tropical cyclones · public domain"],
  ["NOAA SWPC", "space weather, aurora · public domain"],
  ["Caltrans + state DOTs", "traffic cameras · public feeds"],
  ["Panoramax (OSM-FR)", "street imagery · keyless · CC-BY-SA"],
  ["Mapillary", "street imagery · optional free token · wider coverage"],
  ["OpenFreeMap / OpenStreetMap", "basemap · ODbL"],
  ["Esri World Imagery", "satellite skin · free non-revenue use"],
  ["Nominatim / Photon / Wikipedia / Wikidata / Wikimedia Commons", "place intel · open"],
];

function StatusTab() {
  const layers = useArgusStore((s) => s.layers);
  const order = useArgusStore((s) => s.order);
  const [keys, setKeys] = useState<{ fires?: boolean; agent?: Record<string, boolean> } | null>(null);
  useEffect(() => {
    fetch("/api/keys").then((r) => r.json()).then(setKeys).catch(() => setKeys(null));
  }, []);
  const degraded = order.filter((id) => layers[id]?.enabled && layers[id]?.status === "down");
  return (
    <>
      <Row title="Optional keys (.env)">
        <div className="flex w-full flex-col gap-1 text-[11px]">
          <KeyLine name="FIRMS_MAP_KEY (fresher wildfires; keyless fallback active)" ok={keys?.fires} />
          <KeyLine
            name="NEXT_PUBLIC_MAPILLARY_TOKEN (adds Mapillary street coverage; Panoramax keyless always on)"
            ok={!!process.env.NEXT_PUBLIC_MAPILLARY_TOKEN}
          />
          {Object.entries(keys?.agent ?? {}).map(([k, v]) => (
            <KeyLine key={k} name={`${k.toUpperCase()}_API_KEY (agent)`} ok={v} />
          ))}
        </div>
      </Row>
      <Row title="Feed health">
        {degraded.length === 0 ? (
          <span className="text-[11px] text-[var(--color-live)]">all enabled feeds nominal</span>
        ) : (
          <div className="flex w-full flex-col gap-0.5">
            {degraded.map((id) => (
              <span key={id} className="text-[11px] text-[var(--color-alert)]">⚠ {layers[id].label} — upstream down</span>
            ))}
          </div>
        )}
      </Row>
      <Row title="Data sources & licenses">
        <div className="flex w-full flex-col gap-1">
          {ATTRIBUTION.map(([src, lic]) => (
            <span key={src} className="text-[10px] leading-snug text-[var(--color-faint)]">
              <span className="text-[var(--color-muted)]">{src}</span> — {lic}
            </span>
          ))}
        </div>
      </Row>
    </>
  );
}

function KeyLine({ name, ok }: { name: string; ok?: boolean }) {
  return (
    <span className="flex items-center justify-between">
      <span className="text-[var(--color-muted)]">{name}</span>
      <span style={{ color: ok ? "var(--color-live)" : "var(--color-warn)" }}>{ok ? "set" : "not set"}</span>
    </span>
  );
}
