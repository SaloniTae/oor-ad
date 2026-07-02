/**
 * Ad Injection - viewer player.
 * ------------------------------------------------------------------
 * Connects to /ws?channel=<slug>&token=<viewerJwt>. The token is issued
 * by the tenant's backend via POST /v1/channels/<id>/viewer-token, so viewers
 * cannot subscribe to channels they weren't authorized for.
 *
 * How to use:
 *   1. Your backend calls /v1/channels/{id}/viewer-token → gets { token, ws_url }
 *   2. Load this page as: /player/?ws=<ws_url_urlencoded>
 *      OR set window.AD_INJECTION_CONFIG = { wsUrl, liveUrl } before app.js.
 *
 * Ad support:
 *   - video / hls  → seamless A/B double-video swap (badge shows AFTER swap)
 *   - image        → fullscreen image overlay with countdown, live stays paused
 *
 * Catch-up: on resume, live is seeked to (savedPosition + wallClockElapsed)
 * so viewers never miss content, exactly like YouTube Live ad breaks.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const videoA = $('videoA'), videoB = $('videoB');
  const statusEl = $('status'), badge = $('badge'), cd = $('countdown');
  const modeEl = $('mode'), cidEl = $('cid'), chEl = $('ch');
  const imgLink = $('imgLink'), imgAd = $('imgAd'), loadingEl = $('loading');
  const unmute = $('unmute');

  // ---- config resolution ----
  const qs = new URLSearchParams(location.search);
  const cfg = window.AD_INJECTION_CONFIG || {};
  const wsUrl  = cfg.wsUrl  || qs.get('ws');
  let   liveUrl = cfg.liveUrl || qs.get('live') || null;   // may be provided; also comes with welcome msg
  if (!wsUrl) {
    statusEl.textContent = 'missing ws url (?ws=...)'; statusEl.className = 'status err';
    return;
  }

  const slots = { A: { el: videoA, hls: null }, B: { el: videoB, hls: null } };
  let frontKey = 'A';
  const front = () => slots[frontKey];

  let adTimer = null, countdownTimer = null;
  let savedPosition = null, adStartedAt = null;
  let currentMode = 'live';
  let currentTriggerId = null;
  let currentAdId = null;

  const setStatus = (t, cls) => { statusEl.textContent = t; statusEl.className = 'status ' + (cls||''); };
  const setMode   = (m) => { currentMode = m; modeEl.textContent = m; };

  unmute.onclick = () => {
    [videoA, videoB].forEach(v => { v.muted = false; v.volume = 1; });
    front().el.play().catch(()=>{});
    unmute.textContent = '🔊 Sound on';
  };

  function newHlsConfig() {
    return {
      lowLatencyMode: true, startFragPrefetch: true,
      maxBufferLength: 30, backBufferLength: 60, maxMaxBufferLength: 60,
      manifestLoadingMaxRetry: 4, manifestLoadingRetryDelay: 500,
      fragLoadingMaxRetry: 6, fragLoadingRetryDelay: 500,
      autoStartLoad: true,
    };
  }
  function destroySlot(key) {
    const s = slots[key];
    if (s.hls) { try { s.hls.destroy(); } catch {} s.hls = null; }
    try { s.el.pause(); } catch {}
  }

  /** Load `url` on the BACK slot; swap to front only when the frame is ready. */
  function loadOnBackAndSwap(url, { resumeAt = null } = {}) {
    return new Promise((resolve) => {
      const key = frontKey === 'A' ? 'B' : 'A';
      const s = slots[key];
      destroySlot(key);
      s.el.removeAttribute('src'); s.el.load();

      let swapped = false;
      const doSwap = () => {
        if (swapped) return; swapped = true;
        const playPromise = s.el.play();
        const finalize = () => {
          slots[key].el.classList.add('active');
          slots[frontKey].el.classList.remove('active');
          const oldFront = frontKey; frontKey = key;
          setTimeout(() => destroySlot(oldFront), 200);
          resolve();
        };
        if (playPromise && playPromise.then) playPromise.then(finalize, finalize); else finalize();
      };

      const onReady = () => {
        s.el.removeEventListener('canplay', onReady);
        s.el.removeEventListener('loadeddata', onReady);
        if (resumeAt != null) {
          try {
            const sk = s.el.seekable;
            if (sk && sk.length) {
              const start = sk.start(0), end = sk.end(sk.length - 1);
              const target = Math.min(Math.max(resumeAt, start + 0.1), Math.max(end - 0.5, start + 0.1));
              s.el.currentTime = target;
              const onSeeked = () => { s.el.removeEventListener('seeked', onSeeked); doSwap(); };
              s.el.addEventListener('seeked', onSeeked, { once: true });
              setTimeout(doSwap, 800);
              return;
            }
          } catch {}
        }
        doSwap();
      };
      s.el.addEventListener('canplay', onReady, { once: true });
      s.el.addEventListener('loadeddata', onReady, { once: true });
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

  function showBadgeAndCountdown(duration) {
    badge.classList.remove('hidden');
    // Force reflow so the opacity transition triggers reliably.
    void badge.offsetWidth;
    badge.classList.add('show');
    let remaining = Math.ceil(duration);
    cd.textContent = remaining;
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      remaining--; cd.textContent = Math.max(0, remaining);
      if (remaining <= 0) clearInterval(countdownTimer);
    }, 1000);
  }
  function hideBadge() {
    badge.classList.remove('show');
    setTimeout(() => badge.classList.add('hidden'), 200);
    clearInterval(countdownTimer);
  }

  function savePosition() {
    const t = front().el.currentTime;
    if (isFinite(t) && t > 0) { savedPosition = t; adStartedAt = Date.now(); }
  }

  // ---- ad flows -------------------------------------------------------------
  async function playVideoAd(adUrl, duration) {
    savePosition();
    setMode('ad'); loadingEl.classList.remove('hidden');
    // load ad on hidden slot; DO NOT show badge yet.
    await loadOnBackAndSwap(adUrl);
    loadingEl.classList.add('hidden');
    showBadgeAndCountdown(duration);       // badge appears with the ad frame, not before
    reportEvent('ad.impression');
    clearTimeout(adTimer);
    adTimer = setTimeout(returnToLive, duration * 1000);
  }

  function playImageAd(imgUrl, duration, meta) {
    savePosition();
    setMode('ad');
    // Pause the current video (keeps its last frame invisible under image).
    try { front().el.pause(); } catch {}
    imgAd.src = imgUrl;
    if (meta && meta.click_url) { imgLink.href = meta.click_url; }
    else { imgLink.removeAttribute('href'); }
    imgLink.classList.remove('hidden');
    showBadgeAndCountdown(duration);
    reportEvent('ad.impression');
    clearTimeout(adTimer);
    adTimer = setTimeout(returnToLive, duration * 1000);
  }

  async function returnToLive() {
    if (!liveUrl) return;
    hideBadge();
    imgLink.classList.add('hidden');
    imgAd.removeAttribute('src');
    const adElapsed = adStartedAt ? (Date.now() - adStartedAt) / 1000 : 0;
    const resumeAt = (savedPosition != null) ? (savedPosition + adElapsed) : null;
    savedPosition = null; adStartedAt = null;
    reportEvent('ad.complete');
    currentTriggerId = null; currentAdId = null;
    setMode('live');
    await loadOnBackAndSwap(liveUrl, { resumeAt });
  }

  async function initialLoad() {
    if (!liveUrl) return;
    const s = front();
    destroySlot(frontKey);
    const isHls = /\.m3u8(\?|$)/i.test(liveUrl);
    if (isHls && window.Hls && Hls.isSupported()) {
      s.hls = new Hls(newHlsConfig());
      s.hls.attachMedia(s.el);
      s.hls.on(Hls.Events.MEDIA_ATTACHED, () => s.hls.loadSource(liveUrl));
    } else {
      s.el.src = liveUrl; s.el.load();
    }
    s.el.play().catch(()=>{});
  }

  function dispatchAd(msg) {
    currentTriggerId = msg.triggerId; currentAdId = msg.adId;
    const elapsed = Math.max(0, (Date.now() - (msg.startAt || Date.now())) / 1000);
    const remaining = Math.max(1, msg.duration - elapsed);
    if (msg.adType === 'image') return playImageAd(msg.adUrl, remaining, msg.metadata);
    return playVideoAd(msg.adUrl, remaining);
  }

  function applyState(state) {
    if (!state) return;
    if (state.mode === 'ad' && state.adUrl) {
      dispatchAd({
        triggerId: state.triggerId, adId: state.adId, adType: state.adType,
        adUrl: state.adUrl, duration: state.duration, startAt: state.startAt, metadata: state.metadata,
      });
    } else if (currentMode === 'ad') {
      returnToLive();
    }
  }

  function handleCommand(msg) {
    if (msg.action === 'play_ad')      dispatchAd(msg);
    else if (msg.action === 'resume_live') returnToLive();
  }

  // ---- analytics event reporting to the server (via WS) --------------------
  let socket = null;
  function reportEvent(name, meta) {
    if (!socket || socket.readyState !== 1) return;
    try { socket.send(JSON.stringify({ type: 'event', name, adId: currentAdId, triggerId: currentTriggerId, meta })); } catch {}
  }

  // ---- WebSocket w/ exponential backoff ------------------------------------
  let backoff = 500;
  function connect() {
    setStatus('connecting…');
    socket = new WebSocket(wsUrl);
    socket.onopen = () => {
      setStatus('live • connected', 'ok'); backoff = 500;
      socket.send(JSON.stringify({ type: 'hello' }));
    };
    socket.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'welcome') {
        cidEl.textContent = m.viewerId;
        if (m.channel) {
          chEl.textContent = m.channel.slug;
          liveUrl = liveUrl || m.channel.liveUrl;
        }
        if (liveUrl && !front().hls && !front().el.src) initialLoad();
      } else if (m.type === 'state')   applyState(m.state);
      else if (m.type === 'command') handleCommand(m);
    };
    socket.onclose = () => {
      setStatus('reconnecting…', 'err');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    socket.onerror = () => { try { socket.close(); } catch {} };
  }

  connect();
})();
