/* eslint-env browser */
/**
 * Client helper to be dropped into the existing /player page.
 *
 * Usage:
 *   const s = new StreamSecurity({ pin, channelSlug });
 *   const auth = await s.authorize();     // returns { streamToken, sessionId, needsKick? }
 *   if (auth.needsKick) {
 *     // show modal with auth.activeSessions ; user picks one:
 *     const auth2 = await s.confirmKick(chosenSessionId);
 *   }
 *   s.connectLifecycleWs(({ type, reason }) => { ... });     // handles session_terminated
 *   const manifestUrl = s.manifestUrl();                     // pass to hls.js / video src
 */
(function (global) {
  'use strict';

  const DEVICE_KEY = 'oor.streamsec.deviceId';

  function deviceId() {
    let d = localStorage.getItem(DEVICE_KEY);
    if (!d) {
      d = (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16))).map(x=>x.toString(16).padStart(2,'0')).join(''));
      localStorage.setItem(DEVICE_KEY, d);
    }
    return d;
  }

  class StreamSecurity {
    constructor({ pin, channelSlug, apiBase = '' }) {
      if (!pin) throw new Error('pin required');
      if (!channelSlug) throw new Error('channelSlug required');
      this.pin = String(pin);
      this.channelSlug = String(channelSlug);
      this.apiBase = apiBase;
      this.deviceId = deviceId();
      this.streamToken = null;
      this.sessionId = null;
      this.ws = null;
      this.heartbeatIv = null;
    }

    async _post(path, body) {
      const r = await fetch(this.apiBase + path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, body: j };
    }

    async authorize() {
      const { status, body } = await this._post('/v1/stream/authorize', {
        pin: this.pin, deviceId: this.deviceId, channelSlug: this.channelSlug,
      });
      if (status === 200) {
        this.streamToken = body.streamToken;
        this.sessionId = body.sessionId;
        this._startHeartbeat(body.heartbeatSec || 30);
        return { needsKick: false, ...body };
      }
      if (status === 409) return { needsKick: true, ...body };
      throw new Error(body?.error?.message || body?.error || `authorize failed (${status})`);
    }

    async confirmKick(sessionIdToKick) {
      const { status, body } = await this._post('/v1/stream/confirm-kick', {
        pin: this.pin, deviceId: this.deviceId, channelSlug: this.channelSlug,
        sessionIdToKick,
      });
      if (status !== 200) throw new Error(body?.error?.message || `confirm-kick failed (${status})`);
      this.streamToken = body.streamToken;
      this.sessionId = body.sessionId;
      this._startHeartbeat(body.heartbeatSec || 30);
      return body;
    }

    _startHeartbeat(sec) {
      if (this.heartbeatIv) clearInterval(this.heartbeatIv);
      this.heartbeatIv = setInterval(async () => {
        try {
          const r = await fetch(this.apiBase + '/v1/stream/heartbeat', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + this.streamToken },
          });
          if (r.status === 403) this._onTerminated('server_terminated');
        } catch {}
      }, Math.max(15, sec) * 1000);
    }

    connectLifecycleWs(onEvent) {
      if (!this.streamToken) throw new Error('call authorize() first');
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/stream-ws?stoken=${encodeURIComponent(this.streamToken)}`;
      this.ws = new WebSocket(url);
      this.ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'session_terminated') this._onTerminated(m.reason || 'kicked');
        if (typeof onEvent === 'function') onEvent(m);
      });
      this.ws.addEventListener('close', (ev) => {
        if (ev.code === 4408) this._onTerminated('session_terminated');
      });
    }

    _onTerminated(reason) {
      if (this.heartbeatIv) { clearInterval(this.heartbeatIv); this.heartbeatIv = null; }
      // Fire a DOM event; the outer player is responsible for pausing +
      // destroying the HLS/DASH player instance (do NOT just pause — destroy).
      document.dispatchEvent(new CustomEvent('oor:session_terminated', { detail: { reason } }));
    }

    /** URL the video/HLS player should load. Server rewrites the manifest. */
    manifestUrl() {
      if (!this.streamToken) throw new Error('call authorize() first');
      return this.apiBase + '/v1/stream/manifest?stoken=' + encodeURIComponent(this.streamToken);
    }

    /** For MP4 hot-swap flow. Call every refreshInSec seconds. */
    async refreshUrl() {
      const r = await fetch(this.apiBase + '/v1/stream/refresh-url', {
        method: 'POST', headers: { authorization: 'Bearer ' + this.streamToken },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message || 'refresh failed');
      return j;
    }
  }

  global.StreamSecurity = StreamSecurity;
})(window);
