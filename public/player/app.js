/**
 * Ad Injection - viewer player (production build v15 - Elite Sync + Pod Stitching)
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
  let masterTicker = null;
  let imageClearTimeout = null;
  
  let currentMode = 'live';         
  let currentPhase = 'live'; // Tracks strictly: 'live', 'bumper', 'ad:0', 'ad:1', etc.
  let currentAdType = null;         
  let currentAdId = null;
  let currentTriggerId = null;
  
  // Pod State (Stitching)
  let currentPod = [];
  let podStartAt = 0;
  let podBumperSec = 7;
  
  let userWantsSound = true;       

  const setStatus = (t, cls) => { statusEl.textContent = t; statusEl.className = 'status ' + (cls||''); };
  const setMode   = (m) => { currentMode = m; modeEl.textContent = m; };

  // ---- Audio Engine (Strictly from v11) ------------------------------------
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
    
    syncHardware() {
      if (currentPhase === 'live') {
        this.fade(1, 0, 0);
      } else if (currentPhase === 'bumper') {
        this.fade(0, 0, 0);
      } else {
        this.fade(0, currentAdType === 'image' ? 0 : 1, 0);
      }
    }
  };

  function safePlay(el) {
    if (el === adEl && currentAdType === 'image') return; 
    
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
    
    const target = currentPhase === 'live' ? liveEl : (currentAdType !== 'image' && currentPhase !== 'bumper' ? adEl : null);
    if (target && userWantsSound) target.play().catch(()=>{});
  };

  // ---- Telemetry & Watchdog (Strictly from v11) ----------------------------
  function attachWatchdog(el, prefix) {
    let errorCooldown = false;
    
    const report = (type, detail) => {
      if (errorCooldown) return;
      errorCooldown = true; setTimeout(() => errorCooldown = false, 5000);
      reportEvent(`error: ${prefix}_${type}`, { detail });
    };

    el.addEventListener('waiting', () => {
      if (prefix === 'live' && currentPhase === 'live') report('freeze', 'buffer starved');
      if (prefix === 'ad' && currentPhase.startsWith('ad:')) report('freeze', 'ad buffer starved');
    });
    
    el.addEventListener('error', () => report('playback_failed', el.error?.message));

    el.addEventListener('pause', () => {
      if (prefix === 'live' && liveUrl && !el.ended) {
        el.play().catch(e => report('autoplay_blocked', e.message));
      }
    });
  }
  
  attachWatchdog(liveEl, 'live');
  attachWatchdog(adEl, 'ad');

  // ---- HLS (Strictly from v11) ---------------------------------------------
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

  // ---- DOM GC Helpers ------------------------------------------------------
  function updateCountdown(remaining) {
    if (remaining > 0) {
      badge.classList.add('show');
      cd.textContent = Math.ceil(remaining);
    } else {
      badge.classList.remove('show');
    }
  }
  
  function hideBadge() { badge.classList.remove('show'); }
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
    imageClearTimeout = setTimeout(() => {
      imgAd.removeAttribute('src');
      imgAd.onload = null; imgAd.onerror = null;
    }, 500); 
  }

  // ---- The Broadcast Master Ticker (Pod Engine) ----------------------------
  function transitionToPhase(newPhase, targetAd = null, startOffsetSec = 0) {
    currentPhase = newPhase;

    if (newPhase === 'live') {
      setMode('live');
      currentAdType = null; currentAdId = null;
      hideBadge(); hideLoading(); hideImageLayer(); hideAdVideoLayer();
      unloadAdVideo(); // Guarantees zero ghost audio
      
      AudioEngine.fade(1, 0, 500);
      safePlay(liveEl);
      reportEvent('ad.complete');
      return;
    }

    if (newPhase === 'bumper') {
      setMode('ad');
      currentAdType = null;
      hideBadge(); hideImageLayer(); hideAdVideoLayer(); unloadAdVideo();
      
      loadingEl.classList.add('show');
      AudioEngine.fade(0, 0, 500); // Fades live out, keeps ad muted
      return;
    }

    // Entering a specific stitched Ad
    setMode('ad');
    hideLoading();
    currentAdType = targetAd.adType;
    currentAdId = targetAd.adId;

    if (currentAdType === 'image') {
      hideAdVideoLayer();
      unloadAdVideo();
      AudioEngine.fade(0, 0, 500); 
      showImageLayer(targetAd.metadata?.click_url);
      imgAd.src = targetAd.adUrl;
    } else {
      hideImageLayer();
      showAdVideoLayer();
      loadAdVideo(targetAd.adUrl, startOffsetSec);
      AudioEngine.fade(0, 1, 500); // Crossfade into Ad Audio
      safePlay(adEl);
    }

    reportEvent('ad.impression', { adId: currentAdId, phase: newPhase });
  }

  function tick() {
    if (currentMode !== 'ad' || currentPod.length === 0) return;

    const absoluteElapsedSec = Math.max(0, (Date.now() - podStartAt) / 1000);
    
    // 1. Are we in the bumper?
    if (absoluteElapsedSec < podBumperSec) {
      if (currentPhase !== 'bumper') transitionToPhase('bumper');
      return;
    }

    // 2. We are in the Ad phase. Which ad in the pod should be playing?
    let timeAccumulator = podBumperSec;
    let targetPhase = 'live';
    let targetAd = null;
    let activeAdElapsed = 0;
    let activeAdRemaining = 0;

    for (let i = 0; i < currentPod.length; i++) {
      const ad = currentPod[i];
      const adStart = timeAccumulator;
      const adEnd = adStart + ad.duration;
      
      if (absoluteElapsedSec >= adStart && absoluteElapsedSec < adEnd) {
        targetPhase = `ad:${i}`;
        targetAd = ad;
        activeAdElapsed = absoluteElapsedSec - adStart;
        activeAdRemaining = adEnd - absoluteElapsedSec;
        break;
      }
      timeAccumulator += ad.duration;
    }

    // 3. Execute Phase Transition if the active ad (or live state) changed
    if (currentPhase !== targetPhase) {
      transitionToPhase(targetPhase, targetAd, activeAdElapsed);
    }
    
    // 4. Update UI Countdown
    if (targetPhase !== 'live') {
      updateCountdown(activeAdRemaining);
    }
  }

  // ---- Command Dispatch ----------------------------------------------------
  function applyState(state) {
    if (!state) return;
    
    if (state.mode === 'pod' && state.pod) {
      currentPod = state.pod;
      podStartAt = state.startAt;
      podBumperSec = state.bumper || 7;
      currentTriggerId = state.triggerId;
      setMode('ad');
      if (!masterTicker) masterTicker = setInterval(tick, 100);
    } 
    // Legacy support for single ads
    else if (state.mode === 'ad' && state.adUrl) {
      currentPod = [{ adId: state.adId, adType: state.adType, adUrl: state.adUrl, duration: state.duration, metadata: state.metadata }];
      podStartAt = state.startAt;
      podBumperSec = state.bumper || 7;
      currentTriggerId = state.triggerId;
      setMode('ad');
      if (!masterTicker) masterTicker = setInterval(tick, 100);
    } 
    else if (state.mode === 'live') {
      clearInterval(masterTicker); masterTicker = null;
      transitionToPhase('live');
    }
  }

  function handleCommand(msg) {
    if (msg.action === 'play_pod') {
      applyState({ mode: 'pod', pod: msg.pod, startAt: msg.startAt, bumper: msg.bumper, triggerId: msg.triggerId });
    } else if (msg.action === 'play_ad') {
      applyState({ mode: 'ad', adId: msg.adId, adType: msg.adType, adUrl: msg.adUrl, duration: msg.duration, startAt: msg.startAt, bumper: msg.bumper, triggerId: msg.triggerId, metadata: msg.metadata });
    } else if (msg.action === 'resume_live') {
      clearInterval(masterTicker); masterTicker = null;
      transitionToPhase('live');
    }
  }

  // ---- Analytics & Sockets -------------------------------------------------
  let socket = null;
  function reportEvent(name, meta) {
    if (!socket || socket.readyState !== 1) return;
    try { socket.send(JSON.stringify({ type: 'event', name, triggerId: currentTriggerId, meta })); } catch {}
  }

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
