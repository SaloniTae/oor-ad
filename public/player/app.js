/**
 * Ad Injection - viewer player (production build v12 - Broadcast Pod Engine)
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

  // ---- Global State Machine ------------------------------------------------
  let liveHls = null;
  let adHls   = null;
  let masterTicker = null;
  
  let currentMode = 'live';         
  let activeTriggerId = null;
  
  // Pod State
  let currentPod = [];
  let podStartAt = 0;
  let podBumperSec = 7;
  
  let currentPhase = 'live'; // 'live', 'bumper', 'ad:0', 'ad:1', etc.
  
  let userWantsSound = true;       

  const setStatus = (t, cls) => { statusEl.textContent = t; statusEl.className = 'status ' + (cls||''); };
  const setMode   = (m) => { currentMode = m; modeEl.textContent = m; };

  // ---- Audio Engine --------------------------------------------------------
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
      
      if (targetLiveVol > 0) liveEl.muted = false;
      if (targetAdVol > 0) adEl.muted = false;

      const step = (now) => {
        const progress = Math.min((now - startTime) / durationMs, 1);
        liveEl.volume = startLive + (targetLiveVol - startLive) * progress;
        adEl.volume = startAd + (targetAdVol - startAd) * progress;

        if (progress < 1) {
          this.raf = requestAnimationFrame(step);
        } else {
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
        const adIndex = parseInt(currentPhase.split(':')[1]);
        const adType = currentPod[adIndex]?.adType;
        this.fade(0, adType === 'image' ? 0 : 1, 0);
      }
    }
  };

  function safePlay(el) {
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
    
    if (currentPhase === 'live' && userWantsSound) liveEl.play().catch(()=>{});
    else if (currentPhase.startsWith('ad:') && userWantsSound) adEl.play().catch(()=>{});
  };

  // ---- Telemetry & Watchdog ------------------------------------------------
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
      if (prefix === 'live' && liveUrl && !el.ended) el.play().catch(()=>{});
    });
  }
  
  attachWatchdog(liveEl, 'live');
  attachWatchdog(adEl, 'ad');

  // ---- Player Loaders ------------------------------------------------------
  function newHlsConfig() {
    return {
      lowLatencyMode: true, startFragPrefetch: true, maxBufferLength: 30, backBufferLength: 60, maxMaxBufferLength: 60,
      manifestLoadingMaxRetry: 4, manifestLoadingRetryDelay: 500, fragLoadingMaxRetry: 6, fragLoadingRetryDelay: 500, autoStartLoad: true,
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
      });
    } else {
      adEl.src = url;
      try { 
        adEl.load(); 
        adEl.addEventListener('loadedmetadata', () => { adEl.currentTime = startTimeOffset; }, {once:true});
      } catch {}
    }
  }

  // ---- The Broadcast Master Ticker -----------------------------------------
  // This replaces all setTimeouts. It runs 10x a second and calculates exactly what should be on screen.
  
  function updateUI(remainingSeconds) {
    if (remainingSeconds > 0) {
      badge.classList.add('show');
      cd.textContent = Math.ceil(remainingSeconds);
    } else {
      badge.classList.remove('show');
    }
  }

  function transitionToPhase(newPhase, targetAd = null, startOffsetSec = 0) {
    currentPhase = newPhase;
    
    if (newPhase === 'live') {
      setMode('live');
      loadingEl.classList.remove('show');
      badge.classList.remove('show');
      imgLink.classList.remove('on');
      adEl.classList.remove('on');
      
      AudioEngine.fade(1, 0, 500);
      safePlay(liveEl);
      if (adHls) { try { adHls.destroy(); } catch {} adHls = null; }
      return;
    }

    if (newPhase === 'bumper') {
      setMode('ad');
      imgLink.classList.remove('on');
      adEl.classList.remove('on');
      loadingEl.classList.add('show');
      AudioEngine.fade(0, 0, 500);
      return;
    }

    // Entering a specific Ad in the Pod
    setMode('ad');
    loadingEl.classList.remove('show');
    
    if (targetAd.adType === 'image') {
      adEl.classList.remove('on');
      liveEl.muted = true; liveEl.volume = 0;
      
      imgAd.src = targetAd.adUrl;
      if (targetAd.metadata?.click_url) imgLink.setAttribute('href', targetAd.metadata.click_url);
      else imgLink.removeAttribute('href');
      imgLink.classList.add('on');
    } else {
      imgLink.classList.remove('on');
      loadAdVideo(targetAd.adUrl, startOffsetSec);
      
      adEl.classList.add('on');
      adEl.volume = 0;
      safePlay(adEl);
      AudioEngine.fade(0, 1, 500); 
    }
    
    reportEvent('ad.impression', { adId: targetAd.adId, phase: newPhase });
  }

  function tick() {
    if (currentMode !== 'ad' || currentPod.length === 0) return;

    const absoluteElapsedSec = Math.max(0, (Date.now() - podStartAt) / 1000);
    
    // 1. Are we in the bumper?
    if (absoluteElapsedSec < podBumperSec) {
      if (currentPhase !== 'bumper') transitionToPhase('bumper');
      return;
    }

    // 2. We are in the Ad phase. Which ad?
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

    // 3. Execute Phase Transition if needed
    if (currentPhase !== targetPhase) {
      transitionToPhase(targetPhase, targetAd, activeAdElapsed);
    }
    
    // 4. Update UI Countdown
    if (targetPhase !== 'live') {
      updateUI(activeAdRemaining);
    }
  }

  // Start the heartbeat
  masterTicker = setInterval(tick, 100);

  // ---- Command Dispatch ----------------------------------------------------
  function applyState(state) {
    if (!state) return;
    if (state.mode === 'pod' && state.pod) {
      // Instantly sync absolute state
      currentPod = state.pod;
      podStartAt = state.startAt;
      podBumperSec = state.bumper || 7;
      activeTriggerId = state.triggerId;
      setMode('ad');
    } else if (state.mode === 'live') {
      currentPod = [];
      transitionToPhase('live');
    }
  }

  function handleCommand(msg) {
    if (msg.action === 'play_pod') {
      currentPod = msg.pod;
      podStartAt = msg.startAt;
      podBumperSec = msg.bumper || 7;
      activeTriggerId = msg.triggerId;
      setMode('ad');
    }
    else if (msg.action === 'resume_live') {
      currentPod = [];
      transitionToPhase('live');
    }
  }

  // ---- Analytics & Sockets --------------------------------------------------
  let socket = null;
  function reportEvent(name, meta) {
    if (!socket || socket.readyState !== 1) return;
    try { socket.send(JSON.stringify({ type: 'event', name, triggerId: activeTriggerId, meta })); } catch {}
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
