# Ad Injection API v2

Multi-tenant, production-grade ad injection over WebSocket for HLS live streams.
Every action is exposed over a REST API so you (or your customers) can build any UI.

- **API base**: `${PUBLIC_URL}` (e.g. `https://ads.yourdomain.com`)
- **Auth**: Bearer API keys (`adi_<prefix>_<secret>`) or session JWT
- **Docs**: Swagger UI at `/docs/`, OpenAPI JSON at `/openapi.json`
- **Realtime**: `wss://<host>/ws?channel=<slug>&token=<viewer_jwt>`

---

## 1. Concepts

| Object | Description |
|---|---|
| **Tenant** | An account. Each tenant is isolated — data, API keys, uploads, analytics. |
| **API Key** | Credential for programmatic access. Hashed at rest, scoped, rate-limited per key. |
| **Channel** | A live stream you serve (has `slug`, `name`, `live_url`). Viewers subscribe to channels. |
| **Ad** | A piece of creative: `video`, `hls`, or `image`. Can be uploaded or referenced by URL. |
| **Trigger** | The act of playing a specific ad on a specific channel. Broadcast to all viewers instantly. |
| **Viewer token** | Short-lived JWT you issue to authorized viewers so they can connect to a channel's WebSocket. |
| **Webhook** | Your endpoint that receives HMAC-signed events (`ad.triggered`, `ad.completed`, `ad.resumed`). |

---

## 2. Authentication

### API key (for backends / scripts)
```
Authorization: Bearer adi_1a2b3c4d_XXXXXXXXXXXXXXXXXXXXXXXXXXXX
```
Also accepted: `X-API-Key: adi_...` header.

### Session JWT (for the dashboard UI you build)
```
Authorization: Bearer <session_jwt_from_login>
```

Both are validated the same way; API keys can only touch API endpoints, session tokens can additionally manage keys/tenant settings.

**Error format** (all endpoints):
```json
{ "error": { "code": "rate_limited", "message": "Rate limit exceeded", "details": null } }
```

---

## 3. Endpoints

### 3.1 Auth & tenant

#### `POST /v1/auth/register`
Public. Create a new tenant.
```json
// req
{ "name": "Acme Media", "email": "you@acme.com", "password": "min-8-chars" }
// 201
{ "tenant": { "id": "...", "name": "...", "email": "..." }, "session": "<jwt>" }
```

#### `POST /v1/auth/login`
```json
{ "email": "...", "password": "..." }
// 200
{ "tenant": {...}, "session": "<jwt>" }
```

#### `GET /v1/auth/me` · `PATCH /v1/auth/me`
Session-only. View/update tenant profile, webhook URL, CORS allowlist.

#### `POST /v1/auth/me/rotate-webhook-secret`
Rotates the HMAC secret used to sign webhook payloads.

#### `GET|POST /v1/auth/keys` · `DELETE /v1/auth/keys/:id`
Session-only. Manage API keys.
```json
// POST req
{ "name": "Production backend", "rate_limit_rpm": 300 }
// 201 — the raw key is returned ONCE, then only its prefix is stored.
{ "id": "...", "key_prefix": "1a2b3c4d", "key": "adi_1a2b3c4d_XXXXX...", "warning": "Store this key now" }
```

### 3.2 Channels

#### `POST /v1/channels`
```json
{ "slug": "main", "name": "Main Stream", "live_url": "https://.../live.m3u8" }
```

#### `GET /v1/channels` · `GET /v1/channels/:id` · `PATCH /v1/channels/:id` · `DELETE /v1/channels/:id`
Standard CRUD.

#### `POST /v1/channels/:id/viewer-token`
Issue a viewer WebSocket token. This is what you'd call from your backend right before rendering the player.
```json
// req
{ "viewer_id": "user_12345", "ttl_seconds": 3600 }
// 200
{
  "token": "<jwt>",
  "viewer_id": "user_12345",
  "expires_in": 3600,
  "ws_url": "wss://ads.yourdomain.com/ws?channel=main&token=..."
}
```

