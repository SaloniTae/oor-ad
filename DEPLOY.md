# Ad Injection — Production Deployment Guide (Contabo VPS, Ubuntu 22.04/24.04)

This ships a **real-time ad injection** system for HLS live streams. One admin click switches
every connected viewer to an ad, then back to live — with sub-second sync across 1000+ clients.

## What's inside

```
ad-injection/
├── server/            Node.js clustered WS + Admin API + static server
│   ├── index.js       (cluster, ws, redis pub/sub, admin REST, auth, RL, HB)
│   ├── package.json
│   └── .env.example
├── public/
│   ├── player/        Viewer page (HLS.js + WS client, auto-reconnect + state sync)
│   └── admin/         Admin panel (trigger ad / resume live / stats)
└── deploy/
    ├── nginx.conf         reverse proxy for /ws /api /
    ├── ad-injection.service   systemd unit
    ├── sysctl.conf        kernel tuning for 10k+ sockets
    └── limits.conf        file-descriptor limits
```

## Architecture

```
                       ┌────────────────────────┐
Admin browser ──POST──▶│  Admin API (:6779)     │
                       │  auth + rate-limit     │
                       └───────────┬────────────┘
                                   │ PUBLISH ad:commands
                                   ▼
                       ┌────────────────────────┐
                       │        Redis           │◀── shared across every worker/VPS
                       └───────────┬────────────┘
                                   │ SUBSCRIBE
                                   ▼
       ┌───────────────────────────────────────────────┐
       │ Node cluster: N workers on the same box       │
       │  ┌─────────┐  ┌─────────┐  ┌─────────┐        │
       │  │worker 1 │  │worker 2 │  │worker N │  ...   │
       │  │ WS :6778│  │ WS :6778│  │ WS :6778│        │
       │  └────┬────┘  └────┬────┘  └────┬────┘        │
       └───────┼─────────────┼────────────┼─────────────┘
               ▼             ▼            ▼
            viewers      viewers      viewers   (each worker fans out to its own sockets)
```

- **Concurrency**: `cluster` module + `SO_REUSEPORT` load-balancing (Node handles this).
  Each worker owns a fraction of the sockets. Broadcast cost = O(clients_on_this_worker) and runs in parallel across workers.
- **Cross-worker + cross-machine fan-out**: Redis Pub/Sub. Adding a second VPS pointing at the same Redis instantly doubles capacity.
- **Late joiners**: server stores current state in Redis (`ad:state`). New viewers receive it on connect and jump into the ad mid-play using `startAt` for time alignment.
- **Auth**: `ADMIN_TOKEN` bearer for the admin API. Rotate if leaked.
- **Robustness**: heartbeats every 30s, exponential backoff on the client, systemd auto-restart, PM2-style clustering, request rate limiting.

## Ports

| Port | Service         | Public? |
|------|-----------------|---------|
| 6778 | WebSocket (viewers) | Yes (direct) or via Nginx `/ws` |
| 6779 | Admin REST API      | Restrict to your IP or via Nginx `/api/` |
| 6780 | Static (player + admin UI) | Yes (or via Nginx `/`) |
| 6379 | Redis                | **Localhost only** — never expose |

---

## Step-by-step: fresh Contabo Ubuntu VPS

Replace `YOUR_VPS_IP` with your Contabo IP throughout.

### 1) SSH in and update

```bash
ssh root@YOUR_VPS_IP
apt update && apt upgrade -y
```

### 2) Install Node 20, Redis, Nginx, tools

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs redis-server nginx ufw git
node -v && npm -v
systemctl enable --now redis-server
```

### 3) Create a non-root user and drop the code

```bash
adduser --system --group --home /opt/ad-injection adinject
mkdir -p /opt/ad-injection
# Upload the ad-injection folder to the VPS. Two easy ways:
#  (a) scp:  scp -r ad-injection/* root@YOUR_VPS_IP:/opt/ad-injection/
#  (b) git clone your repo into /opt/ad-injection
chown -R adinject:adinject /opt/ad-injection
cd /opt/ad-injection/server
sudo -u adinject npm ci --omit=dev   # or: npm install --production
```

### 4) Configure `.env`

```bash
cd /opt/ad-injection/server
cp .env.example .env
# Generate a strong token:
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
nano .env
```

Set at minimum:
```
PUBLIC_HOST=YOUR_VPS_IP
ADMIN_TOKEN=<paste the generated token>
REDIS_URL=redis://127.0.0.1:6379
LIVE_HLS_URL=https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
```

### 5) Kernel + FD tuning (needed for 1000+ concurrent)

```bash
cat /opt/ad-injection/deploy/sysctl.conf >> /etc/sysctl.conf
sysctl -p
cat /opt/ad-injection/deploy/limits.conf >> /etc/security/limits.conf
# systemd services also need this via LimitNOFILE in the unit (already set).
```

### 6) Install the systemd service

```bash
cp /opt/ad-injection/deploy/ad-injection.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ad-injection
systemctl status ad-injection --no-pager
journalctl -u ad-injection -f    # live logs
```

Expected log: `Static site http://0.0.0.0:6780`, `WS viewer ws://0.0.0.0:6778/ws`, `Admin API http://0.0.0.0:6779`, plus one `worker subscribed to ad:commands` per CPU.

