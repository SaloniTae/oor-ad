# Ad Injection

Real-time, WebSocket-driven ad injection for HLS livestreams. One admin click switches every connected viewer to an ad, then back to live — with sub-second sync across 1000+ clients.

- Live stream (demo): `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`
- Ports: `6778` (WS), `6779` (Admin API), `6780` (static UI)
- Stack: Node 20 · `ws` · Redis pub/sub · Node cluster · Nginx · systemd

See **DEPLOY.md** for a step-by-step Contabo VPS setup.

## Quick local test

```bash
cd server
cp .env.example .env    # set ADMIN_TOKEN
npm install
node index.js
```

Open `http://localhost:6780/player/` and `http://localhost:6780/admin/`.