#### `GET /v1/channels/:id/state`
Returns `{ state: { mode: "live" | "ad", ... }, viewers: <count> }`.

### 3.3 Ads

#### `POST /v1/ads` — add an ad by URL
```json
{
  "name": "Summer promo",
  "type": "hls",                       // "video" | "hls" | "image"
  "source": "https://cdn.acme.com/promo.m3u8",
  "duration_seconds": 15,
  "metadata": { "click_url": "https://acme.com/promo", "alt_text": "..." }
}
```

#### `POST /v1/ads/upload` — upload a file
`multipart/form-data`:
- `file` — mp4, webm, mkv, m3u8, png, jpg, jpeg, webp, gif
- `name` — optional (defaults to filename)
- `duration_seconds` — required for image ads, defaults to file duration for video
- `click_url` — optional

Max size: `MAX_UPLOAD_MB` env (default 200 MB).

#### `GET /v1/ads` · `GET /v1/ads/:id` · `DELETE /v1/ads/:id`

#### `GET /v1/ads/:id/signed-url`
Returns a short-lived signed URL for the uploaded asset. Not usually needed — trigger responses already include the resolved URL.

### 3.4 Triggering ads (the core action)

#### `POST /v1/channels/:id/trigger`
```json
// req
{
  "ad_id": "abc123",
  "duration_seconds": 15,    // optional override
  "lead_ms": 500             // optional; leadtime for viewer synchronization
}
// 201
{
  "trigger_id": "xxx",
  "delivered": 1247,         // number of connected viewers who received the command
  "ad": { ... },
  "command": { "action": "play_ad", "startAt": <epoch_ms>, ... }
}
```

Server ensures every connected viewer switches to the ad within ~lead_ms of the same wall-clock time. After `duration_seconds`, an automatic `resume_live` command is broadcast.

#### `POST /v1/channels/:id/resume`
Force viewers back to live immediately (cancels any active ad).

#### `GET /v1/channels/:id/triggers`
History of triggers for this channel.

### 3.5 Analytics

#### `GET /v1/analytics/overview`
```json
{
  "channels": 4, "ads": 12,
  "active_viewers": 1834,
  "triggers_24h": 87, "impressions_24h": 143201,
  "top_ads": [ { "ad_id": "...", "impressions": 51203 }, ... ]
}
```

#### `GET /v1/analytics/channels/:id`
Per-channel window (last 7 days).

#### `GET /v1/analytics/events?limit=200`
Raw event stream: `viewer.connect`, `viewer.disconnect`, `ad.impression`, `ad.complete`, `ad.skip`, custom events.

---

## 4. WebSocket protocol

Viewer connects to `wss://<host>/ws?channel=<slug>&token=<jwt>`.

### Server → Client
| Type | Payload |
|---|---|
| `welcome` | `{ channel: { id, slug, name, liveUrl }, viewerId, ts }` |
| `state` | `{ state: { mode, adUrl?, adType?, duration?, startAt? } }` — sent on connect + on request |
| `command` | `{ action: "play_ad", adUrl, adType, duration, startAt, adId, triggerId, metadata }` |
| `command` | `{ action: "resume_live", triggerId? }` |

### Client → Server
| Type | Purpose |
|---|---|
| `{ type: "hello" }` | Ask server to re-send current state |
| `{ type: "event", name, adId?, triggerId?, meta? }` | Report an analytics event (`ad.impression`, `ad.complete`, `ad.skip`, `ad.click`, or custom) |

Rate limit: 40 client → server messages per 10 seconds. Server pings every 30 s (client should reply with `pong`).

---

## 5. Webhooks

If `webhook_url` is set on your tenant, we POST JSON events to it, signed:

