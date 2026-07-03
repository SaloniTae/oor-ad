/**
 * Ad Injection - viewer player (production build v11 - Elite Sync & Telemetry)
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

  // ---- Global State --------------------------------------------------------
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
  let isBumperActive = false; 

  const setStatus = (t, cls) => { statusEl.textContent = t; statusEl.className = 'status ' + (cls||''); };
  const setMode   = (m) => { currentMode = m; modeEl.textContent = m; };

  // ---- Audio Engine (Atomic Interpolator) ----------------------------------
  // Prevents multiple rapid triggers from overlapping audio fade intervals
  const AudioEngine = {
    raf: null,
    fade(targetLiveVol, targetAdVol, durationMs = 500) {
      cancelAnimationFrame(this.raf);
      
      if (!userWantsSound) {
        liveEl.muted = true; adEl.muted = true;
        liveEl.volume = targetLiveVol; adEl.volume = targetAdVol;
        return;
      }
      
      const startLive = liveEl.volume || 0;
      const startAd = adEl.volume || 0;
      const startTime = performance.now();
      
      // Hardware unlock instantly if fading UP
      if (targetLiveVol > 0) liveEl.muted = false;
      if (targetAdVol > 0) adEl.muted = false;

      const step = (now) => {
        const progress = Math.min((now - startTime) / durationMs, 1);
        liveEl.volume = startLive + (targetLiveVol - startLive) * progress;
        adEl.volume = startAd + (targetAdVol - startAd) * progress;

        if (progress < 1) {
          this.raf = requestAnimationFrame(step);
        } else {
          // Hardware lock explicitly at 0 to prevent ghost bleeding
          if (targetLiveVol === 0) liveEl.muted = true;
          if (targetAdVol === 0) adEl.muted = true;
        }
      };
      this.raf = requestAnimationFrame(step);
    },
    
    // Snaps audio to correct mathematical state based on current logic
    syncHardware() {
      if (currentMode === 'live') {
        this.fade(1, 0, 0);
      } else if (isBumperActive) {
        this.fade(0, 0, 0);
      } else {
        this.fade(0, currentAdType === 'image' ? 0 : 1, 0);
      }
    }
  };

  function safePlay(el) {
    if (el === adEl && currentAdType === 'image') return; // Image ads never play audio
    
    el.volume = userWantsSound ? 1 : 0;
    el.muted = !userWantsSound;
    const playPromise = el.play();
    
    if (playPromise !== undefined) {
      playPromise.catch(e => {
        if (e.name === 'NotAllowedError' && userWantsSound) {
          userWantsSound = false;
          unmuteBtn.textContent = 'Tap to Unmute';
          AudioEngine.syncHardware();
          el.play().catch(()=>{}); 
        }
      });
    }
  }

  unmuteBtn.onclick = () => {
    userWantsSound = !userWantsSound;
    unmuteBtn.textContent = userWantsSound ? 'Mute' : 'Tap to Unmute';
    AudioEngine.syncHardware();
    
    const target = currentMode === 'live' ? liveEl : (currentAdType !== 'image' && !isBumperActive ? adEl : null);
    if (target && userWantsSound) target.play().catch(()=>{});
  };

  // ---- Telemetry & Watchdog ------------------------------------------------
  // Reports playback freezes and state errors directly to the backend
  function attachWatchdog(el, prefix) {
    let errorCooldown = false;
    
    const report = (type, detail) => {
      if (errorCooldown) return;
      errorCooldown = true; setTimeout(() => errorCooldown = false, 5000);
      reportEvent(`error: ${prefix}_${type}`, { detail });
    };

    el.addEventListener('waiting', () => {
      if (prefix === 'live' && currentMode === 'live') report('freeze', 'buffer starved');
      if (prefix === 'ad' && currentMode === 'ad' && !isBumperActive) report('freeze', 'ad buffer starved');
    });
    
    el.addEventListener('error', () => report('playback_failed', el.error?.message));

    // OS Background Suspension Shield: 
    // Browsers pause background tags. We MUST aggressively wake it up to prevent silent HLS death.
    el.addEventListener('pause', () => {
      if (prefix === 'live' && liveUrl && !el.ended) {
        el.play().catch(e => report('autoplay_blocked', e.message));
      }
    });
  }
  
  attachWatchdog(liveEl, 'live');
  attachWatchdog(adEl, 'ad');

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

  function loadAdVideo(url, startTimeOffset = 0) {
    if (adHls) { try { adHls.destroy(); } catch {} adHls = null; }
    try { adEl.pause(); } catch {}
    adEl.removeAttribute('src'); try { adEl.load(); } catch {}

    adEl.autoplay = false; 
    adEl.muted = true;

    const isHls = /\.m3u8(\?|$)/i.test(url);
    if (isHls && window.Hls && Hls.isSupported()) {
      adHls = new Hls(newHlsConfig());
      adHls.attachMedia(adEl);
      adHls.on(Hls.Events.MEDIA_ATTACHED, () => {
        adHls.loadSource(url);
        adEl.currentTime = startTimeOffset; 
        adEl.pause(); 
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
        adEl.addEventListener('loadedmetadata', () => { adEl.currentTime = startTimeOffset; }, {once:true});
        adEl.pause(); 
      } catch {}
    }
  }

  function unloadAdVideo() {
    if (adHls) { try { adHls.destroy(); } catch {} adHls = null; }
    try { adEl.pause(); } catch {}
    adEl.removeAttribute('src'); try { adEl.load(); } catch {}
  }

  // ---- DOM GC Helpers -------------------------------------------------------
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

  function hideLoading() { loadingEl && loadingEl.classList.remove('show'); }
  function hideAdVideoLayer() { adEl.classList.remove('on'); }

  function hideImageLayer() {
    imgLink.classList.remove('on');
    clearTimeout(imageClearTimeout);
    imageClearTimeout = setTimeout(() => {
      imgAd.removeAttribute('src');
      imgAd.onload = null; imgAd.onerror = null;
    }, 500); 
  }

  // Completely garbage collects any active ad UI/timers to guarantee zero overlap
  function abortCurrentAd() {
    clearTimeout(adTimer);
    clearTimeout(bumperTimer);
    isBumperActive = false;
    
    hideBadge();
    hideLoading();
    hideImageLayer();
    hideAdVideoLayer();
    unloadAdVideo();
  }

  // ---- True Sync Ad Engine --------------------------------------------------
  function executeAdVisuals(msg, actualAdRemaining) {
    hideLoading();
    isBumperActive = false;

    if (currentAdType === 'image') {
      liveEl.muted = true;
      liveEl.volume = 0;
      if (msg.metadata?.click_url) imgLink.setAttribute('href', msg.metadata.click_url);
      else imgLink.removeAttribute('href');
      imgLink.classList.add('on');
    } else {
      adEl.classList.add('on');
      adEl.volume = 0;
      safePlay(adEl);
      AudioEngine.fade(0, 1, 500); 
    }
    
    showBadgeAndCountdown(actualAdRemaining);
    reportEvent('ad.impression');
  }

  function playAdFlow(msg) {
    const myToken = ++currentToken;
    abortCurrentAd(); // Instantly destroy any previous ad that got overridden
    
    currentTriggerId = msg.triggerId; 
    currentAdId = msg.adId;
    currentAdType = inferAdType(msg);
    setMode('ad');
    isBumperActive = true; 

    AudioEngine.fade(0, 0, 500); // Crossfade Live Audio OUT
    loadingEl.classList.add('show'); // Show "We'll be right back"

    const bumperDurationSec = msg.bumper || 7;
    const actualAdDurationSec = msg.duration || 15;
    const absoluteElapsedSec = Math.max(0, (Date.now() - (msg.startAt || Date.now())) / 1000);

    // BUMPER PHASE
    if (absoluteElapsedSec < bumperDurationSec) {
      const bumperRemainingSec = bumperDurationSec - absoluteElapsedSec;

      if (currentAdType === 'image') {
        clearTimeout(imageClearTimeout); 
        imgAd.src = msg.adUrl; 
      } else {
        loadAdVideo(msg.adUrl, 0);
      }

      bumperTimer = setTimeout(() => {
        if (myToken !== currentToken) return;
        executeAdVisuals(msg, actualAdDurationSec);
      }, bumperRemainingSec * 1000);

    } 
    // LATE JOINER RECOVERY PHASE
    else {
      isBumperActive = false;
      const adElapsedSec = absoluteElapsedSec - bumperDurationSec;
      const actualAdRemaining = actualAdDurationSec - adElapsedSec;

      if (actualAdRemaining > 0.5) {
        if (currentAdType === 'image') {
          clearTimeout(imageClearTimeout); 
          imgAd.src = msg.adUrl; 
          executeAdVisuals(msg, actualAdRemaining);
        } else {
          loadAdVideo(msg.adUrl, adElapsedSec);
          setTimeout(() => {
             if (myToken === currentToken) executeAdVisuals(msg, actualAdRemaining);
          }, 200); 
        }
      } else {
        returnToLive();
      }
    }

    // Schedule strict expiration based purely on math, regardless of what phase we started in
    const totalRemainingSec = (bumperDurationSec + actualAdDurationSec) - absoluteElapsedSec;
    adTimer = setTimeout(() => {
      if (myToken === currentToken) returnToLive();
    }, totalRemainingSec * 1000);
  }

  function returnToLive() {
    const wasVideoAd = (currentAdType === 'video' || currentAdType === 'hls');
    abortCurrentAd();
    
    if (currentMode === 'live' && !currentAdType) return;

    currentAdType = null; currentAdId = null; currentTriggerId = null;
    setMode('live');
    
    AudioEngine.fade(1, 0, 500);
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
        adUrl: state.adUrl, duration: state.duration, bumper: state.bumper, startAt: state.startAt, metadata: state.metadata,
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
