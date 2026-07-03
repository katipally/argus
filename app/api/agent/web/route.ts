import { upstreamFetch } from "@/src/core/upstream";

// Keyless web access for the Argus agent (ported from Friday's web tools).
//   GET ?q=<query>   → DuckDuckGo HTML results: title + url + snippet
//   GET ?url=<url>   → fetch a page, HTML stripped to plain text
// Server-side so CORS and the browser UA don't get in the way. No key needed;
// DDG can rate-limit, in which case we return a clean error the model relays.
export const dynamic = "force-dynamic";

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

async function search(query: string): Promise<Response> {
  const res = await upstreamFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    timeoutMs: 12_000,
    headers: { Accept: "text/html" },
  });
  const html = await res.text();
  // DDG HTML result blocks: <a class="result__a" href="…">title</a> + snippet
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snipRe.exec(html))) snippets.push(htmlToText(sm[1]));
  const results: { title: string; url: string; snippet: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < 8) {
    const href = decodeURIComponent(m[1].match(/uddg=([^&]+)/)?.[1] ?? m[1]);
    results.push({ title: htmlToText(m[2]), url: href, snippet: snippets[results.length] ?? "" });
  }
  return Response.json({ query, results });
}

async function fetchUrl(url: string): Promise<Response> {
  let u = url;
  if (!/^https?:\/\//.test(u)) u = `https://${u}`;
  const res = await upstreamFetch(u, { timeoutMs: 15_000, headers: { Accept: "text/html,*/*" } });
  if (!res.ok) return Response.json({ url: u, error: `HTTP ${res.status}` }, { status: 200 });
  const ct = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  const text = ct.includes("html") ? htmlToText(raw) : raw;
  return Response.json({ url: u, text: text.length > 16_000 ? `${text.slice(0, 16_000)}\n… (truncated)` : text });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q");
  const url = searchParams.get("url");
  try {
    if (url) return await fetchUrl(url);
    if (q) return await search(q);
    return Response.json({ error: "q or url required" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 200 });
  }
}
