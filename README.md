---
title: oor-ad
emoji: 🚀
colorFrom: blue
colorTo: indigo
sdk: docker
pinned: false
---

# Ad Injection v2

Multi-tenant production platform for live-stream ad injection over WebSocket.
Everything you'd sell as an API: uploads, image + video + HLS ads, per-tenant API keys, HMAC webhooks, JWT-secured viewer tokens, analytics, OpenAPI docs.

- **Quick VPS install (isolated Docker)** → `./install.sh`
- **Complete uninstall** → `./uninstall.sh --purge`
- **HF Spaces (free)** → see `HF_SPACES.md`
- **Full API reference** → `API.md`
- **Interactive docs** → `/docs/` after start

## What's in this build

- Multi-tenant SaaS-shaped backend (tenants, API keys hashed, per-key rate limits)
- Ad library: upload video / image / HLS URLs, up to 200 MB per file
- Channels: your live streams; each has a slug + HLS URL
- Trigger API: broadcast an ad to every viewer of a channel with sub-second sync
- **Seamless A/B video swap** on the player — no blank frame, no buffering gap
- **Badge appears with the ad**, not before (bug fix)
- **Image ads**: fullscreen overlay with click-through URL, countdown timer
- **YouTube-style catch-up**: after an ad, resume the live source at (savedPosition + adDuration) so viewers never miss content
- **Viewer JWT tokens**: viewers can't connect to a channel unless your backend issues them a scoped token
- **HMAC-signed webhooks** for `ad.triggered`, `ad.completed`, `ad.resumed`
- **Analytics**: impressions, completions, viewer counts, top ads, raw event feed
- **Audit log** for every admin action
- **OpenAPI 3.1** spec + Swagger UI
- **Admin dashboard** (SPA) that exercises the same API your customers will call

## Ports

Only one port is exposed: `7860` inside the container, mapped to `6780` on the host by default (change in `docker-compose.yml`). Everything (API, WS, dashboard, docs) lives on this single port — perfect for HF Spaces / Render / behind Cloudflare.

## Endpoints at a glance

| URL | What |
|---|---|
| `/admin/`  | Dashboard SPA (login + full CRUD) |
| `/player/?ws=<encoded_ws_url>` | Viewer player |
| `/docs/`   | Swagger UI |
| `/openapi.json` | Machine-readable spec |
| `/v1/...`  | REST API (see `API.md`) |
| `/ws`      | WebSocket (viewers only; needs `?channel=<slug>&token=<viewer_jwt>`) |
| `/health`  | Liveness |

Change JWT_SECRET before running in production. Rotate API keys regularly. Read `API.md`.
