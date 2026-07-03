import type { NextRequest } from "next/server";

// Maritime AIS bridge. AISStream is a WebSocket that browsers can't reach
// (CORS), so this route holds the upstream WS server-side and streams vessels
// to the client as SSE. Two jobs beyond the CORS bypass:
//   1. Keep the API key server-side.
//   2. Coalesce the firehose (~hundreds of msgs/s) into one per-vessel snapshot
//      flushed every 2s — the browser gets clean batches, never the raw storm.
// Node 22+ has a global WebSocket, so no `ws` dependency. Frames arrive as Blob.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY = process.env.NEXT_PUBLIC_AISSTREAM_KEY;
const AIS_URL = "wss://stream.aisstream.io/v0/stream";
const FLUSH_MS = 2_000;
const STALE_MS = 180_000; // drop vessels unseen for 3 min
const MAX_BATCH = 3_000;

interface Vessel {
  mmsi: number;
  lat?: number;
  lon?: number;
  cog?: number; // course over ground
  heading?: number; // true heading (or cog when unavailable)
  sog?: number; // speed over ground, knots
  name?: string;
  type?: number;
  dest?: string;
  t: number;
}

export function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const n = (k: string) => Number(q.get(k));
  const west = n("west"), south = n("south"), east = n("east"), north = n("north");
  if (![west, south, east, north].every(Number.isFinite)) {
    return Response.json({ error: "bbox required" }, { status: 400 });
  }
  // no key → 204 tells EventSource to STOP (not reconnect-loop); the client
  // key-gates anyway, so this is just belt-and-suspenders.
  if (!KEY) return new Response(null, { status: 204 });

  const enc = new TextEncoder();
  let closed = false;
  let ws: WebSocket | null = null;
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* controller already closed */
        }
      };
      const shutdown = () => {
        if (closed) return;
        closed = true;
        if (flushTimer) clearInterval(flushTimer);
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      const fleet = new Map<number, Vessel>();
      const dirty = new Set<number>();

      ws = new WebSocket(AIS_URL);
      ws.onopen = () => {
        // AISStream requires the subscription within 3s of connect. bbox order
        // is [[[latMin, lonMin], [latMax, lonMax]]].
        ws!.send(
          JSON.stringify({
            APIKey: KEY,
            BoundingBoxes: [[[south, west], [north, east]]],
            FilterMessageTypes: ["PositionReport", "ShipStaticData"],
          }),
        );
      };
      ws.onmessage = async (e: MessageEvent) => {
        let m: Record<string, unknown>;
        try {
          const txt = typeof e.data === "string" ? e.data : await (e.data as Blob).text();
          m = JSON.parse(txt);
        } catch {
          return;
        }
        // AISStream surfaces auth/subscription problems as an error message.
        if (typeof m.error === "string") {
          send({ error: m.error });
          return;
        }
        const meta = m.MetaData as Record<string, unknown> | undefined;
        const mmsi = Number(meta?.MMSI);
        if (!mmsi) return;
        const cur: Vessel = fleet.get(mmsi) ?? { mmsi, t: 0 };

        if (m.MessageType === "PositionReport") {
          const pr = (m.Message as Record<string, Record<string, number>>).PositionReport;
          cur.lat = pr.Latitude;
          cur.lon = pr.Longitude;
          cur.cog = pr.Cog;
          cur.sog = pr.Sog;
          cur.heading = pr.TrueHeading === 511 ? pr.Cog : pr.TrueHeading;
          cur.name = String(meta?.ShipName ?? cur.name ?? "").trim();
          cur.t = Date.now();
        } else if (m.MessageType === "ShipStaticData") {
          const sd = (m.Message as Record<string, Record<string, unknown>>).ShipStaticData;
          cur.name = String(sd.Name ?? cur.name ?? "").trim();
          cur.type = Number(sd.Type) || cur.type;
          cur.dest = String(sd.Destination ?? cur.dest ?? "").trim();
        } else {
          return;
        }
        fleet.set(mmsi, cur);
        dirty.add(mmsi);
      };
      ws.onerror = () => send({ error: "ais upstream error" });
      ws.onclose = () => shutdown();

      flushTimer = setInterval(() => {
        const now = Date.now();
        for (const [k, v] of fleet) if (now - v.t > STALE_MS) fleet.delete(k);
        if (dirty.size === 0) {
          send({ ping: 1 }); // keep the pipe warm through proxies
          return;
        }
        const batch: Vessel[] = [];
        for (const mmsi of dirty) {
          const v = fleet.get(mmsi);
          if (v && typeof v.lat === "number") batch.push(v);
          if (batch.length >= MAX_BATCH) break;
        }
        dirty.clear();
        if (batch.length) send(batch);
      }, FLUSH_MS);

      req.signal.addEventListener("abort", shutdown);
    },
    cancel() {
      closed = true;
      if (flushTimer) clearInterval(flushTimer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
