/**
 * Player: HLS live stream + WebSocket-driven ad injection.
 * Auto-detects deployment mode:
 *   - Same-origin  (/ws, /api/*)     -> single-port build (HF Spaces, Render, docker-compose)
 *   - Explicit ports (:6778 / :6779) -> multi-port VPS build
 * You can force multi-port by setting <meta name="ai-mode" content="multi">.
 */
(() => {
  const video    = document.getElementById('video');
  const statusEl = document.getElementById('status');
  const badge    = document.getElementById('badge');
  const cd       = document.getElementById('countdown');
  const modeEl   = document.getElementById('mode');
  const cidEl    = document.getElementById('cid');

  const host  = location.hostname;
  const proto = location.protocol;
  const wsProto = proto === 'https:' ? 'wss' : 'ws';

  // Detection: on 6780 static server -> multi-port; otherwise single-port same-origin.
  const forced = document.querySelector('meta[name="ai-mode"]')?.content;
  const multiPort = forced ? forced === 'multi' : (location.port === '6780');

  const WS_URL     = multiPort ? `${wsProto}://${host}:6778/ws`  : `${wsProto}://${location.host}/ws`;
  const CONFIG_URL = multiPort ? `${proto}//${host}:6779/config` : `${proto}//${location.host}/api/config`;

  let hls = null;
  let liveUrl = null;
  let adTimer = null;
  let countdownTimer = null;
  // Wall-clock time when the ad started, plus the video position at that moment.
  // On resume we compute: resumeAt = savedPosition + (now - adStartedAt)  → simulates
  // "live kept playing while the ad was up", exactly like YouTube Live ad breaks.
  let savedPosition = null;
  let adStartedAt   = null;

  function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = 'status ' + (cls || ''); }
  function setMode(m) { modeEl.textContent = m; }

  function loadSource(url, { isAd = false, duration = 0, resumeAt = null } = {}) {
    if (hls) { try { hls.destroy(); } catch {} hls = null; }

    // Once the video is ready, optionally seek to a resume position within the seekable range.
    const seekWhenReady = () => {
      if (resumeAt == null) return;
      const trySeek = () => {
        try {
          const sk = video.seekable;
          if (sk && sk.length) {
            const start = sk.start(0);
            const end   = sk.end(sk.length - 1);
            // Clamp inside seekable range; if position is behind the DVR window, jump to earliest.
            const target = Math.min(Math.max(resumeAt, start + 0.1), Math.max(end - 0.5, start + 0.1));
            video.currentTime = target;
          }
        } catch {/* ignore */}
        video.removeEventListener('loadedmetadata', trySeek);
        video.removeEventListener('canplay', trySeek);
      };
      video.addEventListener('loadedmetadata', trySeek, { once: true });
      video.addEventListener('canplay',        trySeek, { once: true });
    };

    const isHls = /\.m3u8(\?|$)/i.test(url);
    if (isHls && window.Hls && Hls.isSupported()) {
      hls = new Hls({ lowLatencyMode: true, backBufferLength: 60 });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (d.fatal) setTimeout(() => loadSource(url, { isAd, duration, resumeAt }), 1500);
      });
    } else {
      video.src = url;
    }
    seekWhenReady();
    video.play().catch(() => {});

    if (isAd) {
      setMode('ad');
      badge.classList.remove('hidden');
      let remaining = Math.ceil(duration);
      cd.textContent = remaining;
      clearInterval(countdownTimer);
      countdownTimer = setInterval(() => {
        remaining--; cd.textContent = Math.max(0, remaining);
        if (remaining <= 0) clearInterval(countdownTimer);
      }, 1000);
      clearTimeout(adTimer);
      adTimer = setTimeout(() => returnToLive(), duration * 1000);
    } else {
      setMode('live');
      badge.classList.add('hidden');
      clearInterval(countdownTimer);
      clearTimeout(adTimer);
    }
  }

  function savePosition() {
    if (!isFinite(video.currentTime) || video.currentTime <= 0) return;
    savedPosition = video.currentTime;
    adStartedAt   = Date.now();
  }

  function returnToLive() {
    if (!liveUrl) return;
    // How long the ad actually kept the viewer away from live.
    const adElapsed = adStartedAt ? (Date.now() - adStartedAt) / 1000 : 0;
    // Advance the resume point by adElapsed → live "kept running" during the ad.
    const resumeAt = (savedPosition != null) ? (savedPosition + adElapsed) : null;
    savedPosition = null;
    adStartedAt   = null;
    loadSource(liveUrl, { isAd: false, resumeAt });
  }

  function applyState(state) {
    if (!state) return;
    if (state.mode === 'ad' && state.adUrl) {
      savePosition();
      const elapsed = Math.max(0, (Date.now() - (state.startAt || Date.now())) / 1000);
      const remaining = Math.max(1, (state.duration || 15) - elapsed);
      loadSource(state.adUrl, { isAd: true, duration: remaining });
    } else {
      returnToLive();
    }
  }

  function handleCommand(msg) {
    if (msg.action === 'play_ad') {
      savePosition();   // remember exact frame the live stream is on
      const elapsed = Math.max(0, (Date.now() - (msg.startAt || Date.now())) / 1000);
      const remaining = Math.max(1, msg.duration - elapsed);
      loadSource(msg.adUrl, { isAd: true, duration: remaining });
    } else if (msg.action === 'resume_live') {
      returnToLive();
    }
  }

  let backoff = 500;
  function connect() {
    setStatus('connecting…');
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      setStatus('live • connected', 'ok');
      backoff = 500;
      ws.send(JSON.stringify({ type: 'hello' }));
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'welcome') {
        liveUrl = liveUrl || m.liveUrl;
        cidEl.textContent = m.clientId;
        if (!video.src && liveUrl) loadSource(liveUrl, { isAd: false });
      } else if (m.type === 'state')   applyState(m.state);
      else if (m.type === 'command') handleCommand(m);
    };
    ws.onclose = () => {
      setStatus('reconnecting…', 'err');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  fetch(CONFIG_URL).then(r => r.json())
    .then(c => { liveUrl = c.liveUrl; if (!video.src) loadSource(liveUrl, { isAd: false }); })
    .catch(() => {});
  connect();
})();
