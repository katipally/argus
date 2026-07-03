// Source ids that belong to Argus data/overlays — the basemap label-hiding loop
// in GlobeMap must never touch symbol layers on these. The hotspot helper adds
// its source id here on init so new layers are protected automatically.
export const OUR_SOURCES = new Set<string>([
  "planes-src",
  "space-src",
  "sel-src",
  "countries-src",
]);
