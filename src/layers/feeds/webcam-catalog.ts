import { type Bbox, pointInBbox } from "@/src/core/bbox";
import type { CameraFeature } from "./camera-providers";

// Curated keyless world webcams: famous 24/7 YouTube Live streams, embedded via
// the EntityPanel/PinnedPanels iframe path. YouTube killed permanent
// channel-based live embeds in 2023, so entries pin a VIDEO id. IDs rotate when
// a stream restarts (a couple did within a day of first harvest) — refresh by
// scanning the channels' /streams tabs for THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE
// badges and updating rows here. Coverage grows by appending entries.
// Sources: @earthcam, @StreamTimeLive, @afarTV, ANNnewsCH, I Love You Venice,
// @VaticanNews, @NASA, @seoulcityview. All verified live 2026-07-02.
export interface CuratedWebcam {
  id: string;
  label: string;
  lat: number;
  lng: number;
  /** YouTube video id of the 24/7 live stream. */
  videoId: string;
}

export const CURATED_WEBCAMS: CuratedWebcam[] = [
  // ── New York ────────────────────────────────────────────────────────────
  { id: "yt-timessquare", label: "Times Square in 4K, New York", lat: 40.758, lng: -73.9855, videoId: "Lr-u3vIZ3KE" },
  { id: "yt-timessquare-street", label: "Times Square Crossroads, New York", lat: 40.7566, lng: -73.9863, videoId: "z-jYdOIKcTQ" },
  { id: "yt-timessquare-north", label: "Times Square North, New York", lat: 40.7605, lng: -73.9843, videoId: "JQ_jwk_7OVE" },
  { id: "yt-wtc", label: "World Trade Center, New York", lat: 40.7127, lng: -74.0134, videoId: "5C9oM7C2Q9k" },
  { id: "yt-liberty", label: "Statue of Liberty, New York", lat: 40.6892, lng: -74.0445, videoId: "cWR8KGKftUw" },
  { id: "yt-coneyisland", label: "Coney Island Boardwalk, New York", lat: 40.5749, lng: -73.9857, videoId: "H67j7H-7QD0" },
  { id: "yt-nycharbor", label: "New York Harbor, Brooklyn", lat: 40.7031, lng: -74.0007, videoId: "l7b5RFAkKhY" },
  // ── US & Americas ───────────────────────────────────────────────────────
  { id: "yt-neworleans", label: "Bourbon Street Balcony, New Orleans", lat: 29.9584, lng: -90.0644, videoId: "C32EiZiQPkQ" },
  { id: "yt-niagara", label: "Niagara Falls", lat: 43.0799, lng: -79.0747, videoId: "qx7gry390YA" },
  { id: "yt-dc", label: "Washington Monument, Washington D.C.", lat: 38.8895, lng: -77.0353, videoId: "oDCAAfOSqvA" },
  { id: "yt-libertybell", label: "Liberty Bell & Independence Hall, Philadelphia", lat: 39.9496, lng: -75.1503, videoId: "F1EQEDL4ddU" },
  { id: "yt-chicago", label: "Chicago Skydeck", lat: 41.8789, lng: -87.6359, videoId: "O0UGT7AT3aw" },
  { id: "yt-midway", label: "Midway Airport, Chicago", lat: 41.7868, lng: -87.7522, videoId: "67BCsiW-1Io" },
  { id: "yt-sfbay", label: "San Francisco Bay, Pier 23", lat: 37.8016, lng: -122.3973, videoId: "a5IW4I-z2rs" },
  { id: "yt-seaside", label: "Seaside Heights Beach, New Jersey", lat: 39.9445, lng: -74.0721, videoId: "GEzXE5Wo4MI" },
  { id: "yt-baltimore", label: "Baltimore Shipping Channel", lat: 39.2624, lng: -76.5789, videoId: "t_VfYNtprYE" },
  { id: "yt-soolocks", label: "Soo Locks, Sault Ste. Marie", lat: 46.5011, lng: -84.3546, videoId: "TkY4BzCikQ4" },
  { id: "yt-lakehood", label: "Lake Hood Seaplane Base, Anchorage", lat: 61.18, lng: -149.97, videoId: "61pi8UjLOlo" },
  { id: "yt-sintmaarten", label: "Maho Beach Planespotting, Sint Maarten", lat: 18.0413, lng: -63.1089, videoId: "IQNldL1LNzc" },
  { id: "yt-sanibel", label: "Sanibel Island, Florida", lat: 26.44, lng: -82.112, videoId: "4LTSTw4jnZc" },
  { id: "yt-anglins", label: "Anglins Fishing Pier, Florida", lat: 26.1885, lng: -80.0937, videoId: "YEAhxXd-TiY" },
  { id: "yt-iss", label: "ISS Live (NASA, over Mission Control)", lat: 29.5586, lng: -95.0936, videoId: "awQzjn72bI0" },
  // ── Volcanoes & nature (afarTV / ANN) ───────────────────────────────────
  { id: "yt-iceland-volcano", label: "Reykjanes Volcano Watch, Iceland", lat: 63.89, lng: -22.27, videoId: "-nyXSeI0sBg" },
  { id: "yt-etna", label: "Mount Etna, Sicily", lat: 37.751, lng: 14.9934, videoId: "lynX9Smloe4" },
  { id: "yt-semeru", label: "Semeru Volcano, Java", lat: -8.108, lng: 112.922, videoId: "1rbBmhRQ5Gs" },
  { id: "yt-bromo", label: "Bromo Volcano, Java", lat: -7.942, lng: 112.953, videoId: "nerntsuIIqk" },
  { id: "yt-merapi", label: "Merapi Volcano, Indonesia", lat: -7.5407, lng: 110.4457, videoId: "z1kLiiWvm4U" },
  { id: "yt-fuego", label: "Fuego Volcano, Guatemala", lat: 14.4747, lng: -90.8806, videoId: "5kpWKkJ-xKY" },
  { id: "yt-santiaguito", label: "Santa María (Santiaguito) Volcano, Guatemala", lat: 14.7565, lng: -91.5523, videoId: "i4kxSPT7rGo" },
  { id: "yt-popocatepetl", label: "Popocatépetl Volcano, Mexico", lat: 19.0225, lng: -98.6278, videoId: "LAI8dHL9bVM" },
  { id: "yt-kanlaon", label: "Kanlaon Volcano, Philippines", lat: 10.412, lng: 123.132, videoId: "DIWcJkiUnqY" },
  { id: "yt-sangay", label: "Sangay Volcano & Amazon, Ecuador", lat: -2.005, lng: -78.341, videoId: "vK3RouzZoT4" },
  { id: "yt-ilulissat", label: "Ilulissat Iceberg Cam, Greenland", lat: 69.2198, lng: -51.0986, videoId: "h8O0UXsL7uk" },
  { id: "yt-napili", label: "Napili Bay, Maui", lat: 20.994, lng: -156.667, videoId: "UpwNqncnqTE" },
  { id: "yt-amazon", label: "Amazon Jungle, Rio Negro, Brazil", lat: -3.06, lng: -60.35, videoId: "HGrs226B1fs" },
  // ── Asia ────────────────────────────────────────────────────────────────
  { id: "yt-shibuya", label: "Shibuya Scramble Crossing, Tokyo", lat: 35.6595, lng: 139.7005, videoId: "8H3nRCFVR6Y" },
  { id: "yt-haneda", label: "Haneda Airport Terminal 2, Tokyo", lat: 35.5533, lng: 139.7811, videoId: "WRfOLF9plnU" },
  { id: "yt-seoul", label: "Han River & Banpo Bridge, Seoul", lat: 37.529, lng: 126.934, videoId: "-uLv08faWVE" },
  // ── Europe ──────────────────────────────────────────────────────────────
  { id: "yt-venice-rialto", label: "Rialto Bridge, Venice", lat: 45.438, lng: 12.3358, videoId: "Kmf_wiTFuXY" },
  { id: "yt-venice-grandcanal", label: "Grand Canal, Venice", lat: 45.4419, lng: 12.321, videoId: "r8N6IsoIkTk" },
  { id: "yt-venice-sanmarco", label: "San Marco Basin, Venice", lat: 45.4335, lng: 12.3398, videoId: "ASqGNET31VY" },
  { id: "yt-vatican", label: "Vatican Media Live", lat: 41.9022, lng: 12.4568, videoId: "03pYP2Nmreo" },
];

const embed = (videoId: string) =>
  `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&mute=1&playsinline=1`;

/** Curated live streams inside the AOI, as normalized camera features. */
export function curatedWebcams(aoi: Bbox): CameraFeature[] {
  return CURATED_WEBCAMS.filter((c) => pointInBbox(c.lng, c.lat, aoi)).map((c) => ({
    id: c.id,
    lng: c.lng,
    lat: c.lat,
    label: c.label,
    provider: "YouTube Live",
    imageUrl: `https://i.ytimg.com/vi/${c.videoId}/hqdefault.jpg`,
    embedUrl: embed(c.videoId),
  }));
}
