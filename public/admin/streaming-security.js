/* eslint-env browser */
/**
 * Streaming Security admin panel — single-page vanilla JS.
 *
 * All requests go to /v1/admin/streaming/* with a Bearer token that is either
 * a tenant session JWT (from /v1/auth/signin) or a raw API key. Session token
 * lives in sessionStorage so it clears when the tab closes; API key lives in
 * localStorage under a namespaced key.
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const S = {
    get token() { return sessionStorage.getItem('secstream.token') || localStorage.getItem('secstream.apikey') || ''; },
    setSession(t) { sessionStorage.setItem('secstream.token', t); localStorage.removeItem('secstream.apikey'); },
    setKey(k)     { localStorage.setItem('secstream.apikey', k); sessionStorage.removeItem('secstream.token'); },
    clear() { sessionStorage.removeItem('secstream.token'); localStorage.removeItem('secstream.apikey'); },
  };

  async function api(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (S.token) headers.authorization = 'Bearer ' + S.token;
    const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!r.ok) throw Object.assign(new Error(json?.error?.message || r.statusText), { status: r.status, body: json });
    return json;
  }

  function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toLocaleString();
  }
  function fmtSince(ms) {
    if (!ms) return '—';
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }

  async function trySignin(email, pw) {
    const r = await fetch('/v1/auth/signin', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: pw }),
    });
    if (!r.ok) throw new Error('sign-in failed');
    const j = await r.json();
    S.setSession(j.token);
  }

  async function afterAuth() {
    try {
      await api('GET', '/v1/admin/streaming/pins');
      $('#signin').hidden = true;
      $('#auth-label').textContent = 'authenticated';
      $('#btn-signout').hidden = false;
      switchTab('pins');
    } catch (e) {
      S.clear();
      $('#signin').hidden = false;
      $('#signin-err').textContent = e.message || 'auth failed';
    }
  }

  $('#btn-signin').addEventListener('click', async () => {
    try {
      $('#signin-err').textContent = '';
      await trySignin($('#in-email').value.trim(), $('#in-pw').value);
      await afterAuth();
    } catch (e) { $('#signin-err').textContent = e.message; }
  });
  $('#btn-usekey').addEventListener('click', async () => {
    const k = $('#in-key').value.trim();
    if (!k.startsWith('adi_')) { $('#signin-err').textContent = 'API key must start with adi_'; return; }
    S.setKey(k);
    await afterAuth();
  });
  $('#btn-signout').addEventListener('click', () => { S.clear(); location.reload(); });

  const tabs = ['pins', 'sessions', 'revocations', 'edge'];
  function switchTab(name) {
    for (const t of tabs) {
      $(`#tab-${t}`).hidden = t !== name;
      const btn = document.querySelector(`.tab[data-tab="${t}"]`);
      if (btn) btn.classList.toggle('active', t === name);
    }
    if (name === 'pins')        loadPins();
    if (name === 'revocations') loadRevs();
    if (name === 'edge')        loadEdge();
  }
  $$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  async function loadPins() {
    try {
      const j = await api('GET', '/v1/admin/streaming/pins');
      const tbody = $('#pins-tbody');
      tbody.innerHTML = '';
      if (!j.items.length) { $('#pins-empty').hidden = false; return; }
      $('#pins-empty').hidden = true;
      for (const p of j.items) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="pin-cell">${p.pin}</td>
          <td>${p.label || '—'}</td>
          <td class="mono">${p.channelId || '<any>'}</td>
          <td><input type="number" min="1" max="100" value="${p.maxDevices}" data-pin="${p.pin}" class="max-in" style="width:70px"></td>
          <td class="muted">${fmtTime(p.createdAt)}</td>
          <td class="muted">${p.expiresAt ? fmtTime(p.expiresAt) : 'never'}</td>
          <td>
            <button class="small ghost" data-view-sessions="${p.pin}">Sessions</button>
            <button class="small danger" data-disable="${p.pin}">${p.disabled ? 'Enable' : 'Disable'}</button>
          </td>`;
        tbody.appendChild(tr);
      }
      tbody.querySelectorAll('.max-in').forEach((el) => {
        el.addEventListener('change', async () => {
          try {
            await api('PATCH', `/v1/admin/streaming/pins/${el.dataset.pin}/device-limit`, { maxDevices: Number(el.value) });
            el.style.borderColor = 'var(--ok)';
            setTimeout(() => (el.style.borderColor = ''), 800);
          } catch (e) {
            alert('Update failed: ' + e.message);
          }
        });
      });
      tbody.querySelectorAll('[data-view-sessions]').forEach((b) => b.addEventListener('click', () => {
        $('#sess-pin').value = b.dataset.viewSessions;
        switchTab('sessions'); loadSessions();
      }));
      tbody.querySelectorAll('[data-disable]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Disable this PIN? Active sessions will remain until they expire.')) return;
        await api('DELETE', `/v1/admin/streaming/pins/${b.dataset.disable}`);
        loadPins();
      }));
    } catch (e) { alert('Load failed: ' + e.message); }
  }

  $('#btn-newpin').addEventListener('click', () => { $('#modal-newpin').hidden = false; });
  $('#np-cancel').addEventListener('click', () => { $('#modal-newpin').hidden = true; });
  $('#np-create').addEventListener('click', async () => {
    try {
      $('#np-err').textContent = '';
      const body = {
        label: $('#np-label').value || null,
        channelSlug: $('#np-slug').value || null,
        maxDevices: Number($('#np-max').value) || 1,
        length: Number($('#np-len').value) || 6,
      };
      const ttl = Number($('#np-ttl').value);
      if (ttl > 0) body.ttlSeconds = ttl;
      const j = await api('POST', '/v1/admin/streaming/pins', body);
      $('#modal-newpin').hidden = true;
      alert(`PIN created: ${j.pin}\n\nGive this to the viewer. It's shown once.`);
      loadPins();
    } catch (e) { $('#np-err').textContent = e.message; }
  });

  let sessTimer = null;
  async function loadSessions() {
    const pin = $('#sess-pin').value.trim();
    if (!pin) return;
    try {
      const j = await api('GET', `/v1/admin/streaming/pins/${pin}/sessions`);
      const tbody = $('#sess-tbody');
      tbody.innerHTML = '';
      if (!j.items.length) { $('#sess-empty').hidden = false; return; }
      $('#sess-empty').hidden = true;
      for (const s of j.items) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${s.deviceLabel}<div class="muted" style="font-size:11px">device: <code>${s.deviceId.slice(0,10)}…</code></div></td>
          <td class="mono">${s.ip || '—'}</td>
          <td class="muted">${fmtSince(s.connectedAt)}</td>
          <td class="muted">${fmtSince(s.lastHeartbeat)}</td>
          <td class="mono">${s.sessionId.slice(0,12)}…</td>
          <td><button class="small danger" data-kick="${s.sessionId}">Kick</button></td>`;
        tbody.appendChild(tr);
      }
      tbody.querySelectorAll('[data-kick]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Kick this session? The device will be signed out immediately.')) return;
        await api('POST', `/v1/admin/streaming/pins/${pin}/sessions/${b.dataset.kick}/kick`);
        loadSessions();
      }));
    } catch (e) {
      $('#sess-empty').hidden = false;
      $('#sess-empty').textContent = e.message;
    }
  }
  $('#btn-loadsess').addEventListener('click', loadSessions);
  $('#autorefresh').addEventListener('change', () => {
    if (sessTimer) { clearInterval(sessTimer); sessTimer = null; }
    if ($('#autorefresh').checked) sessTimer = setInterval(() => { if (!$('#tab-sessions').hidden) loadSessions(); }, 10_000);
  });
  sessTimer = setInterval(() => { if (!$('#tab-sessions').hidden) loadSessions(); }, 10_000);

  async function loadRevs() {
    try {
      const j = await api('GET', '/v1/admin/streaming/revocations?limit=200');
      const tbody = $('#rev-tbody');
      tbody.innerHTML = '';
      for (const r of j.items) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="muted">${fmtTime(r.created_at)}</td>
          <td class="pin-cell" style="font-size:13px">${r.pin || '—'}</td>
          <td>${r.device_label || '—'}<div class="muted" style="font-size:11px">${r.session_id ? r.session_id.slice(0,12)+'…' : ''}</div></td>
          <td class="mono">${r.ip || '—'}</td>
          <td><span class="badge">${r.reason || '?'}</span></td>
          <td class="muted">${r.actor || '—'}</td>`;
        tbody.appendChild(tr);
      }
    } catch (e) { alert('Load failed: ' + e.message); }
  }
  $('#btn-reloadrev').addEventListener('click', loadRevs);

  async function loadEdge() {
    try {
      const j = await api('GET', '/v1/admin/streaming/edge-config');
      $('#edge-nginx').textContent = j.nginxSecureLink;
      $('#edge-bunny').textContent = j.bunnyTokenAuth;
      const tbody = $('#env-grid tbody');
      tbody.innerHTML = '';
      for (const e of j.envRequirements) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td class="mono">${e.name}</td><td>${e.required ? '<b class="ok">yes</b>' : 'optional'}</td><td class="muted">${e.purpose}</td>`;
        tbody.appendChild(tr);
      }
      const ul = $('#edge-ttls');
      ul.innerHTML = '';
      for (const [k, v] of Object.entries(j.ttlSeconds)) {
        const li = document.createElement('li');
        li.textContent = `${k}: ${v}s`;
        ul.appendChild(li);
      }
    } catch (e) { alert('Load failed: ' + e.message); }
  }

  if (S.token) afterAuth();
})();
