/**
 * Seamless HLS ad injection with A/B double-video swap.
 * ----------------------------------------------------
 * Two <video> elements are stacked in the DOM. One is visible ("front"),
 * the other is invisible ("back") and used to preload the NEXT source
 * (the ad, or the live stream at the catch-up position). Only after the
 * back video reaches `canplay` do we swap classes — no blank frame, no
 * spinner. This is how broadcast players avoid the reload gap.
 *
 * Catch-up: when an ad starts we save (savedPos, wallClockStart).
 * When the ad ends, we resume the live stream at savedPos + elapsedWallClock,
 * i.e. exactly as if live had kept playing in the background (YouTube-style).
 */
(() => {
  const videoA  = document.getElementById('videoA');
  const videoB  = document.getElementById('videoB');
  const statusEl= document.getElementById('status');
  const badge   = document.getElementById('badge');
  const cd      = document.getElementById('countdown');
  const modeEl  = document.getElementById('mode');
  const cidEl   = document.getElementById('cid');
  const unmute  = document.getElementById('unmute');

  const host    = location.hostname;
  const proto   = location.protocol;
  const wsProto = proto === 'https:' ? 'wss' : 'ws';
  const forced  = document.querySelector('meta[name="ai-mode"]')?.content;
  const multiPort = forced ? forced === 'multi' : (location.port === '6780');
  const WS_URL     = multiPort ? `${wsProto}://${host}:6778/ws`  : `${wsProto}://${location.host}/ws`;
  const CONFIG_URL = multiPort ? `${proto}//${host}:6779/config` : `${proto}//${location.host}/api/config`;

  // Each slot holds { el, hls }. Front is the one currently on screen.
  const slots = {
    A: { el: videoA, hls: null },
    B: { el: videoB, hls: null },
  };
  let frontKey = 'A';
  const front = () => slots[frontKey];
  const back  = () => slots[frontKey === 'A' ? 'B' : 'A'];

  let liveUrl       = null;
  let adTimer       = null;
  let countdownTimer= null;
  let savedPosition = null;  // playhead when the ad started
  let adStartedAt   = null;  // wall-clock ms when the ad started
  let currentMode   = 'live';

  const setStatus = (t, cls) => { statusEl.textContent = t; statusEl.className = 'status ' + (cls||''); };
  const setMode   = (m) => { currentMode = m; modeEl.textContent = m; };

  unmute.onclick = () => {
    [videoA, videoB].forEach(v => { v.muted = false; v.volume = 1; });
    front().el.play().catch(()=>{});
    unmute.textContent = '🔊 Sound on';
  };

  function newHlsConfig() {
    return {
      // Aggressive prefetch & buffer to keep the pipeline full.
      lowLatencyMode: true,
      startFragPrefetch: true,
      maxBufferLength: 30,
      backBufferLength: 60,
      maxMaxBufferLength: 60,
      // Faster recovery from a single bad segment (avoids visible stall).
      manifestLoadingMaxRetry: 4,
      manifestLoadingRetryDelay: 500,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 500,
      // Start playback as soon as a fragment is ready, not after N.
      autoStartLoad: true,
    };
  }

  function destroySlot(key) {
    const s = slots[key];
    if (s.hls) { try { s.hls.destroy(); } catch {} s.hls = null; }
    try { s.el.pause(); } catch {}
    // We deliberately DON'T clear src on the front slot until after swap.
  }

  /**
   * Load `url` into the BACK slot, seek to `resumeAt` if given,
   * wait for it to be truly ready (canplay + first frame), then swap to front.
   * Resolves once the swap has happened.
   */
  function loadOnBackAndSwap(url, { resumeAt = null, isAd = false } = {}) {
    return new Promise((resolve) => {
      const key = frontKey === 'A' ? 'B' : 'A';
      const s = slots[key];
      // Reset the back slot cleanly.
      destroySlot(key);
      s.el.removeAttribute('src'); s.el.load();

      let swapped = false;
      const doSwap = () => {
        if (swapped) return; swapped = true;
        // Ensure back is playing before we make it visible.
        const playPromise = s.el.play();
        const finalize = () => {
          // Swap CSS classes: back becomes visible, front becomes hidden.
          slots[key].el.classList.add('active');
          slots[frontKey].el.classList.remove('active');
          // Pause and free the old front (after a tick so its last frame isn't visible while fading).
          const oldFront = frontKey;
          frontKey = key;
          setTimeout(() => destroySlot(oldFront), 200);
          resolve();
        };
        if (playPromise && playPromise.then) playPromise.then(finalize, finalize);
        else finalize();
      };

      // Seek + play once we know metadata / first frame is ready.
      const onCanPlay = () => {
        s.el.removeEventListener('canplay', onCanPlay);
        s.el.removeEventListener('loadeddata', onCanPlay);
        if (resumeAt != null) {
          try {
            const sk = s.el.seekable;
            if (sk && sk.length) {
              const start = sk.start(0);
              const end   = sk.end(sk.length - 1);
              const target = Math.min(Math.max(resumeAt, start + 0.1), Math.max(end - 0.5, start + 0.1));
              s.el.currentTime = target;
              // After the seek settles, THEN swap (avoids showing pre-seek frame).
              const onSeeked = () => { s.el.removeEventListener('seeked', onSeeked); doSwap(); };
              s.el.addEventListener('seeked', onSeeked, { once: true });
              // Safety: if `seeked` never fires within 800ms, swap anyway.
              setTimeout(doSwap, 800);
              return;
            }
          } catch {/* fall through to immediate swap */}
        }
        doSwap();
      };
      s.el.addEventListener('canplay',    onCanPlay, { once: true });
      s.el.addEventListener('loadeddata', onCanPlay, { once: true });
      // Safety timeout: don't hang forever if network is bad.
      setTimeout(() => { if (!swapped) doSwap(); }, 4000);

      const isHls = /\.m3u8(\?|$)/i.test(url);
      if (isHls && window.Hls && Hls.isSupported()) {
        s.hls = new Hls(newHlsConfig());
        s.hls.attachMedia(s.el);
        s.hls.on(Hls.Events.MEDIA_ATTACHED, () => s.hls.loadSource(url));
        s.hls.on(Hls.Events.ERROR, (_e, d) => {
          if (!d.fatal) return;
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR) s.hls.startLoad();
          else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) s.hls.recoverMediaError();
        });
      } else {
        s.el.src = url; s.el.load();
      }
    });
  }

  function startAdUi(duration) {
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
    adTimer = setTimeout(returnToLive, duration * 1000);
  }
  function stopAdUi() {
    setMode('live');
    badge.classList.add('hidden');
    clearInterval(countdownTimer);
    clearTimeout(adTimer);
  }

  function savePosition() {
    const t = front().el.currentTime;
    if (isFinite(t) && t > 0) { savedPosition = t; adStartedAt = Date.now(); }
  }

  async function playAd(adUrl, remainingSeconds) {
    if (currentMode !== 'ad') savePosition();
    // Kick off UI immediately (badge + countdown) while the back slot preloads.
    startAdUi(remainingSeconds);
    await loadOnBackAndSwap(adUrl, { isAd: true });
  }

  async function returnToLive() {
    if (!liveUrl) return;
    stopAdUi();
    const adElapsed = adStartedAt ? (Date.now() - adStartedAt) / 1000 : 0;
    const resumeAt = (savedPosition != null) ? (savedPosition + adElapsed) : null;
    savedPosition = null; adStartedAt = null;
    await loadOnBackAndSwap(liveUrl, { resumeAt, isAd: false });
  }

  async function initialLoad() {
    if (!liveUrl) return;
    // First-ever load: front slot is empty, so load directly on it (no swap needed).
    const s = front();
    destroySlot(frontKey);
    const isHls = /\.m3u8(\?|$)/i.test(liveUrl);
    if (isHls && window.Hls && Hls.isSupported()) {
      s.hls = new Hls(newHlsConfig());
      s.hls.attachMedia(s.el);
      s.hls.on(Hls.Events.MEDIA_ATTACHED, () => s.hls.loadSource(liveUrl));
      s.hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) s.hls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) s.hls.recoverMediaError();
      });
    } else {
      s.el.src = liveUrl; s.el.load();
    }
    s.el.play().catch(()=>{});
  }

  function applyState(state) {
    if (!state) return;
    if (state.mode === 'ad' && state.adUrl) {
      const elapsed = Math.max(0, (Date.now() - (state.startAt || Date.now())) / 1000);
      const remaining = Math.max(1, (state.duration || 15) - elapsed);
      playAd(state.adUrl, remaining);
    } else {
      // Already live — nothing to do unless we were mid-ad.
      if (currentMode === 'ad') returnToLive();
    }
  }

  function handleCommand(msg) {
    if (msg.action === 'play_ad') {
      const elapsed = Math.max(0, (Date.now() - (msg.startAt || Date.now())) / 1000);
      const remaining = Math.max(1, msg.duration - elapsed);
      playAd(msg.adUrl, remaining);
    } else if (msg.action === 'resume_live') {
      returnToLive();
    }
  }

  // --- WebSocket w/ exponential backoff ---
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
        if (!front().el.src && !front().hls && liveUrl) initialLoad();
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
    .then(c => { liveUrl = c.liveUrl; if (!front().hls) initialLoad(); })
    .catch(()=>{});
  connect();
})();
