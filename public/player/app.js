/**
 * Ad Injection - viewer player (production build v7 - Bugfix)
 */
(() => {
  const $ = (id) => document.getElementById(id);
  
  const liveEl = $('videoA');            
  const adEl   = $('videoB');            
  const statusEl = $('status'), badge = $('badge'), cd = $('countdown');
  const modeEl = $('mode'), cidEl = $('cid'), chEl = $('ch');
  const imgLink = $('imgLink'), imgAd = $('imgAd'), loadingEl = $('loading');
  const unmuteBtn = $('unmute');

  const qs = new URLSearchParams(location.search);
  const cfg = window.AD_INJECTION_CONFIG || {};
  const wsUrl   = cfg.wsUrl  || qs.get('ws');
  let   liveUrl = cfg.liveUrl || qs.get('live') || null;

  if (!wsUrl) return;

  // ---- state ---------------------------------------------------------------
  let liveHls = null;
  let adHls   = null;
  let adTimer = null;
  let bumperTimer = null;
  let countdownTimer = null;
  let imageClearTimeout = null;
  let currentMode = 'live';         
  let currentAdType = null;         
  let currentAdId = null;
  let currentTriggerId = null;
  let currentToken = 0;             
  
  let userWantsSound = true;       
  let isBumperActive = false; // Lock to prevent user clicks from breaking the preload

  const setStatus = (t, cls) => { statusEl.textContent = t; statusEl.className = 'status ' + (cls||''); };
  const setMode   = (m) => { currentMode = m; modeEl.textContent = m; };

  // ---- audio fade controller -----------------------------------------------
  function animateVolume(el, targetVolume, durationMs = 500) {
    if (!el) return;
    
    if (!userWantsSound) {
      el.muted = true;
      el.volume = targetVolume;
      return;
    }
    
    el.muted = false;
    const startVolume = el.volume || 0;
    const change = targetVolume - startVolume;
    const startTime = performance.now();
    
    function step(currentTime) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      el.volume = startVolume + (change * progress);
      
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        if (targetVolume === 0) el.muted = true;
      }
    }
    requestAnimationFrame(step);
  }

  function safePlay(el) {
    el.volume = userWantsSound ? 1 : 0;
    el.muted = !userWantsSound;
    const playPromise = el.play();
    
    if (playPromise !== undefined) {
      playPromise.catch(e => {
        if (e.name === 'NotAllowedError' && userWantsSound) {
          userWantsSound = false;
          unmuteBtn.textContent = 'Tap to Unmute';
          el.muted = true;
          el.volume = 0;
          el.play().catch(()=>{}); 
        }
      });
    }
  }

  unmuteBtn.onclick = () => {
    userWantsSound = !userWantsSound;
    unmuteBtn.textContent = userWantsSound ? 'Mute' : 'Tap to Unmute';
    
    if (currentMode === 'live') {
      liveEl.muted = !userWantsSound;
      liveEl.volume = userWantsSound ? 1 : 0;
      adEl.muted = true;
      if (userWantsSound) liveEl.play().catch(()=>{});
    } else if (isBumperActive) {
      // Hardware lock: if the 7-second bumper is running, DO NOT let the ad play early
      liveEl.muted = true; 
      adEl.muted = true;
    } else {
      liveEl.muted = true; 
      liveEl.volume = 0;
      if (currentAdType !== 'image') {
        adEl.muted = !userWantsSound;
        adEl.volume = userWantsSound ? 1 : 0;
        if (userWantsSound) adEl.play().catch(()=>{});
      }
    }
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
    safePlay(liveEl);
  }

  function loadAdVideo(url) {
    if (adHls) { try { adHls.destroy(); } catch {} adHls = null; }
    try { adEl.pause(); } catch {}
    adEl.removeAttribute('src'); try { adEl.load(); } catch {}

    // BUGFIX: Explicitly strip HTML autoplay and mute so it preloads completely silently
    adEl.autoplay = false; 
    adEl.muted = true;

    const isHls = /\.m3u8(\?|$)/i.test(url);
    if (isHls && window.Hls && Hls.isSupported()) {
      adHls = new Hls(newHlsConfig());
      adHls.attachMedia(adEl);
      adHls.on(Hls.Events.MEDIA_ATTACHED, () => {
        adHls.loadSource(url);
        adEl.pause(); // Force pause after attaching source
      });
      adHls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) adHls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) { try { adHls.recoverMediaError(); } catch {} }
      });
    } else {
      adEl.src = url;
      try { 
        adEl.load(); 
        adEl.pause(); 
      } catch {}
    }
  }

  function unloadAdVideo() {
    if (adHls) { try { adHls.destroy(); } catch {} adHls = null; }
    try { adEl.pause(); } catch {}
    adEl.removeAttribute('src'); try { adEl.load(); } catch {}
  }

  // ---- UI helpers -----------------------------------------------------------
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
    clearTimeout(imageClearTimeout);
    
    // 500ms delay to allow CSS opacity transition to finish before wiping SRC
    imageClearTimeout = setTimeout(() => {
      imgAd.removeAttribute('src');
      imgAd.onload = null; imgAd.onerror = null;
    }, 500); 
  }

  // ---- Ad Pre-Roll Engine ---------------------------------------------------
  function playAdFlow(msg) {
    const myToken = ++currentToken;
    clearTimeout(adTimer);
    clearTimeout(bumperTimer);
    
    currentTriggerId = msg.triggerId; 
    currentAdId = msg.adId;
    currentAdType = inferAdType(msg);
    
    const elapsed = Math.max(0, (Date.now() - (msg.startAt || Date.now())) / 1000);
    const remaining = Math.max(1, (msg.duration || 15) - elapsed);

    setMode('ad');
    isBumperActive = true; // Lock playback interaction

    hideImageLayer();
    hideAdVideoLayer();
    hideBadge();
    
    // Crossfade Live Audio OUT 
    animateVolume(liveEl, 0, 500);

    // Show "We'll be right back"
    showLoading(); 

    // BUGFIX: Cancel image wipe timeout if we are trying to load a new image
    if (currentAdType === 'image') {
      clearTimeout(imageClearTimeout); 
      imgAd.src = msg.adUrl; 
    } else {
      loadAdVideo(msg.adUrl);
    }

    // Wait exactly 7 seconds, then transition
    bumperTimer = setTimeout(() => {
      if (myToken !== currentToken) return;
      
      isBumperActive = false; // Unlock
      hideLoading(); 
      
      if (currentAdType === 'image') {
        liveEl.muted = true;
        liveEl.volume = 0;
        showImageLayer(msg.metadata?.click_url);
      } else {
        showAdVideoLayer();
        
        // BUGFIX: Reset video to 0 just in case, then perfectly crossfade audio IN
        adEl.currentTime = 0; 
        adEl.volume = 0;
        safePlay(adEl);
        animateVolume(adEl, 1, 500); 
      }
      
      showBadgeAndCountdown(remaining);
      reportEvent('ad.impression');

      adTimer = setTimeout(() => {
        if (myToken === currentToken) returnToLive();
      }, remaining * 1000);

    }, 7000); 
  }

  function returnToLive() {
    clearTimeout(adTimer); adTimer = null;
    clearTimeout(bumperTimer); bumperTimer = null;
    isBumperActive = false;
    
    if (currentMode === 'live' && !currentAdType) {
      hideBadge(); hideLoading(); hideAdVideoLayer(); hideImageLayer();
      return;
    }

    const wasVideoAd = (currentAdType === 'video' || currentAdType === 'hls');
    currentAdType = null; currentAdId = null; currentTriggerId = null;
    setMode('live');
    
    hideBadge();
    hideLoading();
    
    if (wasVideoAd) {
      animateVolume(adEl, 0, 500);
      hideAdVideoLayer();
      setTimeout(() => unloadAdVideo(), 500); 
    } else {
      hideImageLayer();
    }
    
    // Crossfade Live Audio IN
    animateVolume(liveEl, 1, 500);
    safePlay(liveEl);
    
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

  function applyState(state) {
    if (!state) return;
    if (state.mode === 'ad' && state.adUrl) {
      playAdFlow({
        triggerId: state.triggerId, adId: state.adId, adType: state.adType,
        adUrl: state.adUrl, duration: state.duration, startAt: state.startAt, metadata: state.metadata,
      });
    } else if (currentMode === 'ad') {
      returnToLive();
    }
  }

  function handleCommand(msg) {
    if (msg.action === 'play_ad')      playAdFlow(msg);
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
