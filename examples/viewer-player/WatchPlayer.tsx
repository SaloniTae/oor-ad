/**
 * WatchPlayer — production viewer player for oormax.lovable.app/watch/:channel
 *
 * Implements docs/api/08-viewer-player-lovable.txt end to end:
 *   • mints a viewer token via the mint-viewer edge fn (§3)
 *   • opens the ad-delivery viewer WS and plays the live source (§5,§6)
 *   • bumper + pod ad engine, hides all chrome during breaks, emits ad.complete (§7,§8)
 *   • PIN gate + shutter reveal for secured channels (§9)
 *   • ask-before-kick device-limit flow + kick teardown (§10)
 *
 * Requires hls.js:  npm i hls.js
 * Drop <WatchPlayer/> under a route like /watch/:channel and pass MINT_URL/OOR_HOST.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";

// ---- config ----------------------------------------------------------------
const OOR_HOST = import.meta.env.VITE_OOR_HOST as string;       // https://your-oor-host
const MINT_URL = import.meta.env.VITE_MINT_URL as string;       // /functions/v1/mint-viewer
const DEVICE_KEY = "oor.streamsec.deviceId";
const KICK_FLAG = "oor.sec.kicked";

// ---- small utils -----------------------------------------------------------
const isHlsUrl = (u: string) => /\.m3u8(\?|$)/i.test(u);
const isImageUrl = (u: string) =>
  /\.(png|jpe?g|webp|gif|avif|heic|heif|bmp)(\?|$)/i.test(u.split("#")[0]);

function getDeviceId(): string {
  let d = localStorage.getItem(DEVICE_KEY);
  if (!d) {
    d = crypto.randomUUID?.() ??
      Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((x) => x.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(DEVICE_KEY, d);
  }
  return d;
}
function inferAdType(a: { adType?: string; adUrl?: string }): "video" | "hls" | "image" {
  if (a.adType === "hls" || a.adType === "image" || a.adType === "video") return a.adType;
  const u = String(a.adUrl || "");
  if (isHlsUrl(u)) return "hls";
  if (isImageUrl(u)) return "image";
  return "video";
}
function fmtSince(ms?: number): string {
  if (!ms) return "just now";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ---- types -----------------------------------------------------------------
type PodAd = { adId?: string; adType?: string; adUrl: string; duration: number; metadata?: { click_url?: string } };
type ActiveSession = { sessionId: string; deviceLabel?: string; ip?: string; connectedAt?: number };
type Screen = "loading" | "pin" | "devices" | "terminated" | "playing" | "unavailable";

export default function WatchPlayer({ channel }: { channel: string }) {
  const liveRef = useRef<HTMLVideoElement>(null);
  const adRef = useRef<HTMLVideoElement>(null);
  const liveHls = useRef<Hls | null>(null);
  const adHls = useRef<Hls | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const lifecycleWs = useRef<WebSocket | null>(null);
  const heartbeat = useRef<ReturnType<typeof setInterval> | null>(null);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);

  // session/auth state kept in refs (not re-rendered)
  const streamToken = useRef<string | null>(null);
  const channelSlug = useRef<string>("");
  const liveUrl = useRef<string | null>(null);
  const pinRef = useRef<string>("");

  // ad engine state
  const pod = useRef<PodAd[]>([]);
  const podStartAt = useRef(0);
  const podBumperSec = useRef(7);
  const triggerId = useRef<string | null>(null);
  const phase = useRef<string>("live");   // 'live' | 'bumper' | 'ad:<i>'
  const mode = useRef<"live" | "ad">("live");

  // UI state
  const [screen, setScreen] = useState<Screen>("loading");
  const [inAd, setInAd] = useState(false);
  const [bumper, setBumper] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [imageAd, setImageAd] = useState<{ url: string; click?: string } | null>(null);
  const [devices, setDevices] = useState<{ list: ActiveSession[]; max: number }>({ list: [], max: 1 });
  const [pinValue, setPinValue] = useState("");
  const [pinErr, setPinErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [shutter, setShutter] = useState(false);   // shutter panel present (lifts up)

  // ---- media loading -------------------------------------------------------
  const loadLive = useCallback((url: string) => {
    const el = liveRef.current!;
    if (liveHls.current) { liveHls.current.destroy(); liveHls.current = null; }
    if (isHlsUrl(url) && Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: true, backBufferLength: 30 });
      liveHls.current = hls;
      hls.attachMedia(el);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(url));
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) { try { hls.recoverMediaError(); } catch {} }
      });
    } else {
      el.src = url; try { el.load(); } catch {}
    }
    el.play().catch(() => {});
  }, []);

  const loadAdVideo = useCallback((url: string, seek = 0) => {
    const el = adRef.current!;
    if (adHls.current) { adHls.current.destroy(); adHls.current = null; }
    try { el.pause(); } catch {}
    el.removeAttribute("src"); try { el.load(); } catch {}
    el.muted = true;
    if (isHlsUrl(url) && Hls.isSupported()) {
      const hls = new Hls();
      adHls.current = hls;
      hls.attachMedia(el);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(url));
      hls.on(Hls.Events.MANIFEST_PARSED, () => { if (seek > 0) el.currentTime = seek; });
    } else {
      el.src = url;
      try { el.load(); if (seek > 0) el.addEventListener("loadedmetadata", () => { el.currentTime = seek; }, { once: true }); } catch {}
    }
  }, []);

  const unloadAd = useCallback(() => {
    if (adHls.current) { adHls.current.destroy(); adHls.current = null; }
    const el = adRef.current;
    if (el) { try { el.pause(); } catch {} el.removeAttribute("src"); try { el.load(); } catch {} }
  }, []);

  // ---- reporting -----------------------------------------------------------
  const report = useCallback((name: string, meta?: object) => {
    const s = ws.current;
    if (!s || s.readyState !== 1) return;
    try { s.send(JSON.stringify({ type: "event", name, triggerId: triggerId.current, meta })); } catch {}
  }, []);

  // ---- ad engine (the ~100ms ticker; frame-synced from server clock) -------
  const returnToLive = useCallback(() => {
    if (ticker.current) { clearInterval(ticker.current); ticker.current = null; }
    unloadAd();
    setInAd(false); setBumper(false); setImageAd(null); setCountdown(0);
    const wasAd = mode.current === "ad";
    mode.current = "live"; phase.current = "live"; pod.current = [];
    if (liveRef.current) { liveRef.current.muted = false; liveRef.current.play().catch(() => {}); }
    if (wasAd) report("ad.complete");   // §8: resume signal (safe to send always)
  }, [report, unloadAd]);

  const tick = useCallback(() => {
    if (mode.current !== "ad" || pod.current.length === 0) return;
    const elapsed = Math.max(0, (Date.now() - podStartAt.current) / 1000);

    if (elapsed < podBumperSec.current) {              // 1. bumper
      if (phase.current !== "bumper") {
        phase.current = "bumper";
        setBumper(true); setImageAd(null);
        if (adRef.current) adRef.current.classList.remove("on");
      }
      return;
    }
    let acc = podBumperSec.current, target = "live", ad: PodAd | null = null, adElapsed = 0, remaining = 0;
    for (let i = 0; i < pod.current.length; i++) {     // 2. which ad
      const a = pod.current[i], start = acc, end = acc + a.duration;
      if (elapsed >= start && elapsed < end) { target = `ad:${i}`; ad = a; adElapsed = elapsed - start; remaining = end - elapsed; break; }
      acc += a.duration;
    }
    if (target === "live") { returnToLive(); return; } // 3. pod done

    if (phase.current !== target && ad) {              // 4. new ad slot
      phase.current = target;
      setBumper(false);
      const type = inferAdType(ad);
      if (type === "image") {
        unloadAd();
        setImageAd({ url: ad.adUrl, click: ad.metadata?.click_url });
        if (liveRef.current) liveRef.current.muted = true;
      } else {
        setImageAd(null);
        if (adRef.current) adRef.current.classList.add("on");
        const idx = parseInt(target.split(":")[1], 10);
        if (idx !== 0) loadAdVideo(ad.adUrl, adElapsed);
        else if (adElapsed > 0.5 && adRef.current) adRef.current.currentTime = adElapsed;
        if (adRef.current) { adRef.current.muted = false; adRef.current.play().catch(() => {}); }
        if (liveRef.current) liveRef.current.muted = true;
      }
      report("ad.impression", { adId: ad.adId, phase: target });
    }
    setCountdown(Math.ceil(remaining));
  }, [loadAdVideo, report, returnToLive, unloadAd]);

  const startPod = useCallback((ads: PodAd[], startAt: number, bumperSec: number, tid: string | null) => {
    if (ticker.current) { clearInterval(ticker.current); ticker.current = null; }
    unloadAd();
    pod.current = ads.map((a) => ({ ...a, adType: inferAdType(a) }));
    podStartAt.current = startAt || Date.now();
    podBumperSec.current = bumperSec || 7;
    triggerId.current = tid;
    phase.current = "live"; mode.current = "ad";
    setInAd(true);
    const first = pod.current[0];
    if (first) { if (inferAdType(first) === "image") setImageAd({ url: first.adUrl, click: first.metadata?.click_url }); else loadAdVideo(first.adUrl, 0); }
    ticker.current = setInterval(tick, 100);
    tick();
  }, [loadAdVideo, tick, unloadAd]);

  const applyState = useCallback((state: any) => {
    if (!state) return;
    if (state.mode === "pod" && state.pod?.length) startPod(state.pod, state.startAt, state.bumper, state.triggerId);
    else if (state.mode === "ad" && state.adUrl) startPod([{ adId: state.adId, adType: inferAdType(state), adUrl: state.adUrl, duration: state.duration || 15, metadata: state.metadata }], state.startAt, state.bumper, state.triggerId);
    else if (mode.current === "ad") returnToLive();
  }, [returnToLive, startPod]);

  // When the ad <video> ends naturally, that is the resume signal (§8).
  useEffect(() => {
    const el = adRef.current; if (!el) return;
    const onEnded = () => { if (mode.current === "ad") report("ad.complete"); };
    const onErr = () => report("error:ad_playback_failed");
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onErr);
    return () => { el.removeEventListener("ended", onEnded); el.removeEventListener("error", onErr); };
  }, [report]);

  // ---- viewer WS (ads) -----------------------------------------------------
  const connectViewerWs = useCallback((wsUrl: string) => {
    let backoff = 500;
    const open = () => {
      const s = new WebSocket(wsUrl);
      ws.current = s;
      s.onopen = () => { backoff = 500; try { s.send(JSON.stringify({ type: "hello" })); } catch {} };
      s.onmessage = (ev) => {
        let m: any; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "welcome") {
          channelSlug.current = m.channel?.slug || channelSlug.current;
          if (m.channel && !m.channel.requirePin) {           // OPEN channel
            liveUrl.current = m.channel.liveUrl;
            if (liveUrl.current) { loadLive(liveUrl.current); setScreen("playing"); }
          } else {                                            // SECURED -> gate
            maybeShowGate();
          }
        } else if (m.type === "state") applyState(m.state);
        else if (m.type === "command") {
          if (m.action === "play_pod") applyState({ mode: "pod", pod: m.pod, startAt: m.startAt, bumper: m.bumper, triggerId: m.triggerId });
          else if (m.action === "play_ad") applyState({ mode: "ad", adId: m.adId, adType: m.adType, adUrl: m.adUrl, duration: m.duration, startAt: m.startAt, bumper: m.bumper, triggerId: m.triggerId, metadata: m.metadata });
          else if (m.action === "resume_live") returnToLive();
        }
      };
      s.onclose = (ev) => {
        if (ev.code === 4401 || ev.code === 4404) { setScreen("unavailable"); return; }  // do not retry
        setTimeout(open, backoff); backoff = Math.min(backoff * 2, 15000);
      };
      s.onerror = () => { try { s.close(); } catch {} };
    };
    open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyState, loadLive, returnToLive]);

  // ---- secured flow: PIN gate + device limit (§9,§10) ----------------------
  const maybeShowGate = useCallback(() => {
    let kicked: string | null = null;
    try { kicked = sessionStorage.getItem(KICK_FLAG); } catch {}
    setScreen(kicked ? "terminated" : "pin");
  }, []);

  const postStream = async (path: string, body: object) => {
    const r = await fetch(`${OOR_HOST}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, body: j };
  };

  const startHeartbeat = useCallback((sec: number) => {
    if (heartbeat.current) clearInterval(heartbeat.current);
    heartbeat.current = setInterval(async () => {
      try {
        const r = await fetch(`${OOR_HOST}/v1/stream/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${streamToken.current}` } });
        if (r.status === 403) onTerminated("server_terminated");
      } catch {}
    }, Math.max(15, sec) * 1000);
  }, []);

  const onTerminated = useCallback((reason: string) => {
    if (heartbeat.current) { clearInterval(heartbeat.current); heartbeat.current = null; }
    try { sessionStorage.setItem(KICK_FLAG, reason); } catch {}
    if (liveHls.current) { liveHls.current.destroy(); liveHls.current = null; }   // DESTROY, not pause (§13)
    if (liveRef.current) { try { liveRef.current.pause(); liveRef.current.removeAttribute("src"); liveRef.current.load(); } catch {} }
    setScreen("terminated");
  }, []);

  const connectLifecycle = useCallback(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${OOR_HOST.replace(/^https?:/, proto)}/stream-ws?stoken=${encodeURIComponent(streamToken.current!)}`;
    const s = new WebSocket(url);
    lifecycleWs.current = s;
    s.onmessage = (ev) => { let m: any; try { m = JSON.parse(ev.data); } catch { return; } if (m.type === "session_terminated") onTerminated(m.reason || "kicked"); };
    s.onclose = (ev) => { if (ev.code === 4408) onTerminated("session_terminated"); };
  }, [onTerminated]);

  // shutter reveal (§9): panel present -> lift up -> playing
  const grantAndPlay = useCallback(() => {
    try { sessionStorage.removeItem(KICK_FLAG); } catch {}
    liveUrl.current = `${OOR_HOST}/v1/stream/manifest.m3u8?stoken=${encodeURIComponent(streamToken.current!)}`;
    connectLifecycle();
    loadLive(liveUrl.current);
    setShutter(true);            // panel covers player
    setScreen("playing");
    requestAnimationFrame(() => setTimeout(() => setShutter(false), 30));  // trigger the lift
  }, [connectLifecycle, loadLive]);

  const submitPin = useCallback(async () => {
    if (busy) return;
    const pin = pinValue.trim();
    if (!/^[0-9]{6,8}$/.test(pin)) { setPinErr("Enter the 6–8 digit PIN."); return; }
    setBusy(true); setPinErr("Checking…");
    pinRef.current = pin;
    try {
      const { status, body } = await postStream("/v1/stream/authorize", { pin, deviceId: getDeviceId(), channelSlug: channelSlug.current });
      if (status === 200) { streamToken.current = body.streamToken; startHeartbeat(body.heartbeatSec || 30); setPinErr(""); grantAndPlay(); }
      else if (status === 409) { setDevices({ list: body.activeSessions || [], max: body.maxDevices || 1 }); setScreen("devices"); setPinErr(""); }
      else if (status === 401) setPinErr("That PIN wasn't recognised.");
      else if (status === 403) setPinErr("This PIN isn't valid for this channel.");
      else if (status === 404) setPinErr("Channel not found.");
      else if (status === 429) setPinErr("Too many attempts. Try again shortly.");
      else setPinErr(body?.error?.message || "Something went wrong.");
    } catch { setPinErr("Network error. Try again."); }
    finally { setBusy(false); }
  }, [busy, pinValue, startHeartbeat, grantAndPlay]);

  const confirmKick = useCallback(async (sessionIdToKick: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const { status, body } = await postStream("/v1/stream/confirm-kick", { pin: pinRef.current, deviceId: getDeviceId(), channelSlug: channelSlug.current, sessionIdToKick });
      if (status === 200) { streamToken.current = body.streamToken; startHeartbeat(body.heartbeatSec || 30); grantAndPlay(); }
      else setPinErr("Couldn't end that session. Try again.");
    } catch { setPinErr("Network error. Try again."); }
    finally { setBusy(false); }
  }, [busy, startHeartbeat, grantAndPlay]);

  // ---- boot: mint token, then open viewer WS -------------------------------
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(MINT_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel }) });
        const j = await r.json();
        if (!alive) return;
        if (!r.ok || !j.wsUrl) { setScreen("unavailable"); return; }
        channelSlug.current = j.channelSlug || "";
        connectViewerWs(j.wsUrl);
      } catch { if (alive) setScreen("unavailable"); }
    })();
    return () => {
      alive = false;
      [ticker, heartbeat].forEach((r) => r.current && clearInterval(r.current));
      [ws, lifecycleWs].forEach((r) => { try { r.current?.close(); } catch {} });
      [liveHls, adHls].forEach((r) => { try { r.current?.destroy(); } catch {} });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  // ---- render --------------------------------------------------------------
  const chromeHidden = inAd;   // §7: hide ALL player chrome during a break
  return (
    <div className="oor-stage">
      <video ref={liveRef} className="oor-v oor-live" playsInline autoPlay preload="auto" />
      <video ref={adRef} className="oor-v oor-ad" playsInline preload="auto" />

      {imageAd && (
        <a className="oor-img-layer on" href={imageAd.click || undefined} target="_blank" rel="noopener">
          <img src={imageAd.url} alt="advertisement" />
        </a>
      )}

      {bumper && <div className="oor-badge oor-bumper show">We&apos;ll be right back</div>}
      {inAd && !bumper && countdown > 0 && <div className="oor-badge show">Ad will end in {countdown}s</div>}

      {/* Shutter panel: present after grant, lifts bottom->top to reveal player (§9) */}
      {screen === "playing" && <div className={`oor-shutter${shutter ? "" : " oor-shutter-up"}`} aria-hidden />}

      {!chromeHidden && screen === "playing" && (
        <button className="oor-unmute" onClick={() => { if (liveRef.current) { liveRef.current.muted = false; liveRef.current.play().catch(() => {}); } }}>
          Tap to Unmute
        </button>
      )}

      {screen === "loading" && <div className="oor-overlay"><div className="oor-card"><p className="oor-sub">Loading…</p></div></div>}

      {screen === "pin" && (
        <div className="oor-overlay">
          <div className="oor-card">
            <div className="oor-lock" aria-hidden>🔒</div>
            <h1 className="oor-title">Enter your PIN</h1>
            <p className="oor-sub">This stream is protected. Enter the PIN you were given to start watching.</p>
            <form onSubmit={(e) => { e.preventDefault(); submitPin(); }}>
              <input className="oor-pin" inputMode="numeric" pattern="[0-9]*" maxLength={8} placeholder="••••••"
                autoComplete="one-time-code" aria-label="PIN" value={pinValue}
                onChange={(e) => setPinValue(e.target.value.replace(/[^0-9]/g, ""))} />
              <button className="oor-btn oor-btn-primary" type="submit" disabled={busy}>Watch</button>
            </form>
            <div className="oor-err" role="alert">{pinErr}</div>
          </div>
        </div>
      )}

      {screen === "devices" && (
        <div className="oor-overlay">
          <div className="oor-card">
            <div className="oor-lock oor-lock-warn" aria-hidden>⚠️</div>
            <h1 className="oor-title">Already watching elsewhere</h1>
            <p className="oor-sub">This PIN allows {devices.max} device{devices.max === 1 ? "" : "s"}. End a session below to watch here, or go back and try later.</p>
            <div className="oor-list">
              {devices.list.length ? devices.list.map((s) => (
                <div className="oor-device" key={s.sessionId}>
                  <div className="oor-device-meta">
                    <div className="oor-device-name">{s.deviceLabel || "Unknown device"}</div>
                    <div className="oor-device-sub">{s.ip ? `${s.ip} · ` : ""}connected {fmtSince(s.connectedAt)}</div>
                  </div>
                  <button className="oor-btn oor-btn-danger" disabled={busy} onClick={() => confirmKick(s.sessionId)}>End &amp; play here</button>
                </div>
              )) : <div className="oor-device-sub">No other sessions found — go back and try again.</div>}
            </div>
            <button className="oor-btn oor-btn-ghost" onClick={() => { setScreen("pin"); setPinValue(""); setPinErr(""); }}>← Back</button>
            <div className="oor-err" role="alert">{pinErr}</div>
          </div>
        </div>
      )}

      {screen === "terminated" && (
        <div className="oor-overlay">
          <div className="oor-card">
            <div className="oor-lock oor-lock-warn" aria-hidden>⛔</div>
            <h1 className="oor-title">Playback stopped</h1>
            <p className="oor-sub">This account is now watching on another device.</p>
            <button className="oor-btn oor-btn-primary" onClick={() => { try { sessionStorage.removeItem(KICK_FLAG); } catch {} setScreen("pin"); setPinValue(""); setPinErr(""); }}>Watch here instead</button>
          </div>
        </div>
      )}

      {screen === "unavailable" && (
        <div className="oor-overlay"><div className="oor-card"><h1 className="oor-title">Stream unavailable</h1><p className="oor-sub">This channel can&apos;t be reached right now.</p></div></div>
      )}
    </div>
  );
}
