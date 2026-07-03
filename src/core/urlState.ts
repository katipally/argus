import { useArgusStore } from "@/src/store/useArgusStore";
import { layerManager } from "@/src/layers/registry";
import { resolveArea } from "@/src/geo/resolve";
import { geometryBbox } from "./bbox";
import { debounce } from "./debounce";

// Shareable session state in the URL hash — open the link, get the same view.
//   #a=France,Germany   named areas (re-resolved to real boundaries on load)
//   &box=w,s,e,n        drawn rectangles (repeatable)
//   &l=news,fires       enabled layers
//   &b=dark&p=globe     basemap · projection
// replaceState only (no history spam), and only when the string actually changes.

let restoring = false;
let lastHash = "";

export function initUrlState(): void {
  if (typeof window === "undefined") return;
  void restore();
  const write = debounce(writeHash, 600);
  useArgusStore.subscribe((s, p) => {
    if (restoring) return;
    if (s.selection !== p.selection || s.layers !== p.layers || s.view !== p.view) write();
  });
}

function writeHash(): void {
  const s = useArgusStore.getState();
  const q = new URLSearchParams();
  const named = s.selection.filter((sh) => sh.kind !== "box").map((sh) => sh.ref ?? sh.label);
  if (named.length) q.set("a", named.join(","));
  for (const sh of s.selection.filter((x) => x.kind === "box")) {
    const bb = geometryBbox([sh.geometry]);
    if (bb) q.append("box", [bb.west, bb.south, bb.east, bb.north].map((v) => v.toFixed(3)).join(","));
  }
  const on = s.order.filter((id) => s.layers[id]?.enabled);
  if (on.length) q.set("l", on.join(","));
  if (s.view.basemap !== "dark") q.set("b", s.view.basemap);
  if (s.view.projection !== "globe") q.set("p", s.view.projection);
  const hash = q.toString();
  if (hash === lastHash) return;
  lastHash = hash;
  history.replaceState(null, "", hash ? `#${hash}` : window.location.pathname);
}

async function restore(): Promise<void> {
  const raw = window.location.hash.slice(1);
  if (!raw) return;
  const q = new URLSearchParams(raw);
  restoring = true;
  try {
    const st = useArgusStore.getState();
    const basemap = q.get("b");
    const projection = q.get("p");
    if (basemap === "light" || basemap === "satellite") st.setView({ basemap });
    if (projection === "mercator") st.setView({ projection });
    // layers BEFORE areas, so the default intel set never overrides the link
    for (const id of (q.get("l") ?? "").split(",").filter(Boolean)) {
      layerManager.toggleLayer(id, true);
    }
    for (const bb of q.getAll("box")) {
      const [w, s, e, n] = bb.split(",").map(Number);
      if ([w, s, e, n].some((v) => !Number.isFinite(v))) continue;
      const ring: [number, number][] = [[w, s], [e, s], [e, n], [w, n], [w, s]];
      st.addShape(
        { id: `box:${bb}`, kind: "box", label: "Shared box", geometry: { type: "Polygon", coordinates: [ring] } },
        true,
      );
    }
    for (const name of (q.get("a") ?? "").split(",").filter(Boolean)) {
      const shape = await resolveArea(name).catch(() => null);
      if (shape) st.addShape(shape, true);
    }
    const aoi = useArgusStore.getState().aoi;
    if (aoi) layerManager.fitBbox(aoi.bbox, { pitch: 0 });
  } finally {
    restoring = false;
    lastHash = ""; // next change rewrites from live state
  }
}
