"use client";

import { useArgusStore } from "@/src/store/useArgusStore";

function Chip({
  label,
  on,
  color,
  onClick,
}: {
  label: string;
  on: boolean;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors"
      style={{
        border: `1px solid ${on ? color : "#243043"}`,
        color: on ? color : "var(--color-faint)",
        background: on ? `color-mix(in srgb, ${color} 14%, transparent)` : "transparent",
      }}
    >
      {label}
    </button>
  );
}

const DISASTER_TYPES: [string, string][] = [
  ["EQ", "Quake"],
  ["TC", "Cyclone"],
  ["FL", "Flood"],
  ["DR", "Drought"],
  ["VO", "Volcano"],
  ["WF", "Wildfire"],
];
const HAZARD_CATS = ["Wildfires", "Severe Storms", "Volcanoes", "Sea and Lake Ice"];

export default function FilterPanel() {
  const layers = useArgusStore((s) => s.layers);
  const filters = useArgusStore((s) => s.filters);
  const setFilter = useArgusStore((s) => s.setFilter);
  const aoi = useArgusStore((s) => s.aoi);

  const on = (id: string) => layers[id]?.enabled;
  if (!aoi || !(on("earthquakes") || on("planes") || on("disasters") || on("hazards"))) return null;

  const toggleIn = (arr: string[], v: string) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  return (
    <div className="panel pointer-events-auto flex w-full shrink-0 flex-col gap-3 overflow-hidden px-3 py-3">
      <span className="label">Filters</span>

      {on("earthquakes") && (
        <div>
          <div className="mb-1 flex justify-between text-[11px] text-[var(--color-muted)]">
            <span>Seismic · min mag</span>
            <span className="tnum text-[var(--color-accent)]">
              {filters.earthquakes.minMag.toFixed(1)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={8}
            step={0.5}
            value={filters.earthquakes.minMag}
            onChange={(e) => setFilter("earthquakes", { minMag: Number(e.target.value) })}
            className="w-full accent-[var(--color-accent)]"
          />
        </div>
      )}

      {on("planes") && (
        <div>
          <div className="mb-1 flex justify-between text-[11px] text-[var(--color-muted)]">
            <span>Aircraft · min alt</span>
            <span className="tnum" style={{ color: "#ffb020" }}>
              {filters.planes.minAlt.toLocaleString()} ft
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={45000}
            step={1000}
            value={filters.planes.minAlt}
            onChange={(e) => setFilter("planes", { minAlt: Number(e.target.value) })}
            className="w-full"
            style={{ accentColor: "#ffb020" }}
          />
          <div className="mt-1.5 flex gap-1">
            {(["all", "civ", "mil"] as const).map((c) => (
              <Chip
                key={c}
                label={c}
                color="#ffb020"
                on={filters.planes.category === c}
                onClick={() => setFilter("planes", { category: c })}
              />
            ))}
          </div>
        </div>
      )}

      {on("disasters") && (
        <div>
          <div className="mb-1 text-[11px] text-[var(--color-muted)]">Disasters · type</div>
          <div className="flex flex-wrap gap-1">
            {DISASTER_TYPES.map(([code, label]) => (
              <Chip
                key={code}
                label={label}
                color="#fb5c8b"
                on={filters.disasters.types.includes(code)}
                onClick={() =>
                  setFilter("disasters", { types: toggleIn(filters.disasters.types, code) })
                }
              />
            ))}
          </div>
          <div className="mt-1.5 flex gap-1">
            {["Green", "Orange", "Red"].map((a) => (
              <Chip
                key={a}
                label={a}
                color={a === "Red" ? "#ff3b6b" : a === "Orange" ? "#ff9f45" : "#4ade80"}
                on={filters.disasters.alerts.includes(a)}
                onClick={() =>
                  setFilter("disasters", { alerts: toggleIn(filters.disasters.alerts, a) })
                }
              />
            ))}
          </div>
        </div>
      )}

      {on("hazards") && (
        <div>
          <div className="mb-1 text-[11px] text-[var(--color-muted)]">Hazards · category</div>
          <div className="flex flex-wrap gap-1">
            {HAZARD_CATS.map((c) => (
              <Chip
                key={c}
                label={c.replace("Severe ", "").replace("Sea and Lake ", "")}
                color="#ff8a3d"
                on={filters.hazards.categories.includes(c)}
                onClick={() =>
                  setFilter("hazards", { categories: toggleIn(filters.hazards.categories, c) })
                }
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
