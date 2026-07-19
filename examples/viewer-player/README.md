# OORMAX viewer player — reference implementation

Working reference code for the viewer player described in
[`../../docs/api/08-viewer-player-lovable.txt`](../../docs/api/08-viewer-player-lovable.txt).
Drop it into the Lovable (Vite + React) app at `oormax.lovable.app`.

## Files

| File | Runs where | Purpose |
|------|-----------|---------|
| `mint-viewer.ts` | Supabase / Lovable **Edge Function** (Deno) | Holds the OOR API key, mints a short-lived viewer token. The only server-side piece. |
| `WatchPlayer.tsx` | Browser (React) | The player: live source, hls.js, ad engine, PIN gate, device-limit, kicks. |
| `watch-player.css` | Browser | Styles + shutter animation, tokens pulled from the /oor player. |

## Why the edge function is mandatory

The ad-delivery WebSocket needs a viewer JWT, and that token is minted by an
endpoint that requires your **secret API key**. The key must never reach the
browser, so `mint-viewer` is the boundary: browser → mint-viewer (key lives
here) → OOR. Everything else (PIN, signed manifest, playback, ads) is public
PIN-authed and runs straight from the browser. See §3 of the brief.

## Setup

1. **Deploy `mint-viewer`** as an edge function with these secrets:
   ```
   OOR_HOST      https://your-oor-host        # no trailing slash
   OOR_API_KEY   adi_...                       # scope playback:write (or *)
   ALLOW_ORIGIN  https://oormax.lovable.app
   ```
2. **Add the Lovable origin to the OOR CORS allowlist** for `/api/*` and
   `/v1/stream/*` (`https://oormax.lovable.app`).
3. **Client env** (Vite):
   ```
   VITE_OOR_HOST=https://your-oor-host
   VITE_MINT_URL=https://<your-project>.functions.supabase.co/mint-viewer
   ```
4. `npm i hls.js`
5. Route `/watch/:channel` → `<WatchPlayer channel={params.channel} />` and
   `import "./watch-player.css"`.

```tsx
// e.g. react-router
import WatchPlayer from "./examples/viewer-player/WatchPlayer";
import "./examples/viewer-player/watch-player.css";
// <Route path="/watch/:channel" element={<Watch/>} />
function Watch() {
  const { channel } = useParams();
  return <WatchPlayer channel={channel!} />;
}
```

## Flow (what happens on load)

1. `WatchPlayer` POSTs `{ channel }` to `mint-viewer` → `{ wsUrl, channelSlug, secured }`.
2. Opens the viewer WS (`wsUrl`). The `welcome` message says `requirePin`:
   - **false** → play `welcome.channel.liveUrl` right away.
   - **true** → show the PIN gate; on success play the signed manifest and run
     the shutter reveal (panel lifts bottom→top).
3. Ad `command`s over the WS drive the bumper → pod → resume engine. During a
   break **all player chrome is hidden**; only the bumper card / countdown show.
4. When the ad `<video>` fires `ended`, the player emits `ad.complete` — the
   backend's resume signal (§8).
5. Device-limit (409) shows the "already watching" list with per-device
   "End & play here"; a kicked device gets `session_terminated` and tears down.

## Caveats (read §11 of the brief)

- **YouTube** links can't play through `<video>`/hls.js — they need the YouTube
  IFrame API. This reference does not embed YouTube; decide per §11.
- **`.mkv`** playback is codec/browser dependent and will fail gracefully where
  the browser lacks the codec. No pure-JS fix exists.

This is reference code — wire it to your app's routing/styling conventions.
Verify against a live OOR host; nothing here is mocked.
