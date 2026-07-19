/**
 * mint-viewer — Supabase / Lovable Edge Function (Deno).
 *
 * The ONLY server-side piece the viewer player needs. It holds the OOR API key
 * (never shipped to the browser) and mints a short-lived viewer token so the
 * browser can open the ad-delivery WebSocket. See docs/api/08-viewer-player-lovable.txt §3.
 *
 * Request  (POST):  { "channel": "<channel id or slug>" }
 * Response (200):    { wsUrl, channelSlug, channelName, secured, expiresIn }
 *
 * Env (set as function secrets — NOT in client code):
 *   OOR_HOST      e.g. https://your-oor-host        (no trailing slash)
 *   OOR_API_KEY   an api key with scope playback:write (or '*')
 *   ALLOW_ORIGIN  e.g. https://oormax.lovable.app    (CORS; default '*')
 */

const OOR_HOST = (Deno.env.get("OOR_HOST") || "").replace(/\/+$/, "");
const OOR_API_KEY = Deno.env.get("OOR_API_KEY") || "";
const ALLOW_ORIGIN = Deno.env.get("ALLOW_ORIGIN") || "*";

const cors = {
  "access-control-allow-origin": ALLOW_ORIGIN,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "vary": "Origin",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!OOR_HOST || !OOR_API_KEY) return json({ error: "server_misconfigured" }, 500);

  let channel = "";
  try {
    const body = await req.json();
    channel = String(body?.channel || "").trim();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  if (!channel) return json({ error: "channel_required" }, 400);

  // The viewer-token endpoint is keyed by channel ID. If we were given a slug,
  // resolve it to an ID first via the channels list (api-key authed, server-side).
  // Look up the channel by id OR slug so we know its id + display name.
  // (The list endpoint returns both; the viewer-token endpoint is keyed by id.)
  const list = await fetch(`${OOR_HOST}/api/v1/channels?limit=100`, {
    headers: { "x-api-key": OOR_API_KEY },
  });
  if (!list.ok) return json({ error: "channel_lookup_failed" }, 502);
  const data = await list.json();
  const match = (data.items || []).find(
    (c: { id: string; slug: string }) => c.id === channel || c.slug === channel,
  );
  if (!match) return json({ error: "channel_not_found" }, 404);
  const channelId = match.id;
  const channelName = match.name || "";

  // Mint the short-lived viewer token + player links.
  const mint = await fetch(`${OOR_HOST}/api/v1/channels/${encodeURIComponent(channelId)}/viewer-token`, {
    method: "POST",
    headers: { "x-api-key": OOR_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ ttl_seconds: 3600 }),
  });
  const mintBody = await mint.json().catch(() => ({}));
  if (mint.status === 404) return json({ error: "channel_not_found" }, 404);
  if (!mint.ok) return json({ error: "mint_failed", detail: mintBody?.error_code }, 502);

  // Hand the browser ONLY what it needs — never the api key.
  return json({
    wsUrl: mintBody.ws_url,
    channelSlug: mintBody.ws_url.match(/[?&]channel=([^&]+)/)?.[1] || match.slug,
    channelName,
    secured: !!mintBody.secured,
    expiresIn: mintBody.expires_in,
  });
});