### 7) Firewall

```bash
ufw allow OpenSSH
ufw allow 6778/tcp   # WS
ufw allow 6779/tcp   # Admin API (better: restrict to your IP, see below)
ufw allow 6780/tcp   # Static
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

**Restrict admin API to your IP** (recommended):
```bash
ufw delete allow 6779/tcp
ufw allow from YOUR_HOME_IP to any port 6779 proto tcp
```

### 8) Nginx reverse proxy (recommended)

```bash
cp /opt/ad-injection/deploy/nginx.conf /etc/nginx/sites-available/ad-injection
ln -sf /etc/nginx/sites-available/ad-injection /etc/nginx/sites-enabled/ad-injection
rm -f /etc/nginx/sites-enabled/default
# Raise worker_connections for many WS clients:
sed -i 's/worker_connections .*/worker_connections 20000;/' /etc/nginx/nginx.conf
echo "worker_rlimit_nofile 40000;" >> /etc/nginx/nginx.conf
nginx -t && systemctl reload nginx
```

### 9) (Optional) HTTPS with a domain

Point a domain A-record at `YOUR_VPS_IP`, then:
```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.com
```
Uncomment the `443` block in `deploy/nginx.conf`, reload Nginx.
Update the player's WS URL to `wss://your-domain.com/ws` (edit `public/player/app.js` if you switch to path-based routing behind Nginx).

---

## Using it

- **Viewer page**:  `http://YOUR_VPS_IP:6780/player/`  (or `http://YOUR_VPS_IP/` via Nginx)
- **Admin panel**:  `http://YOUR_VPS_IP:6780/admin/`
  1. Paste your `ADMIN_TOKEN`, click Save.
  2. Enter an ad URL (HLS `.m3u8` or MP4) + duration.
  3. Hit **Trigger Ad Now** — every viewer switches instantly. Hit **Resume Live** to force early return.
- **Trigger from curl / your own backend**:
  ```bash
  curl -X POST http://YOUR_VPS_IP:6779/trigger-ad \
       -H "Authorization: Bearer $ADMIN_TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"adUrl":"https://.../ad.m3u8","duration":15}'
  ```

## Capacity guidance

| VPS profile             | Rough concurrent viewers |
|-------------------------|--------------------------|
| 2 vCPU / 4 GB           | 3,000–5,000              |
| 4 vCPU / 8 GB (Contabo) | 8,000–15,000             |
| 8 vCPU / 16 GB          | 20,000–40,000            |

Numbers assume mostly idle WebSockets (heartbeat + occasional broadcast). HLS video itself is served by your CDN / origin, not this box.

## Scaling out

1. Bring up a second VPS with the same service, same `REDIS_URL` pointing to VPS #1 (or a managed Redis).
2. Put both behind a TCP/HTTPS load balancer (Cloudflare Load Balancer, HAProxy, or Nginx stream).
3. Sticky sessions are **not** required — every worker gets the same broadcast via Redis.

## Verifying it works

```bash
# On the VPS:
systemctl status ad-injection
ss -tlnp | grep -E '6778|6779|6780'
redis-cli PING          # PONG
# Local smoke test:
curl http://127.0.0.1:6779/healthz
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:6779/stats
```

Open two browser tabs of the player page, then hit **Trigger Ad Now** in the admin panel — both should switch to the ad within ~500 ms and return to live automatically after the duration.

## Common issues

- **Viewer stays on "connecting…"** → firewall blocking 6778, or you're on HTTPS but hitting `ws://` (mixed content). Use Nginx + TLS for `wss://`.
- **401 from admin API** → wrong / missing `ADMIN_TOKEN` in browser localStorage; re-save in the admin panel.
- **Ad doesn't play in some browsers** → your ad URL isn't CORS-enabled or isn't a valid HLS/MP4. Test the URL directly in an HTML5 `<video>` first.
- **Everything works locally but not remotely** → UFW not opened, or Contabo panel firewall blocking ports.

## Security checklist

- [ ] `ADMIN_TOKEN` is 32+ random chars.
- [ ] Admin port 6779 restricted to your IP (or only exposed via Nginx behind auth).
- [ ] TLS on (Let's Encrypt) if you have a domain.
- [ ] Redis bound to 127.0.0.1 (default in Ubuntu package — verify with `ss -tlnp | grep 6379`).
- [ ] Keep the VPS updated: `unattended-upgrades`.
