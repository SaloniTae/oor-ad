/**
 * Ad Injection - viewer player (production build v3)
 */
(() => {
  const $ = (id) => document.getElementById(id);
  
  const liveEl = $('videoA');            
  const adEl   = $('videoB');            
  const statusEl = $('status'), badge = $('badge'), cd = $('countdown');
  const modeEl = $('mode'), cidEl = $('cid'), chEl = $('ch');
  const imgLink = $('imgLink'), imgAd = $('imgAd'), loadingEl = $('loading');
  const unmuteBtn = $('unmute');

  // ---- config resolution ---------------------------------------------------
  const qs = new URLSearchParams(location.search);
  const cfg = window.AD_INJECTION_CONFIG || {};
  const wsUrl   = cfg.wsUrl  || qs.get('ws');
  let   liveUrl = cfg.liveUrl || qs.get('live') || null;

  if (!wsUrl) return;

  // ---- state ---------------------------------------------------------------
  let liveHls = null;
  let adHls   = null;
  let adTimer = null;
  let countdownTimer = null;
  let currentMode = 'live';         
  let currentAdType = null;         
  let currentAdId = null;
  let currentTriggerId = null;
  let currentToken = 0;             
  let userWantsSound = false;       

  const setStatus = (t, cls) => { statusEl.textContent = t; statusEl.className = 'status ' + (cls||''); };
  const setMode   = (m) => { currentMode = m; modeEl.textContent = m; };

  // ---- audio / unmute button ------------------------------------------------
  function applyAudioState() {
    if (currentMode === 'ad' && currentAdType === 'image') {
      liveEl.muted = true;
      adEl.muted   = true;
    } else if (currentMode === 'ad') {   
      liveEl.muted = true;
      adEl.muted   = !userWantsSound;
    } else {                              
      liveEl.muted = !userWantsSound;
      adEl.muted   = true;
    }
  }

  unmuteBtn.onclick = () => {
    userWantsSound = !userWantsSound;
    unmuteBtn.textContent = userWantsSound ? 'Mute' : 'Tap to Unmute';
    applyAudioState();
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

  // ---- UI helpers (Updated for CSS Fades) -----------------------------------
  function showBadgeAndCountdown(duration) {
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
    clearInterval(countdownTimer);
  }

  function showLoading() { loadingEl && loadingEl.classList.add('show'); }
  function hideLoading() { loadingEl && loadingEl.classList.remove('show'); }

  function showAdVideoLayer() { adEl.classList.add('on'); }
  function hideAdVideoLayer() { adEl.classList.remove('on'); }

  function showImageLayer(clickUrl) {
    if (clickUrl) imgLink.setAttribute('href', clickUrl);
    else          imgLink.removeAttribute('href');
    imgLink.classList.add('on');
  }

  function hideImageLayer() {
    imgLink.classList.remove('on');
    // Wait for the 500ms CSS opacity transition to complete before clearing src
    setTimeout(() => {
      imgAd.removeAttribute('src');
      imgAd.onload = null; imgAd.onerror = null;
    }, 500); 
  }

  // ---- ad flows -------------------------------------------------------------
  function playVideoAd(adUrl, duration) {
    const myToken = ++currentToken;
    hideImageLayer();
    setMode('ad');
    showLoading();

    loadAdVideo(adUrl, () => {
      if (myToken !== currentToken) return;
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
    hideAdVideoLayer();
    unloadAdVideo();
    setMode('ad');
    showLoading();
    applyAudioState();

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
      hideLoading();
      showBadgeAndCountdown(duration);
      reportEvent('ad.impression');
    };
    imgAd.src = imgUrl;

    if (imgAd.complete && imgAd.naturalWidth > 0) reveal();

    clearTimeout(adTimer);
    adTimer = setTimeout(() => {
      if (myToken === currentToken) returnToLive();
    }, duration * 1000);
  }

  function returnToLive() {
    clearTimeout(adTimer); adTimer = null;
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
    setStatus('connecting...', '');
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      setStatus('live - connected', 'ok'); backoff = 500;
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
      setStatus('reconnecting...', 'err');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    socket.onerror = () => { try { socket.close(); } catch {} };
  }

  connect();
})();
