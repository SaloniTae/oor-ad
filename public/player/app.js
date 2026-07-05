/**
 * Ad Injection - viewer player (production build v17 - Elite Sync & Telemetry + Pods)
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

  // ---- Streaming security state --------------------------------------------
  // Populated from the WS `welcome` message. When a channel requires a PIN we
  // gate playback behind PIN + device-limit and swap the raw live_url for a
  // short-lived signed manifest. The ad-injection engine below is untouched.
  let secClient   = null;     // StreamSecurity instance (from stream-security-client.js)
  let secRequired = false;    // channel.requirePin
  let secChannel  = null;     // channel slug for authorize()
  let secForceHls = false;    // live source is our signed manifest -> always via hls.js
  let secGranted  = false;    // authorize succeeded, playing signed source

  // ---- Global State --------------------------------------------------------
  let liveHls = null;
  let adHls   = null;
  let masterTicker = null;
  let imageClearTimeout = null;

  let currentMode = 'live';         // 'live' | 'ad'
  let currentPhase = 'live';        // 'live' | 'bumper' | 'ad:0' | 'ad:1' ...
  let currentAdType = null;         // 'video' | 'hls' | 'image' | null
  let currentAdId = null;
  let currentTriggerId = null;
  let currentToken = 0;

  // Pod state
  let currentPod = [];
  let podStartAt = 0;
  let podBumperSec = 7;

  let userWantsSound = true;
  let isBumperActive = false;

  const setStatus = (t, cls) => { statusEl.textContent = t; statusEl.className = 'status ' + (cls||''); };
  const setMode   = (m) => { currentMode = m; modeEl.textContent = m; };

  // ---- Audio Engine (Atomic Interpolator) ----------------------------------
  const clampVol = (v) => {
    if (!Number.isFinite(v)) return 0;
    return Math.min(1, Math.max(0, v));
  };

  const AudioEngine = {
    raf: null,
    fade(targetLiveVol, targetAdVol, durationMs = 500) {
      cancelAnimationFrame(this.raf);

      targetLiveVol = clampVol(targetLiveVol);
      targetAdVol = clampVol(targetAdVol);

      if (!userWantsSound) {
        liveEl.muted = true; adEl.muted = true;
        liveEl.volume = targetLiveVol; adEl.volume = targetAdVol;
        return;
      }

      // Zero (or invalid) duration: snap instantly, skip rAF interpolation entirely
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        liveEl.volume = targetLiveVol;
        adEl.volume = targetAdVol;
        if (targetLiveVol > 0) liveEl.muted = false; else liveEl.muted = true;
        if (targetAdVol > 0) adEl.muted = false; else adEl.muted = true;
        return;
      }

      const startLive = clampVol(liveEl.volume);
      const startAd = clampVol(adEl.volume);
      const startTime = performance.now();

      if (targetLiveVol > 0) liveEl.muted = false;
      if (targetAdVol > 0) adEl.muted = false;

      const step = (now) => {
        const progress = Math.min(Math.max((now - startTime) / durationMs, 0), 1);
        liveEl.volume = clampVol(startLive + (targetLiveVol - startLive) * progress);
        adEl.volume = clampVol(startAd + (targetAdVol - startAd) * progress);

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

    const target = currentMode === 'live' ? liveEl : (currentAdType !== 'image' && !isBumperActive ? adEl : null);
    if (target && userWantsSound) target.play().catch(()=>{});
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
      if (prefix === 'live' && currentMode === 'live') report('freeze', 'buffer starved');
      if (prefix === 'ad' && currentMode === 'ad' && !isBumperActive) report('freeze', 'ad buffer starved');
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

    // Our signed manifest endpoint (/v1/stream/manifest) serves an HLS playlist
    // without a `.m3u8` suffix, so force hls.js when playing the secure source.
    const isHls = secForceHls || /\.m3u8(\?|$)/i.test(liveUrl);
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
          adEl.addEventListener('loadedmetadata', () => { adEl.currentTime = startTimeOffset; }, {once:true});
        }
      } catch {}
    }
  }

  function unloadAdVideo() {
    if (adHls) { try { adHls.destroy(); } catch {} adHls = null; }
    try { adEl.pause(); } catch {}
    adEl.removeAttribute('src'); try { adEl.load(); } catch {}
  }

  // ---- DOM GC Helpers -------------------------------------------------------
  function updateCountdownUI(remaining) {
    if (remaining > 0) {
      badge.classList.add('show');
      cd.textContent = Math.ceil(remaining);
    }
  }

  function hideBadge() {
    badge.classList.remove('show');
  }

  function hideLoading() { loadingEl && loadingEl.classList.remove('show'); }
  function showLoading() { loadingEl && loadingEl.classList.add('show'); }
  function hideAdVideoLayer() { adEl.classList.remove('on'); }
  function showAdVideoLayer() { adEl.classList.add('on'); }

  function showImageLayer(clickUrl) {
    if (clickUrl) imgLink.setAttribute('href', clickUrl);
    else imgLink.removeAttribute('href');
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

  // Completely garbage collects any active ad UI/timers to guarantee zero overlap
  function abortCurrentAd() {
    clearInterval(masterTicker);
    masterTicker = null;
    isBumperActive = false;

    hideBadge();
    hideLoading();
    hideImageLayer();
    hideAdVideoLayer();
    unloadAdVideo();
  }

  function returnToLive() {
    ++currentToken;
    abortCurrentAd();

    if (currentMode === 'live' && !currentAdType) return;

    currentMode = 'live';
    currentPhase = 'live';
    currentAdType = null; currentAdId = null; currentTriggerId = null;
    currentPod = [];

    setMode('live');

    AudioEngine.fade(1, 0, 500);
    safePlay(liveEl);

    reportEvent('ad.complete');
  }

  // ---- Broadcast Master Ticker (Pod Engine) --------------------------------
  function tick() {
    if (currentMode !== 'ad' || currentPod.length === 0) return;

    const absoluteElapsedSec = Math.max(0, (Date.now() - podStartAt) / 1000);

    // 1. Bumper phase
    if (absoluteElapsedSec < podBumperSec) {
      if (currentPhase !== 'bumper') {
        currentPhase = 'bumper';
        currentAdType = null;
        isBumperActive = true;

        hideImageLayer();
        hideAdVideoLayer();
        showLoading();
        // Live audio keeps playing under the bumper screen — only the ad itself mutes it
      }
      return;
    }

    // 2. Determine which ad in the pod is active
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

    // 3. Pod finished -> back to live
    if (targetPhase === 'live') {
      returnToLive();
      return;
    }

    // 4. Transition into a new ad slot within the pod
    if (currentPhase !== targetPhase) {
      const myToken = currentToken;
      currentPhase = targetPhase;
      currentAdType = targetAd.adType;
      currentAdId = targetAd.adId;
      isBumperActive = false;

      hideLoading();

      if (currentAdType === 'image') {
        hideAdVideoLayer();
        unloadAdVideo();

        // FIX: The bumper's hideImageLayer() timeout wiped the DOM src 6.5s ago!
        // We MUST re-apply it here. Because it was preloaded, it will be instant.
        clearTimeout(imageClearTimeout);
        imgAd.src = targetAd.adUrl;

        showImageLayer(targetAd.metadata?.click_url);
        liveEl.muted = true;
        liveEl.volume = 0;
        AudioEngine.syncHardware();
      } else {
        hideImageLayer();
        showAdVideoLayer();

        if (targetPhase !== 'ad:0') {
          loadAdVideo(targetAd.adUrl, activeAdElapsed);
        } else if (activeAdElapsed > 0.5) {
          adEl.currentTime = activeAdElapsed; // late joiner sync
        }

        adEl.volume = 0;
        safePlay(adEl);
        AudioEngine.fade(0, 1, 500);
      }

      // Preload the next asset if it's an image (video preloads via loadAdVideo above)
      const nextIndex = parseInt(targetPhase.split(':')[1], 10) + 1;
      if (nextIndex < currentPod.length && currentPod[nextIndex].adType === 'image') {
        new Image().src = currentPod[nextIndex].adUrl;
      }

      reportEvent('ad.impression', { adId: targetAd.adId, phase: currentPhase });

      void myToken; // token reserved for future guard use inside tick if needed
    }

    updateCountdownUI(activeAdRemaining);
  }

  function startPod(pod, startAt, bumperSec, triggerId) {
    ++currentToken;
    abortCurrentAd();

    currentPod = pod;
    podStartAt = startAt;
    podBumperSec = bumperSec || 7;
    currentTriggerId = triggerId;
    currentPhase = 'live'; // force tick() to detect a phase transition
    setMode('ad');

    // Preload the first ad immediately (covers the bumper window)
    if (currentPod.length > 0) {
      if (currentPod[0].adType === 'image') {
        clearTimeout(imageClearTimeout);
        imgAd.src = currentPod[0].adUrl;
      } else {
        loadAdVideo(currentPod[0].adUrl, 0);
      }
    }

    if (!masterTicker) masterTicker = setInterval(tick, 100);
    tick();
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

    if (state.mode === 'pod' && state.pod && state.pod.length) {
      const pod = state.pod.map(ad => ({ ...ad, adType: ad.adType || inferAdType(ad) }));
      startPod(pod, state.startAt || Date.now(), state.bumper, state.triggerId);
    } else if (state.mode === 'ad' && state.adUrl) {
      // Single ad -> wrap as a one-item pod so it flows through the same engine
      const pod = [{
        adId: state.adId, adType: inferAdType(state), adUrl: state.adUrl,
        duration: state.duration || 15, metadata: state.metadata,
      }];
      startPod(pod, state.startAt || Date.now(), state.bumper, state.triggerId);
    } else if (currentMode === 'ad') {
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
          secRequired = !!m.channel.requirePin;
          secChannel  = m.channel.slug;
          if (!secRequired) liveUrl = liveUrl || m.channel.liveUrl;
        }
        if (secRequired) {
          // Secured channel: do NOT play the raw live_url. Gate behind PIN and
          // only start playback once we hold a signed manifest (Security flow).
          if (!secGranted) Security.showGate();
        } else if (liveUrl && !liveHls && !liveEl.src) {
          loadLive();
        }
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

  // ---- Streaming Security orchestration -------------------------------------
  // Drives the PIN gate / device-limit modal / terminated overlay defined in
  // index.html. Talks to the backend via window.StreamSecurity (the reusable
  // client in stream-security-client.js): authorize -> confirm-kick -> signed
  // manifest -> lifecycle WS. On success it hands the signed manifest to the
  // existing loadLive() engine; ad injection continues unchanged over `socket`.
  const secGate     = $('sec-gate');
  const secPinInput = $('sec-pin');
  const secGateForm = $('sec-gate-form');
  const secGateErr  = $('sec-gate-err');
  const secDevices  = $('sec-devices');
  const secDevList  = $('sec-devices-list');
  const secDevErr   = $('sec-devices-err');
  const secDevCancel = $('sec-devices-cancel');
  const secTerm     = $('sec-terminated');
  const secTermRetry = $('sec-terminated-retry');

  function fmtSince(ms) {
    if (!ms) return 'just now';
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }
  function show(el) { if (el) el.hidden = false; }
  function hide(el) { if (el) el.hidden = true; }

  const Security = {
    _busy: false,

    showGate() {
      hide(secDevices); hide(secTerm);
      show(secGate);
      secGateErr.textContent = '';
      setTimeout(() => { try { secPinInput.focus(); } catch {} }, 50);
    },

    async submitPin() {
      if (this._busy) return;
      const pin = (secPinInput.value || '').trim();
      if (!/^[0-9]{6,8}$/.test(pin)) { secGateErr.textContent = 'Enter the 6–8 digit PIN.'; return; }
      if (!secChannel) { secGateErr.textContent = 'Channel unavailable. Refresh and try again.'; return; }
      this._busy = true;
      secGateErr.textContent = 'Checking…';
      try {
        if (!window.StreamSecurity) throw new Error('security client unavailable');
        secClient = new StreamSecurity({ pin, channelSlug: secChannel });
        const auth = await secClient.authorize();
        if (auth.needsKick) { this._showDevices(auth); return; }
        this._onGranted();
      } catch (e) {
        secGateErr.textContent = this._msg(e);
      } finally {
        this._busy = false;
      }
    },

    _showDevices(auth) {
      hide(secGate); show(secDevices);
      secDevErr.textContent = '';
      secDevList.innerHTML = '';
      const sessions = auth.activeSessions || [];
      const sub = $('sec-devices-sub');
      if (sub && typeof auth.maxDevices === 'number') {
        sub.textContent = `This PIN allows ${auth.maxDevices} device${auth.maxDevices === 1 ? '' : 's'}. End one to watch here.`;
      }
      for (const s of sessions) {
        const row = document.createElement('div');
        row.className = 'sec-device';
        row.innerHTML = `
          <div class="sec-device-meta">
            <div class="sec-device-name">${escapeHtml(s.deviceLabel || 'Unknown device')}</div>
            <div class="sec-device-sub">${escapeHtml(s.ip || '')}${s.ip ? ' · ' : ''}connected ${fmtSince(s.connectedAt)}</div>
          </div>
          <button class="sec-btn sec-btn-danger sec-device-end" type="button">End &amp; play here</button>`;
        row.querySelector('.sec-device-end').addEventListener('click', () => this._confirmKick(s.sessionId));
        secDevList.appendChild(row);
      }
      if (!sessions.length) {
        secDevList.innerHTML = '<div class="sec-device-sub" style="padding:8px 2px">No other sessions found — try again.</div>';
      }
    },

    async _confirmKick(sessionId) {
      if (this._busy) return;
      this._busy = true;
      secDevErr.textContent = 'Ending session…';
      try {
        await secClient.confirmKick(sessionId);
        this._onGranted();
      } catch (e) {
        secDevErr.textContent = this._msg(e);
      } finally {
        this._busy = false;
      }
    },

    _onGranted() {
      secGranted = true;
      hide(secGate); hide(secDevices); hide(secTerm);
      // Swap in the signed manifest and start the existing live engine.
      secForceHls = true;
      liveUrl = secClient.manifestUrl();
      loadLive();
      // Listen for kicks from other devices or the admin.
      try {
        secClient.connectLifecycleWs();
      } catch {}
    },

    onTerminated(reason) {
      secGranted = false;
      // Fully tear down playback — pausing is not enough; the source must die.
      try { if (liveHls) { liveHls.destroy(); liveHls = null; } } catch {}
      try { if (adHls)   { adHls.destroy();   adHls = null; } } catch {}
      try { liveEl.pause(); liveEl.removeAttribute('src'); liveEl.load(); } catch {}
      abortCurrentAd();
      const sub = $('sec-terminated-sub');
      if (sub) {
        sub.textContent = reason === 'kicked_by_owner'
          ? 'An administrator ended this session.'
          : reason === 'ua_change_detected'
          ? 'Session ended for security (device signature changed).'
          : 'This account is now streaming on another device.';
      }
      hide(secGate); hide(secDevices); show(secTerm);
    },

    _msg(e) {
      const s = e && (e.message || String(e));
      if (/invalid_pin|401/i.test(s)) return 'That PIN was not recognised.';
      if (/pin_channel_mismatch|403/i.test(s)) return 'This PIN is not valid for this channel.';
      if (/rate_limited|429/i.test(s)) return 'Too many attempts — wait a moment and retry.';
      if (/channel_not_found|404/i.test(s)) return 'Channel not found.';
      return s || 'Something went wrong. Try again.';
    },
  };

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  secGateForm.addEventListener('submit', (e) => { e.preventDefault(); Security.submitPin(); });
  secPinInput.addEventListener('input', () => { secPinInput.value = secPinInput.value.replace(/[^0-9]/g, ''); });
  secDevCancel.addEventListener('click', () => { hide(secDevices); Security.showGate(); });
  secTermRetry.addEventListener('click', () => { hide(secTerm); Security.showGate(); });

  // Player instances MUST be destroyed (not just paused) when the session ends.
  document.addEventListener('oor:session_terminated', (ev) => {
    Security.onTerminated(ev && ev.detail && ev.detail.reason);
  });

  connect();
})();
