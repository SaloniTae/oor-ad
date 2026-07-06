/* eslint-env browser */
/**
 * Streaming Security GATE — wraps the ad-injection player without touching it.
 *
 * The ad-injection engine (app.js) is loaded verbatim from `main`. This gate
 * decides WHEN and WITH WHAT to boot it:
 *
 *   • Open channel  -> boot app.js immediately with the viewer WS. Identical
 *                      to main: raw live_url + ad injection, "We'll be right
 *                      back", countdowns, image/video ads — all unchanged.
 *   • Secured channel (link carries `secure=1&ch=<slug>`) -> show a PIN gate,
 *                      handle the device limit (ask-before-kick), then boot
 *                      app.js with `AD_INJECTION_CONFIG.liveUrl` pointed at the
 *                      short-lived SIGNED manifest. Ads still flow over the WS.
 *
 * app.js reads `window.AD_INJECTION_CONFIG` ({ wsUrl, liveUrl }) — that is the
 * only hook we use, so app.js needs zero edits.
 */
(function () {
  'use strict';

  var qs = new URLSearchParams(location.search);
  var wsUrl = qs.get('ws');
  var secure = qs.get('secure') === '1';
  var channelSlug = qs.get('ch') || '';

  var KICK_FLAG = 'oor.sec.kicked';
  var $ = function (id) { return document.getElementById(id); };
  var appBooted = false;

  // --- boot the pristine ad-injection player exactly once -------------------
  function bootApp(config) {
    if (appBooted) return;
    appBooted = true;
    window.AD_INJECTION_CONFIG = Object.assign({}, window.AD_INJECTION_CONFIG, config || {});
    var s = document.createElement('script');
    s.src = '/player/app.js';
    s.async = false;
    document.body.appendChild(s);
  }

  // Open channel (or a link without security markers): behave exactly like main.
  if (!secure || !channelSlug || !window.StreamSecurity) {
    bootApp({ wsUrl: wsUrl });
    return;
  }

  // ---------------- Secured channel: gate before booting app.js -------------
  var gate = $('sec-gate');
  var pinInput = $('sec-pin');
  var gateForm = $('sec-gate-form');
  var gateErr = $('sec-gate-err');
  var devices = $('sec-devices');
  var devList = $('sec-devices-list');
  var devErr = $('sec-devices-err');
  var devBack = $('sec-devices-back');
  var term = $('sec-terminated');
  var termRetry = $('sec-terminated-retry');

  var client = null;
  var busy = false;

  function show(el) { if (el) el.hidden = false; }
  function hide(el) { if (el) el.hidden = true; }
  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtSince(ms) {
    if (!ms) return 'just now';
    var s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }
  function friendly(e) {
    var s = (e && (e.message || String(e))) || '';
    if (/invalid_pin|401/i.test(s)) return 'That PIN was not recognised.';
    if (/pin_channel_mismatch|403/i.test(s)) return 'This PIN is not valid for this channel.';
    if (/rate_limited|429/i.test(s)) return 'Too many attempts — wait a moment and try again.';
    if (/channel_not_found|404/i.test(s)) return 'Channel not found.';
    return s || 'Something went wrong. Please try again.';
  }

  function showGate() {
    hide(devices); hide(term); show(gate);
    gateErr.textContent = '';
    pinInput.value = '';   // clear any prior entry so a retry never concatenates
    setTimeout(function () { try { pinInput.focus(); } catch (e) {} }, 50);
  }

  function showTerminated(reason) {
    hide(gate); hide(devices); show(term);
    var sub = $('sec-terminated-sub');
    if (sub) {
      sub.textContent = reason === 'kicked_by_owner'
        ? 'An administrator ended this session.'
        : 'This account is now watching on another device.';
    }
  }

  function showDevices(auth) {
    hide(gate); show(devices);
    devErr.textContent = '';
    devList.innerHTML = '';
    var sessions = auth.activeSessions || [];
    var sub = $('sec-devices-sub');
    if (sub && typeof auth.maxDevices === 'number') {
      sub.textContent = 'This PIN allows ' + auth.maxDevices + ' device' + (auth.maxDevices === 1 ? '' : 's') +
        '. End a session below to watch here, or go back and try later.';
    }
    sessions.forEach(function (s) {
      var row = document.createElement('div');
      row.className = 'sec-device';
      row.innerHTML =
        '<div class="sec-device-meta">' +
          '<div class="sec-device-name">' + escapeHtml(s.deviceLabel || 'Unknown device') + '</div>' +
          '<div class="sec-device-sub">' + escapeHtml(s.ip || '') + (s.ip ? ' · ' : '') + 'connected ' + fmtSince(s.connectedAt) + '</div>' +
        '</div>' +
        '<button class="sec-btn sec-btn-danger sec-device-end" type="button">End &amp; play here</button>';
      row.querySelector('.sec-device-end').addEventListener('click', function () { confirmKick(s.sessionId); });
      devList.appendChild(row);
    });
    if (!sessions.length) {
      devList.innerHTML = '<div class="sec-device-sub" style="padding:8px 2px">No other sessions found — go back and try again.</div>';
    }
  }

  async function submitPin() {
    if (busy) return;
    var pin = (pinInput.value || '').trim();
    if (!/^[0-9]{6,8}$/.test(pin)) { gateErr.textContent = 'Enter the 6–8 digit PIN.'; return; }
    busy = true; gateErr.textContent = 'Checking…';
    try {
      client = new StreamSecurity({ pin: pin, channelSlug: channelSlug });
      var auth = await client.authorize();
      if (auth.needsKick) { showDevices(auth); return; }
      grant();
    } catch (e) {
      gateErr.textContent = friendly(e);
    } finally { busy = false; }
  }

  async function confirmKick(sessionId) {
    if (busy) return;
    busy = true; devErr.textContent = 'Ending session…';
    try {
      await client.confirmKick(sessionId);
      grant();
    } catch (e) {
      devErr.textContent = friendly(e);
    } finally { busy = false; }
  }

  // Authorized: hand the SIGNED manifest to the pristine ad-injection player,
  // wire the lifecycle channel, and boot app.js.
  function grant() {
    try { sessionStorage.removeItem(KICK_FLAG); } catch (e) {}
    hide(gate); hide(devices); hide(term);
    try { client.connectLifecycleWs(); } catch (e) {}
    bootApp({ wsUrl: wsUrl, liveUrl: client.manifestUrl() });
  }

  // A kick MUST kill playback instantly and cleanly. app.js owns the video
  // elements and auto-resumes on pause, so the reliable stop is a reload into
  // the terminated screen (no app.js booted -> nothing plays).
  document.addEventListener('oor:session_terminated', function (ev) {
    var reason = (ev && ev.detail && ev.detail.reason) || 'terminated';
    try { sessionStorage.setItem(KICK_FLAG, reason); } catch (e) {}
    location.reload();
  });

  // Wire controls.
  gateForm.addEventListener('submit', function (e) { e.preventDefault(); submitPin(); });
  pinInput.addEventListener('input', function () { pinInput.value = pinInput.value.replace(/[^0-9]/g, ''); });
  devBack.addEventListener('click', function () { showGate(); });          // back / wait freely
  termRetry.addEventListener('click', function () {
    try { sessionStorage.removeItem(KICK_FLAG); } catch (e) {}
    showGate();
  });

  // Entry point: if we just got kicked, show the terminated screen (no
  // playback). Otherwise start at the PIN gate.
  var kicked = null;
  try { kicked = sessionStorage.getItem(KICK_FLAG); } catch (e) {}
  if (kicked) { showTerminated(kicked); }
  else { showGate(); }
})();
