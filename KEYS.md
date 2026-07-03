# Argus — API keys & data sources

Argus renders **keyless by default** — every core layer works with no key.
Optional free keys unlock: fresher wildfires, the Ships layer, wider street
imagery, global webcams, and the AI agent.

## How to add keys

1. Copy the template: `cp .env.example .env.local`
2. Fill in the key(s) you want (see below).
3. Restart the dev server (`pnpm dev`). `.env.local` is git-ignored — your keys stay local.

Key status is visible in-app under **Settings → Status**.

## Optional keys

| Purpose | Env var | Where to get it | Cost |
|---------|---------|-----------------|------|
| **Fresher wildfires** | `FIRMS_MAP_KEY` | [firms.modaps.eosdis.nasa.gov/api](https://firms.modaps.eosdis.nasa.gov/api/) → request a MAP_KEY | Free |

Without it, Wildfires still works — Argus falls back to NASA's open global
24-hour VIIRS CSV (slightly less fresh, bbox-filtered server-side).

| **Wider street imagery** | `NEXT_PUBLIC_MAPILLARY_TOKEN` | [mapillary.com/dashboard/developers](https://www.mapillary.com/dashboard/developers) → create a client token | Free |

Street view is always on and keyless via **Panoramax**. A free Mapillary token
adds a second, far larger global coverage network (rendered in blue); click a
dot from either source and Argus opens that provider's viewer. The client token
is safe to expose (read-only, per-app rate-limited).

| **Ships (live AIS)** | `NEXT_PUBLIC_AISSTREAM_KEY` | [aisstream.io](https://aisstream.io) → free key (GitHub sign-in) | Free |
| **Global webcams** | `WINDY_API_KEY` | [api.windy.com/webcams](https://api.windy.com/webcams) → free key | Free |

The Webcams layer always shows curated famous 24/7 YouTube Live streams
keyless (Times Square, Shibuya, Niagara, Venice — extend the catalog in
`src/layers/feeds/webcam-catalog.ts`). A free Windy key adds their worldwide
webcam network with previews and player embeds.

Without it the Ships layer stays dormant (no legal keyless global AIS source
exists). With it, Argus bridges the AISstream WebSocket server-side as SSE and
dead-reckons vessels between updates. Despite the `NEXT_PUBLIC_` name the key
is only read server-side.

Aircraft is **multi-source and keyless** — Argus merges adsb.lol +
airplanes.live + adsb.fi per request and dedupes by hex, so no single source
being slow or thin ever blanks the layer.

## AI agent keys (server-side, any subset)

`ANTHROPIC_API_KEY` · `OPENAI_API_KEY` · `GOOGLE_API_KEY` · `OPENROUTER_API_KEY`
· `GROQ_API_KEY` · `DEEPSEEK_API_KEY`. Pick provider/model/effort in
**Settings → AI** (model lists are fetched live from each provider). Ollama
needs no key (local). NOTE: the env line must actually contain a value — an
empty `ANTHROPIC_API_KEY=` line means "no key" and the agent will say so.

## Layers (all keyless)

- **Earth** — Earthquakes (USGS), Volcanoes (Smithsonian GVP weekly), Disasters
  (GDACS), Natural hazards (NASA EONET), Wildfires (NASA FIRMS open CSV),
  Cyclones (NOAA NHC live storms).
- **Sky** — Weather alerts (US NWS polygons + Europe MeteoAlarm country dots),
  Radar (RainViewer), Air quality (Open-Meteo CAMS grid), Aurora / space
  weather (NOAA SWPC OVATION + Kp).
- **Signals** — News / Conflict / Unrest (one shared GDELT 15-minute Events
  feed, filtered three ways).
- **Movement** — Aircraft (adsb.lol + airplanes.live + adsb.fi), Satellites
  (CelesTrak TLEs + satellite.js), Launches (Launch Library 2 pads +
  countdowns). Ships require a free AISstream key (see above).
- **Ground** — Cameras (Caltrans + ~28 state DOT feeds), Webcams (curated
  YouTube Lives keyless; Windy worldwide with a free key), street imagery
  (Panoramax, appears automatically at city zoom).

## Basemaps & imagery (all keyless)

- **Dark** (default) — OpenFreeMap dark-matter vector style.
- **Light** — OpenFreeMap positron.
- **Satellite** — Esri World Imagery legacy endpoint (free for non-revenue use).
- Terrain — AWS terrarium DEM. 3D buildings — OpenFreeMap vector extrusions.

Coverage grows by appending rows to the feed catalogs in `src/layers/feeds/` — no new code.