```
POST /your-endpoint
Content-Type: application/json
X-AdInjection-Event: ad.triggered
X-AdInjection-Timestamp: 1735689600000
X-AdInjection-Signature: sha256=abcdef012345...

{ "event": "ad.triggered", "ts": 1735689600000, "data": { ... } }
```

**Verifying signatures** (Node example):
```js
const crypto = require('crypto');
const ts  = req.get('X-AdInjection-Timestamp');
const sig = req.get('X-AdInjection-Signature');
const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET)
                                   .update(`${ts}.${JSON.stringify(req.body)}`).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.status(401).end();
```

Events fired: `ad.triggered`, `ad.completed`, `ad.resumed`.

Delivery retries up to 5 times with exponential backoff (1s, 2s, 4s, 8s, 16s).

---

## 6. Rate limiting

- Default: 120 req/min per API key. Configurable per-key at creation time.
- Response header `429` with body `{ "error": { "code": "rate_limited", ... } }`.
- WebSocket: 40 msgs / 10 s per viewer.
- Uploads: `MAX_UPLOAD_MB` env cap; MIME type allowlist enforced.

---

## 7. End-to-end example (Node.js)

```js
const API = 'https://ads.yourdomain.com';
const KEY = process.env.AD_INJECTION_KEY;   // adi_...

async function api(method, path, body, extra = {}) {
  const r = await fetch(API + path, {
    method,
    headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json', ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// 1. Create a channel
const { channel } = await api('POST', '/v1/channels', {
  slug: 'main',
  name: 'Main Stream',
  live_url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
});

// 2. Add an ad
const { ad } = await api('POST', '/v1/ads', {
  name: '15s promo', type: 'hls',
  source: 'https://your-cdn.com/promo.m3u8', duration_seconds: 15,
});

// 3. Issue a viewer token from YOUR backend when rendering the player
const { ws_url } = await api('POST', `/v1/channels/${channel.id}/viewer-token`,
  { viewer_id: 'user_42', ttl_seconds: 3600 });
// return `ws_url` to your frontend; the hosted player at /player/?ws=<encoded_ws_url> just works.

// 4. Trigger the ad
const trigger = await api('POST', `/v1/channels/${channel.id}/trigger`, { ad_id: ad.id });
console.log('delivered to', trigger.delivered, 'viewers');
```

---

## 8. Deploy

- **VPS (isolated Docker)** — `./install.sh` puts everything in one container, no Nginx/Redis on host touched. `./uninstall.sh --purge` removes everything.
- **HF Spaces (Docker SDK)** — see `HF_SPACES.md`. Works but free tier caps at ~2000 concurrent viewers.
- **Scaling** — set `REDIS_URL` env to enable cross-node broadcast, put multiple app instances behind an LB.

Environment variables — see `server/.env.example`.

---

## 9. Security summary

- Passwords hashed with bcrypt (cost 10)
- API keys stored as sha256 hashes — plaintext shown only at creation
- JWT viewer tokens are short-lived (default 1 hour) and scoped to one channel
- Webhook bodies signed with HMAC-SHA256; timestamp header prevents replay
- All inputs validated with Zod; parameterized SQL (better-sqlite3 prepared statements) — no injection surface
- Uploads: MIME allowlist + size cap + tenant-scoped storage paths (no path traversal)
- CORS: per-tenant allowlist (`*` supported but off by default)
- Helmet headers on every response; `trust proxy` set so rate-limits use real IPs
- Audit log for every mutating admin action

---

## 10. Roadmap / add-ons you can implement on top

Once running, straightforward additions using the existing schema:
- Ad campaigns (start/end date, frequency cap) — extend `ads` with `campaign_id`
- A/B rotation — extend `triggers` to pick from a weighted pool
- S3 upload — replace multer diskStorage with `multer-s3`
- Multi-region — put Redis in front, deploy the same container in each region
- Per-viewer targeting — include viewer metadata in the viewer-token JWT, filter in the trigger endpoint
