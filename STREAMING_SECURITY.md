# Streaming Security Layer

Device-limit + signed-URL protection for live streams delivered through the
oor-ad platform. Modeled after AWS S3 presigned URLs, Bunny.net Token
Authentication, Cloudflare signed URLs, and nginx `secure_link` — same
HMAC-SHA256 + short-lived-token + timing-safe comparison pattern used by
production CDNs.

## What this system prevents

- **Session sharing.** Only N devices may hold a live session per PIN. New
  devices must ask before kicking an existing one.
- **Stale-link replay.** Every stream URL expires within 45–300s. Old copied
  links stop working before they're useful to a scraper.
- **Casual scraping.** Every segment URI is individually signed against the
  active session — you can't lift one segment URL and reuse it in isolation.
- **In-flight token abuse after a kick.** Kicked sessions land in a short-TTL
  revocation set immediately; no fresh signed URLs will be minted for them,
  and the WebSocket lifecycle channel closes their player within seconds.
- **UA spoofing / token theft mid-session.** If the User-Agent hash changes
  on the same sessionId, the session is terminated (soft-binding).

## What this system does NOT prevent

- **Screen recording.** No software-only, DRM-less system can stop a viewer
  from recording their own screen. This is a known and accepted limitation,
  not a bug. If you need this, integrate a hardware DRM (Widevine, FairPlay,
  PlayReady). We do not ship DRM support.
- **A determined attacker on the viewer's own machine.** deviceId is
  client-supplied and can be spoofed. It is one signal among several (IP, UA,
  heartbeat continuity), never the sole authority.

## Architecture

```
                 ┌──────────────────────────────────┐
                 │  Tenant Admin UI                 │
                 │  /admin/streaming-security.html  │
                 └──────────────┬───────────────────┘
                                │  /v1/admin/streaming/*
                                ▼
    ┌────────────────────────────────────────────────────┐
    │  Node cluster (1..N workers)                       │
    │  - /v1/stream/authorize                            │
    │  - /v1/stream/confirm-kick                         │
    │  - /v1/stream/heartbeat                            │
    │  - /v1/stream/refresh-url                          │
    │  - /v1/stream/manifest  (app-proxied HLS rewrite)  │
    │  - /stream-ws  (session lifecycle)                 │
    └───────┬─────────────────────────────┬──────────────┘
            │                             │
    ┌───────▼─────────┐         ┌─────────▼──────────┐
    │  Redis          │         │  SQLite            │
    │  session:{pin}  │         │  stream_pins       │
    │  maxDevices:*   │         │  stream_origin     │
    │  revoked_*      │         │  revocation_log    │
    │  ratelimit:*    │         │  channels          │
    │  session:commands (pub/sub)                    │
    └─────────────────┘         └────────────────────┘
                       ┌────────▼────────┐
                       │  Origin per     │
                       │  channel:       │
                       │   bunny  → CDN  │
                       │   nginx  → VPS  │
                       │   direct → app  │
                       └─────────────────┘
```

## Setup

1. **Add ioredis:** `cd server && npm install` (already in `package.json`).
2. **Copy env additions:** append `server/.env.example.additions` to your
   `server/.env`. Set `HMAC_SIGNING_SECRET` to a 32+ char random string.
   The server refuses to boot without it.
3. **Point at Redis:** set `REDIS_URL`. Defaults to `redis://127.0.0.1:6379`.
4. **Restart.** SQLite migrations for `stream_pins`, `stream_origin`, and
   `revocation_log` are idempotent and run on first import.
5. **Sign in to the admin UI** at `/admin/streaming-security.html`.
   Create a PIN, set its max devices, choose per-channel origin type.

## Per-channel origin routing

Each channel has an `origin_type` (`bunny` | `nginx` | `direct`) stored in
`stream_origin`. Global secrets live in env; no code or config changes
needed to add a new channel.

- **`bunny`**: server emits Bunny-format tokens
  (`?token=<b64u(sha256(key+path+expiry))>&expires=<epoch>`). Enable
  Token Authentication on the Pull Zone.
- **`nginx`**: server emits `?sig=<b64u_md5>&exp=<epoch>` matching the
  `secure_link_md5` directive shown in the admin UI's Edge Config tab.
- **`direct`**: server proxies the m3u8 through `/v1/stream/manifest` and
  rewrites every URI with our own HMAC. Use this while migrating; move to
  `bunny`/`nginx` for zero-bandwidth-cost enforcement.

## Player integration

```html
<script src="/player/stream-security-client.js"></script>
<script>
  const s = new StreamSecurity({ pin: '123456', channelSlug: 'my-channel' });
  const auth = await s.authorize();
  if (auth.needsKick) {
    // Show modal listing auth.activeSessions.
    // On user confirm:
    await s.confirmKick(chosenSessionId);
  }
  s.connectLifecycleWs();
  document.addEventListener('oor:session_terminated', () => {
    // MUST destroy the player instance — do not just pause.
    hlsPlayer.destroy();
    showOverlay('Playback stopped — this account is now streaming on another device.');
  });
  hlsPlayer.loadSource(s.manifestUrl());
</script>
```

## Rotation and secrets

- `HMAC_SIGNING_SECRET` — rotate quarterly. All active tokens invalidate
  when it changes; users re-authorize transparently.
- `BUNNY_SECURITY_KEY` / `NGINX_SECURE_LINK_SECRET` — rotate whenever the
  underlying zone/nginx secret rotates.
- **Never** put any of these in client-reachable code, response bodies, or
  logs. The admin UI's Edge Config tab shows them only as `${VAR_NAME}`
  placeholders.
