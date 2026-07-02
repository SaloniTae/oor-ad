/**
 * Ad Injection – viewer player (production build v3)
 *
 * Architecture (fixed roles, zero swaps):
 *   videoA  = LIVE. Loaded once. Never destroyed, seeked, or reloaded during
 *             ads. It just keeps playing (muted during ad breaks) behind the
 *             ad layer, so returning to live is a pure visibility toggle –
 *             no HLS.js state loss, no restart-from-beginning, no reload gap.
 *   videoB  = AD video. Only used for video ads. Loaded when a video ad
 *             starts, played on top of live via z-index, hidden + torn down
 *             when the ad ends.
 *   <img>   = IMAGE ad overlay. On top of everything, hidden by default.
 *
 * Why this fixes every bug you saw:
 *   - "Photo ad delays / freezes / then restarts from beginning"
 *       -> the old code paused live and sometimes reloaded HLS after an
 *          image ad. Now we never touch live. Image ads are pure overlays.
 *   - "Video ad overlaps sometimes"
 *       -> the old code cross-faded two <video>s at opacity ~50% for 140ms,
 *          which visibly overlapped. Now we hard-switch visibility, no fade.
 *   - "Video ad disappearing not synced with the timer / not smooth"
 *       -> the old code reloaded live after the ad, so there was a 1-3s
 *          gap between the countdown hitting 0 and live coming back. Now
 *          live has been playing the whole time – swap-back is instant.
 *   - "Resume button always restarts the stream"
 *       -> server: no broadcast if no active ad. Client: no-op if already
 *          live. And even when it does run, returnToLive() only toggles
 *          visibility – it doesn't touch the live element.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const liveEl = $('videoA');            // fixed role: LIVE
  const adEl   = $('videoB');            // fixed role: AD (video ads only)
  const statusEl = $('status'), badge = $('badge'), cd = $('countdown');
  const modeEl = $('mode'), cidEl = $('cid'), chEl = $('ch');
  const imgLink = $('imgLink'), imgAd = $('imgAd'), loadingEl = $('loading');
  const unmuteBtn = $('unmute');

  // ---- config resolution ---------------------------------------------------
  const qs = new URLSearchParams(location.search);
  const cfg = window.AD_INJECTION_CONFIG || {};
  const wsUrl   = cfg.wsUrl  || qs.get('ws');
  let   liveUrl = cfg.liveUrl || qs.get('live') || null;
  if (!wsUrl) {
    statusEl.textContent = 'missing ws url (?ws=…)'; statusEl.className = 'status err';
    return;
  }

  // ---- state ---------------------------------------------------------------
  let liveHls = null;
  let adHls   = null;
  let adTimer = null;
  let countdownTimer = null;
  let currentMode = 'live';         // 'live' | 'ad'
  let currentAdType = null;         // 'video' | 'hls' | 'image' | null
  let currentAdId = null;
  let currentTriggerId = null;
  let currentToken = 0;             // increments per ad dispatch; cancels stale operations
  let userWantsSound = false;       // set true when the user clicks unmute at least once

  const setStatus = (t, cls) => { statusEl.textContent = t; statusEl.className = 'status ' + (cls||''); };
  const setMode   = (m) => { currentMode = m; modeEl.textContent = m; };

  // ---- audio / unmute button ------------------------------------------------
  // Only ONE element ever produces audio at a time: whichever is on top.
  // During an image ad, live is muted (image ads have no audio anyway).
  // During a video ad, live is muted, ad video honors the user's preference.
  function applyAudioState() {
    if (currentMode === 'ad' && currentAdType === 'image') {
      liveEl.muted = true;
      adEl.muted   = true;
    } else if (currentMode === 'ad') {   // video ad
      liveEl.muted = true;
      adEl.muted   = !userWantsSound;
    } else {                              // live
      liveEl.muted = !userWantsSound;
      adEl.muted   = true;
    }
  }
  unmuteBtn.onclick = () => {
    userWantsSound = !userWantsSound;
    unmuteBtn.textContent = userWantsSound ? '🔈 Mute' : '🔊 Unmute';
    applyAudioState();
    // Kick playback on the currently-audible element so audio actually starts.
    const audible = (currentMode === 'ad' && currentAdType !== 'image') ? adEl : liveEl;
    audible.play().catch(() => {});
  };

  // ---- HLS ------------------------------------------------------------------
  function newHlsConfig() {
    return {
      lowLatencyMode: true, startFragPrefetch: true,
      maxBufferLength: 30, backBufferLength: 60, maxMaxBufferLength: 60,
      manifestLoadingMaxRetry: 4, manifestLoadingRetryDelay: 500,
      fragLoadingMaxRetry: 6, fragLoadingRetryDelay: 500,
      autoStartLoad: true,
    };
  }

  function loadLive() {
    if (!liveUrl) return;
    if (liveHls) { try { liveHls.destroy(); } catch {} liveHls = null; }
    try { liveEl.pause(); } catch {}
    liveEl.removeAttribute('src'); try { liveEl.load(); } catch {}
    const isHls = /\.m3u8(\?|$)/i.test(liveUrl);
    if (isHls && window.Hls && Hls.isSupported()) {
      liveHls = new Hls(newHlsConfig());
      liveHls.attachMedia(liveEl);
      liveHls.on(Hls.Events.MEDIA_ATTACHED, () => liveHls.loadSource(liveUrl));
      liveHls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) liveHls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ATTACH_ERROR || d.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try { liveHls.recoverMediaError(); } catch {}
        }
      });
    } else {
      liveEl.src = liveUrl;
      try { liveEl.load(); } catch {}
    }
    applyAudioState();
    liveEl.play().catch(() => {});
  }

  function loadAdVideo(url, onReady) {
    if (adHls) { try { adHls.destroy(); } catch {} adHls = null; }
    try { adEl.pause(); } catch {}
    adEl.removeAttribute('src'); try { adEl.load(); } catch {}
    const finishOnce = (() => {
      let called = false;
      return () => { if (called) return; called = true; onReady(); };
    })();
    const onReadyEvent = () => finishOnce();
    adEl.addEventListener('canplay',     onReadyEvent, { once: true });
    adEl.addEventListener('loadeddata',  onReadyEvent, { once: true });
    // Safety: if the network stalls, don't hang forever.
    setTimeout(() => finishOnce(), 5000);

    const isHls = /\.m3u8(\?|$)/i.test(url);
    if (isHls && window.Hls && Hls.isSupported()) {
      adHls = new Hls(newHlsConfig());
      adHls.attachMedia(adEl);
      adHls.on(Hls.Events.MEDIA_ATTACHED, () => adHls.loadSource(url));
      adHls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) adHls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) { try { adHls.recoverMediaError(); } catch {} }
      });
    } else {
      adEl.src = url;
      try { adEl.load(); } catch {}
    }
  }

  function unloadAdVideo() {
    if (adHls) { try { adHls.destroy(); } catch {} adHls = null; }
    try { adEl.pause(); } catch {}
    adEl.removeAttribute('src'); try { adEl.load(); } catch {}
  }

  // ---- UI helpers -----------------------------------------------------------
  function showBadgeAndCountdown(duration) {
    badge.classList.remove('hidden');
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
    setTimeout(() => badge.classList.add('hidden'), 180);
    clearInterval(countdownTimer);
  }
  function showLoading() { loadingEl && loadingEl.classList.remove('hidden'); }
  function hideLoading() { loadingEl && loadingEl.classList.add('hidden'); }

  function showAdVideoLayer() { adEl.classList.add('on'); }
  function hideAdVideoLayer() { adEl.classList.remove('on'); }
  function showImageLayer(clickUrl) {
    if (clickUrl) imgLink.setAttribute('href', clickUrl);
    else          imgLink.removeAttribute('href');
    imgLink.classList.remove('hidden');
  }
  function hideImageLayer() {
    imgLink.classList.add('hidden');
    imgAd.removeAttribute('src');
    imgAd.onload = null; imgAd.onerror = null;
  }

  // ---- ad flows -------------------------------------------------------------
  function playVideoAd(adUrl, duration) {
    const myToken = ++currentToken;
    // Clear any leftover image overlay from a prior image ad.
    hideImageLayer();
    setMode('ad');
    // Note: currentAdType is set by dispatchAd BEFORE calling us.
    showLoading();
    loadAdVideo(adUrl, () => {
      if (myToken !== currentToken) return;   // superseded
      hideLoading();
      applyAudioState();
      showAdVideoLayer();
      adEl.play().catch(() => {});
      showBadgeAndCountdown(duration);
      reportEvent('ad.impression');
    });
    clearTimeout(adTimer);
    adTimer = setTimeout(() => {
      if (myToken === currentToken) returnToLive();
    }, duration * 1000);
  }

  function playImageAd(imgUrl, duration, meta) {
    const myToken = ++currentToken;
    // Ensure any video ad layer from a prior trigger is torn down.
    hideAdVideoLayer();
    unloadAdVideo();
    setMode('ad');
    showLoading();
    applyAudioState();     // mutes live so the image ad plays in silence

    const clickUrl = meta && meta.click_url ? meta.click_url : null;
    const reveal = () => {
      if (myToken !== currentToken) return;
      hideLoading();
      showImageLayer(clickUrl);
      showBadgeAndCountdown(duration);
      reportEvent('ad.impression');
    };

    imgAd.onload  = reveal;
    imgAd.onerror = () => {
      if (myToken !== currentToken) return;
      // Fail-graceful: still run the countdown so the ad break isn't lost.
      hideLoading();
      showBadgeAndCountdown(duration);
      reportEvent('ad.impression');
    };
    imgAd.src = imgUrl;
    // If cached, onload may not fire – check `complete` manually.
    if (imgAd.complete && imgAd.naturalWidth > 0) reveal();

    clearTimeout(adTimer);
    adTimer = setTimeout(() => {
      if (myToken === currentToken) returnToLive();
    }, duration * 1000);
  }

  function returnToLive() {
    clearTimeout(adTimer); adTimer = null;
    // No-op if we're already live and there's no ad UI up. This is what
    // makes the Resume button safe to spam without ever restarting the stream.
    if (currentMode === 'live' && !currentAdType) {
      hideBadge(); hideLoading(); hideAdVideoLayer(); hideImageLayer();
      return;
    }
    const wasVideoAd = (currentAdType === 'video' || currentAdType === 'hls');
    currentAdType = null; currentAdId = null; currentTriggerId = null;
    setMode('live');
    hideBadge();
    hideLoading();
    hideImageLayer();
    hideAdVideoLayer();
    if (wasVideoAd) unloadAdVideo();
    // Live has been running the whole time. Just make sure it's audible
    // per the user's preference and playing.
    applyAudioState();
    liveEl.play().catch(() => {});
    reportEvent('ad.complete');
  }

  // ---- command dispatch -----------------------------------------------------
  function inferAdType(msg) {
    if (msg.adType) return msg.adType;
    const u = String(msg.adUrl || '').split('?')[0].split('#')[0].toLowerCase();
    if (/\.m3u8$/.test(u)) return 'hls';
    if (/\.(png|jpe?g|webp|gif|avif|heic|heif|bmp)$/.test(u)) return 'image';
    return 'video';
  }

  function dispatchAd(msg) {
    currentTriggerId = msg.triggerId; currentAdId = msg.adId;
    currentAdType   = inferAdType(msg);
    const elapsed   = Math.max(0, (Date.now() - (msg.startAt || Date.now())) / 1000);
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

  // ---- analytics ------------------------------------------------------------
  let socket = null;
  function reportEvent(name, meta) {
    if (!socket || socket.readyState !== 1) return;
    try { socket.send(JSON.stringify({ type: 'event', name, adId: currentAdId, triggerId: currentTriggerId, meta })); } catch {}
  }

  // ---- WebSocket ------------------------------------------------------------
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
        if (liveUrl && !liveHls && !liveEl.src) loadLive();
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
