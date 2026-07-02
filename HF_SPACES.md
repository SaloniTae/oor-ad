## Hugging Face Spaces (free, always-on, HTTPS + WSS included)

1. Create a **Docker** Space at https://huggingface.co/new-space (CPU basic).
2. Push these files:
   - `Dockerfile`
   - `server/` (whole directory)
   - `public/` (whole directory)
3. Add a top-level `README.md` with HF metadata:
   ```yaml
   ---
   title: Ad Injection
   sdk: docker
   app_port: 7860
   pinned: false
   ---
   ```
4. In **Settings → Variables and secrets**, add:
   - `JWT_SECRET` — 48+ random chars (required)
   - `BOOTSTRAP_ADMIN_EMAIL` — your email (optional but recommended)
   - `BOOTSTRAP_ADMIN_PASSWORD` — your login password (optional)
   - `PUBLIC_URL` — `https://<user>-<space>.hf.space` (needed so viewer URLs use HTTPS)
5. Push → wait ~2 min for the build.
6. Open `https://<user>-<space>.hf.space/admin/` and log in.

### Notes / limits

- Free CPU tier: ~1500–2500 concurrent viewers is realistic. HF's proxy caps you before Node does.
- Free Spaces sleep after ~48 h idle → 20–30 s cold start on next request.
- Persistent data lives on the Space's disk. For durability, either upgrade to Persistent Storage or use the VPS install and keep the SQLite file in a Docker volume (default).
- To scale past HF limits, move to the VPS build — same code, just run `./install.sh`.
