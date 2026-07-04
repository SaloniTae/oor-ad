/**
 * Ad Injection - viewer player (production build v16 - Strict Repo Logic + Pods)
 */
(() => {
  const $ = (id) => document.getElementById(id);
  
  const liveEl = $('videoA');            // fixed role: LIVE
  const adEl   = $('videoB');            // fixed role: AD (video ads only)
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
  
  let currentMode = 'live';         // 'live' | 'ad'
  let currentPhase = 'live';        // 'live' | 'bumper' | 'ad:0' | 'ad:1'
  let currentAdType = null;         // 'video' | 'hls' | 'image' | null
  
  // Pod State
  let currentPod = [];
  let podStartAt = 0;
  let podBumperSec = 7;
  let currentTriggerId = null;
  
  let userWantsSound = false;       

  const setStatus = (t, cls) => { statusEl.textContent = t; statusEl.className = 'status ' + (cls||''); };
  const setMode   = (m) => { currentMode = m; modeEl.textContent = m; };

  // ---- Strict Repo Audio Engine --------------------------------------------
  // Reverted entirely to the bulletproof, instant toggle logic
  function applyAudioState() {
    if (currentPhase === 'live') {
      liveEl.muted = !userWantsSound;
      adEl.muted   = true;
    } else if (currentPhase === 'bumper') {
      liveEl.muted = true;
      adEl.muted   = true;
    } else {
      // Inside an actual ad
      if (currentAdType === 'image') {
        liveEl.muted = true;
        adEl.muted   = true;
      } else {
        liveEl.muted = true;
        adEl.muted   = !userWantsSound;
      }
    }
  }

  unmuteBtn.onclick = () => {
    userWantsSound = !userWantsSound;
    unmuteBtn.textContent = userWantsSound ? 'Mute' : 'Tap to Unmute';
    applyAudioState();
    
    // Kick playback on the currently-audible element
    const audible = (currentPhase === 'live') ? liveEl : (currentAdType !== 'image' && currentPhase !== 'bumper' ? adEl : null);
    if (audible) audible.play().catch(() => {});
  };

  // ---- HLS Loader (Strictly from Repo) -------------------------------------
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

  function loadAdVideo(url, startTimeOffset = 0) {
    if (adHls) { try { adHls.destroy(); } catch {} adHls = null; }
    try { adEl.pause(); } catch {}
    adEl.removeAttribute('src'); try { adEl.load(); } catch {}

    // Force background muting during load
    adEl.autoplay = false; 
    adEl.muted = true;

    const isHls = /\.m3u8(\?|$)/i.test(url);
    if (isHls && window.Hls && Hls.isSupported()) {
      adHls = new Hls(newHlsConfig());
      adHls.attachMedia(adEl);
      adHls.on(Hls.Events.MEDIA_ATTACHED, () => {
        adHls.loadSource(url);
      });
      adHls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (startTimeOffset > 0) adEl.currentTime = startTimeOffset;
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
        if (startTimeOffset > 0) {
          adEl.addEventListener('loadedmetadata', () => { adEl.currentTime = startTimeOffset; }, {once: true});
        }
      } catch {}
    }
  }

  function unloadAdVideo() {
    if (adHls) { try { adHls.destroy(); } catch {} adHls = null; }
    try { adEl.pause(); } catch {}
    adEl.removeAttribute('src'); try { adEl.load(); } catch {}
  }

  // ---- UI Helpers -----------------------------------------------------------
  function updateCountdownUI(remaining) {
    if (remaining > 0) {
      badge.classList.remove('hidden');
      badge.classList.add('show');
      cd.textContent = Math.ceil(remaining);
    }
  }

  function hideBadge() {
    badge.classList.remove('show');
    badge.classList.add('hidden');
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
    clearTimeout(imageClearTimeout);
    imageClearTimeout = setTimeout(() => {
      imgAd.removeAttribute('src');
      imgAd.onload = null; imgAd.onerror = null;
    }, 500); 
  }

  // ---- The Broadcast Master Ticker (Pod Engine) ----------------------------
  function returnToLive() {
    clearInterval(masterTicker); 
    masterTicker = null;
    
    if (currentPhase === 'live') return;
    
    const wasVideoAd = (currentAdType === 'video' || currentAdType === 'hls');
    
    currentMode = 'live';
    currentPhase = 'live';
    currentAdType = null;
    currentTriggerId = null;
    currentPod = [];
    
    setMode('live');
    hideBadge();
    hideLoading();
    hideImageLayer();
    hideAdVideoLayer();
    
    if (wasVideoAd) unloadAdVideo(); // Guarantees zero ghost audio
    
    applyAudioState(); // Snaps audio instantly
    liveEl.play().catch(() => {});
    
    reportEvent('ad.complete');
  }

  function tick() {
    if (currentMode !== 'ad' || currentPod.length === 0) return;

    const absoluteElapsedSec = Math.max(0, (Date.now() - podStartAt) / 1000);
    
    // 1. Bumper Phase
    if (absoluteElapsedSec < podBumperSec) {
      if (currentPhase !== 'bumper') {
        currentPhase = 'bumper';
        currentAdType = null;
        
        hideImageLayer();
        hideAdVideoLayer();
        showLoading(); 
        
        applyAudioState(); // Instantly mutes live
      }
      return;
    }

    // 2. Ad Phase (Calculate which ad)
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

    // 3. Execution
    if (targetPhase === 'live') {
      returnToLive();
      return;
    }

    if (currentPhase !== targetPhase) {
      currentPhase = targetPhase;
      currentAdType = targetAd.adType;
      
      hideLoading();
      
      if (currentAdType === 'image') {
        hideAdVideoLayer();
        unloadAdVideo(); // Clear video DOM entirely
        
        // If it isn't the first ad (which was preloaded), set the src now
        if (targetPhase !== 'ad:0') imgAd.src = targetAd.adUrl;
        
        showImageLayer(targetAd.metadata?.click_url);
        applyAudioState();
      } else {
        hideImageLayer();
        showAdVideoLayer();
        
        // If it isn't the first ad (which was preloaded), load it now
        if (targetPhase !== 'ad:0') {
          loadAdVideo(targetAd.adUrl, activeAdElapsed);
        } else if (activeAdElapsed > 0.5) {
          adEl.currentTime = activeAdElapsed; // Late joiner sync
        }
        
        applyAudioState();
        adEl.play().catch(()=>{});
      }
      
      // PRELOAD NEXT ASSET (if image)
      const nextIndex = parseInt(targetPhase.split(':')[1]) + 1;
      if (nextIndex < currentPod.length && currentPod[nextIndex].adType === 'image') {
        new Image().src = currentPod[nextIndex].adUrl;
      }
      
      reportEvent('ad.impression', { adId: targetAd.adId, phase: currentPhase });
    }
    
    updateCountdownUI(activeAdRemaining);
  }

  // ---- Command Dispatch ----------------------------------------------------
  function inferAdType(msg) {
    if (msg.adType) return msg.adType;
    const u = String(msg.adUrl || '').split('?')[0].split('#')[0].toLowerCase();
    if (/\.m3u8$/.test(u)) return 'hls';
    if (/\.(png|jpe?g|webp|gif|avif|heic|heif|bmp)$/.test(u)) return 'image';
    return 'video';
  }

  function applyState(state) {
    if (!state) return;
    
    if (state.mode === 'pod' && state.pod) {
      currentPod = state.pod;
      podStartAt = state.startAt;
      podBumperSec = state.bumper || 7;
      currentTriggerId = state.triggerId;
      setMode('ad');
      
      // FIX: Preload the FIRST ad immediately during bumper
      if (currentPod.length > 0) {
        if (currentPod[0].adType === 'image') imgAd.src = currentPod[0].adUrl;
        else loadAdVideo(currentPod[0].adUrl, 0);
      }
      
      if (!masterTicker) masterTicker = setInterval(tick, 100);
      tick();
    } 
    else if (state.mode === 'ad' && state.adUrl) {
      currentPod = [{ adId: state.adId, adType: state.adType, adUrl: state.adUrl, duration: state.duration, metadata: state.metadata }];
      podStartAt = state.startAt;
      podBumperSec = state.bumper || 7;
      currentTriggerId = state.triggerId;
      setMode('ad');
      
      // FIX: Preload the FIRST ad immediately during bumper
      if (currentPod[0].adType === 'image') imgAd.src = currentPod[0].adUrl;
      else loadAdVideo(currentPod[0].adUrl, 0);
      
      if (!masterTicker) masterTicker = setInterval(tick, 100);
      tick();
    } 
    else if (state.mode === 'live') {
      returnToLive();
    }
  }

  function handleCommand(msg) {
    if (msg.action === 'play_pod') {
      applyState({ mode: 'pod', pod: msg.pod, startAt: msg.startAt, bumper: msg.bumper, triggerId: msg.triggerId });
    } else if (msg.action === 'play_ad') {
      applyState({ mode: 'ad', adId: msg.adId, adType: msg.adType, adUrl: msg.adUrl, duration: msg.duration, startAt: msg.startAt, bumper: msg.bumper, triggerId: msg.triggerId, metadata: msg.metadata });
    } else if (msg.action === 'resume_live') {
      returnToLive();
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
    setStatus('connecting...');
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
