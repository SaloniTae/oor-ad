# Deploy on Hugging Face Spaces (Free, Always-On, HTTPS + WSS included)

HF Spaces gives you one container with one public port on `*.hf.space` with a valid
TLS cert — perfect for testing WebSocket apps.

## 1. Create the Space
1. Go to https://huggingface.co/new-space
2. Space SDK → **Docker**
3. Hardware → **CPU basic (free)**
4. Visibility → your choice
5. Create.

## 2. Push these files to the Space repo

You only need these paths from this project (everything else is optional):

```
Dockerfile
server/            (all files)
public/            (all files)
```

Add ONE new file at the repo root so HF recognizes the config:

**`README.md`** (Space metadata block at the top — HF reads this)

```yaml
---
title: Ad Injection Demo
emoji: 📺
colorFrom: red
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---
```

## 3. Set the secret

In the Space UI → **Settings → Variables and secrets → New secret**

| Name         | Value                                 |
|--------------|---------------------------------------|
| `ADMIN_TOKEN` | any long random string                |
| `LIVE_HLS_URL` *(optional)* | your `.m3u8` URL (defaults to the Mux test stream) |

## 4. Push and wait ~2 minutes for the build

Once healthy:

- **Viewer**  →  `https://<your-username>-<space-name>.hf.space/player/`
- **Admin**   →  `https://<your-username>-<space-name>.hf.space/admin/`

The client auto-detects same-origin mode, so `wss://` works over HF's HTTPS without any changes.

## Notes / limits

- HF free Spaces sleep after ~48h idle → wakes on first request in ~30s. Fine for testing.
- Free CPU tier handles a few hundred concurrent WS comfortably. For 1000+, move to the VPS build (`docker-compose.yml`).
- No Redis on the Space — it uses the single-process in-memory pub/sub (`server/single.js`). Perfectly fine for one container.
