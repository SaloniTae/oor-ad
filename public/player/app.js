/**
 * Ad Injection - viewer player (hardened build)
 * ------------------------------------------------------------------
 * Connects to /ws?channel=<slug>&token=<viewerJwt>. Token is issued by
 * POST /v1/channels/<id>/viewer-token.
 *
 * Rendering strategy:
 *   - Two <video> elements are stacked. One is "front" (visible), one is "back"
 *     (invisible, used to preload the next source). We NEVER swap until the back
 *     video is truly ready (first frame decoded AND the requested seek has
 *     landed), so no blank frame is ever shown.
 *
 *   - Video ads: back slot loads the ad, swap happens, then we resume live the
 *     same way (back preloads the live URL, seeks to catch-up point, swaps).
 *
 *   - Image ads: we DO NOT tear down the live video. We just pause the front
 *     slot and show an image overlay. When the ad ends we hide the overlay and
 *     resume the (still-loaded) live video. Live never has to reload -> no
 *     restart-from-zero, no re-buffer.
 *
 * Catch-up: on resume we seek to (savedPosition + adElapsed) so viewers don't
 * miss content, YouTube-live style. If the platform's HLS window is too short
 * to hold that position, we clamp to the live edge.
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
  let currentAdType = null;      // 'video' | 'hls' | 'image' | null
  let currentSwapToken = 0;      // increments per playAd/returnToLive; cancels stale swaps

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

  /**
   * Try to seek the given media element to `target` seconds.
   * Waits until seekable ranges include (or can be clamped to) the target,
   * then triggers `onDone` when the seek has actually landed (or after a
   * bounded timeout). Never leaves us on frame 0.
   */
  function seekWhenReady(el, target, onDone, opts = {}) {
    const { maxWaitMs = 2500 } = opts;
    const started = Date.now();

    const trySeek = () => {
      let sk;
      try { sk = el.seekable; } catch { sk = null; }
      if (sk && sk.length) {
        const start = sk.start(0), end = sk.end(sk.length - 1);
        // Clamp inside a safe window. If target is past the end (live catch-up
        // beyond DVR window), pin to live edge instead of frame 0.
        const safeTarget = Math.min(
          Math.max(target, start + 0.1),
          Math.max(end - 0.5, start + 0.1)
        );
        // If the current time is already close enough, no seek needed.
        if (Math.abs((el.currentTime || 0) - safeTarget) < 0.25) return onDone();

        const onSeeked = () => { el.removeEventListener('seeked', onSeeked); onDone(); };
        el.addEventListener('seeked', onSeeked, { once: true });
        try { el.currentTime = safeTarget; } catch { /* fallthrough to timeout */ }
        // Safety: `seeked` should fire in <500ms; if not, continue anyway.
        setTimeout(() => { el.removeEventListener('seeked', onSeeked); onDone(); }, 900);
        return;
      }
      // Seekable not populated yet; retry until timeout, then give up gracefully.
      if (Date.now() - started > maxWaitMs) return onDone();
      // Any of these events indicates seekable may have grown.
      const retry = () => { cleanup(); trySeek(); };
      const cleanup = () => {
        el.removeEventListener('progress', retry);
        el.removeEventListener('loadedmetadata', retry);
        el.removeEventListener('durationchange', retry);
        el.removeEventListener('canplaythrough', retry);
        clearTimeout(fallbackT);
      };
      el.addEventListener('progress', retry, { once: true });
      el.addEventListener('loadedmetadata', retry, { once: true });
      el.addEventListener('durationchange', retry, { once: true });
      el.addEventListener('canplaythrough', retry, { once: true });
      const fallbackT = setTimeout(retry, 200);   // poll every ~200ms if events are quiet
    };
    trySeek();
  }

  /**
   * Load `url` on the BACK slot; swap to front only when the frame is ready
   * AND (if requested) the seek has landed. Guaranteed not to expose a blank
   * back slot.
   */
  function loadOnBackAndSwap(url, { resumeAt = null, token } = {}) {
    return new Promise((resolve) => {
      const key = frontKey === 'A' ? 'B' : 'A';
      const s = slots[key];
      destroySlot(key);
      s.el.removeAttribute('src'); try { s.el.load(); } catch {}

      let swapped = false;
      const doSwap = () => {
        if (swapped) return;
        // Stale swap (a newer command replaced us). Abandon quietly.
        if (token != null && token !== currentSwapToken) { swapped = true; resolve(); return; }
        // Must have at least one decoded frame available before we swap.
        if (s.el.readyState < 2) { setTimeout(doSwap, 60); return; }
        swapped = true;

        const finalize = () => {
          slots[key].el.classList.add('active');
          slots[frontKey].el.classList.remove('active');
          const oldFront = frontKey; frontKey = key;
          setTimeout(() => destroySlot(oldFront), 220);
          resolve();
        };
        const p = s.el.play();
        if (p && p.then) p.then(finalize, finalize); else finalize();
      };

      const onReady = () => {
        s.el.removeEventListener('loadeddata', onReady);
        s.el.removeEventListener('canplay',    onReady);
        if (resumeAt != null) {
          seekWhenReady(s.el, resumeAt, doSwap, { maxWaitMs: 2500 });
        } else {
          doSwap();
        }
      };
      s.el.addEventListener('loadeddata', onReady, { once: true });
      s.el.addEventListener('canplay',    onReady, { once: true });

      // Last-resort safety. Only swap if the back slot actually has a frame;
      // otherwise keep the current front on screen (no blank flash).
      const HARD_LIMIT_MS = 8000;
      const t0 = Date.now();
      (function guard() {
        if (swapped) return;
        if (s.el.readyState >= 2) { onReady(); return; }
        if (Date.now() - t0 > HARD_LIMIT_MS) {
          // Give up on this swap; leave current front in place.
          swapped = true;
          if (token == null || token === currentSwapToken) {
            // Don't tear down front. Just destroy the failed back attempt.
            destroySlot(key);
          }
          resolve();
          return;
        }
        setTimeout(guard, 200);
      })();

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
        s.el.src = url;
        try { s.el.load(); } catch {}
      }
    });
  }

  // ---- badge / countdown / loading indicator --------------------------------
  function showBadgeAndCountdown(duration) {
    badge.classList.remove('hidden');
    void badge.offsetWidth;                  // force reflow so transition triggers
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
  function showLoading()  { loadingEl && loadingEl.classList.remove('hidden'); }
  function hideLoading()  { loadingEl && loadingEl.classList.add('hidden'); }

  function savePosition() {
    const t = front().el.currentTime;
    if (isFinite(t) && t > 0) { savedPosition = t; adStartedAt = Date.now(); }
    else                       { savedPosition = null; adStartedAt = Date.now(); }
  }

  // ---- ad flows -------------------------------------------------------------
  async function playVideoAd(adUrl, duration) {
    const myToken = ++currentSwapToken;
    savePosition();
    setMode('ad');
    showLoading();
    // Load ad on hidden slot; badge/countdown appear only AFTER the ad frame lands.
    await loadOnBackAndSwap(adUrl, { token: myToken });
    if (myToken !== currentSwapToken) return;    // superseded by another command
    hideLoading();
    showBadgeAndCountdown(duration);
    reportEvent('ad.impression');
    clearTimeout(adTimer);
    adTimer = setTimeout(returnToLive, duration * 1000);
  }

  function playImageAd(imgUrl, duration, meta) {
    ++currentSwapToken;                          // any in-flight video swap becomes stale
    savePosition();
    setMode('ad');
    hideLoading();
    // Keep live decoded in the front slot -- just pause it. The overlay hides
    // it visually; when the ad ends we simply un-pause. No reload, no restart.
    try { front().el.pause(); } catch {}
    // Preload with hidden <img> first, then swap so we never flash a broken image.
    const pre = new Image();
    pre.onload = pre.onerror = () => {
      imgAd.src = imgUrl;
      if (meta && meta.click_url) imgLink.setAttribute('href', meta.click_url);
      else                        imgLink.removeAttribute('href');
      imgLink.classList.remove('hidden');
      showBadgeAndCountdown(duration);
    };
    pre.src = imgUrl;
    reportEvent('ad.impression');
    clearTimeout(adTimer);
    adTimer = setTimeout(returnToLive, duration * 1000);
  }

  async function returnToLive() {
    hideBadge();
    hideLoading();
    clearTimeout(adTimer);
    const wasImageAd = (currentAdType === 'image');
    currentAdType = null;
    currentTriggerId = null; currentAdId = null;
    setMode('live');
    reportEvent('ad.complete');

    // IMAGE AD PATH: live was only paused. Just resume it and hide the overlay.
    if (wasImageAd) {
      imgLink.classList.add('hidden');
      imgAd.removeAttribute('src');
      const el = front().el;
      const adElapsed = adStartedAt ? (Date.now() - adStartedAt) / 1000 : 0;
      const target = (savedPosition != null) ? (savedPosition + adElapsed) : null;
      savedPosition = null; adStartedAt = null;
      // Catch up to where live would be now, if we can. If seekable is behind
      // (short DVR window), we'll be clamped to live edge automatically.
      if (target != null) seekWhenReady(el, target, () => {}, { maxWaitMs: 1500 });
      try { await el.play(); } catch {}
      return;
    }

    // VIDEO AD PATH: reload live on the back slot and swap to it.
    if (!liveUrl) return;
    imgLink.classList.add('hidden');
    imgAd.removeAttribute('src');
    const myToken = ++currentSwapToken;
    const adElapsed = adStartedAt ? (Date.now() - adStartedAt) / 1000 : 0;
    const resumeAt = (savedPosition != null) ? (savedPosition + adElapsed) : null;
    savedPosition = null; adStartedAt = null;
    await loadOnBackAndSwap(liveUrl, { resumeAt, token: myToken });
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
      s.hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) s.hls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) s.hls.recoverMediaError();
      });
    } else {
      s.el.src = liveUrl;
      try { s.el.load(); } catch {}
    }
    s.el.play().catch(()=>{});
  }

  function dispatchAd(msg) {
    currentTriggerId = msg.triggerId; currentAdId = msg.adId;
    currentAdType   = msg.adType || (/(png|jpe?g|webp|gif)($|\?)/i.test(msg.adUrl || '') ? 'image' : 'video');
    const elapsed = Math.max(0, (Date.now() - (msg.startAt || Date.now())) / 1000);
    const remaining = Math.max(1, (msg.duration || 15) - elapsed);
    if (currentAdType === 'image') return playImageAd(msg.adUrl, remaining, msg.metadata);
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
