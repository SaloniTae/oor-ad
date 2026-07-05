/* eslint-env browser */
/**
 * Streaming Security admin panel — single-page vanilla JS.
 *
 * AUTH: this page reuses the existing admin app's session token
 * (localStorage 'ai.session'). If the user is already logged in to /admin/,
 * this page auto-authenticates. Falls back to its own sign-in form only
 * when no existing session is found. Also supports raw API keys.
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---- Theme (shared with main admin via localStorage 'ai.theme') ----------
  // Resolve 'auto' to an explicit data-theme so CSS only keys off
  // [data-theme="light"] / [data-theme="dark"] (no fighting media queries).
  const K_THEME = 'ai.theme';
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
  function currentTheme() { return localStorage.getItem(K_THEME) || 'auto'; }
  function effective(t) { return t === 'auto' ? (prefersLight && prefersLight.matches ? 'light' : 'dark') : t; }
  function applyTheme(t) { document.documentElement.setAttribute('data-theme', effective(t)); }
  function themeIcon(t) { return t === 'light' ? '☀️' : t === 'dark' ? '🌙' : '🌗'; }
  function cycleTheme() {
    const order = ['auto', 'dark', 'light'];
    const next = order[(order.indexOf(currentTheme()) + 1) % order.length];
    localStorage.setItem(K_THEME, next);
    applyTheme(next);
    const btn = $('#btn-theme');
    if (btn) btn.textContent = themeIcon(next);
  }
  applyTheme(currentTheme());
  if (prefersLight && prefersLight.addEventListener) {
    prefersLight.addEventListener('change', () => { if (currentTheme() === 'auto') applyTheme('auto'); });
  }
  window.addEventListener('DOMContentLoaded', () => {
    const btn = $('#btn-theme');
    if (btn) { btn.textContent = themeIcon(currentTheme()); btn.addEventListener('click', cycleTheme); }
  });

  // Storage keys — piggyback on the main admin so a single login covers both.
  const K_SESSION = 'ai.session';        // set by /admin/ main app
  const K_TENANT  = 'ai.tenant';         // JSON tenant record
  const K_APIKEY  = 'secstream.apikey';  // fallback for API-key auth

  const S = {
    get token() {
      return localStorage.getItem(K_SESSION) || localStorage.getItem(K_APIKEY) || '';
    },
    setSession(t, tenant) {
      localStorage.setItem(K_SESSION, t);
      if (tenant) localStorage.setItem(K_TENANT, JSON.stringify(tenant));
      localStorage.removeItem(K_APIKEY);
    },
    setKey(k) {
      localStorage.setItem(K_APIKEY, k);
    },
    clear() {
      localStorage.removeItem(K_SESSION);
      localStorage.removeItem(K_TENANT);
      localStorage.removeItem(K_APIKEY);
    },
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
    return new Date(ms).toLocaleString();
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
    // Main admin app expects { session, tenant } — we accept either shape.
    S.setSession(j.session || j.token, j.tenant);
  }

  async function afterAuth() {
    try {
      await api('GET', '/v1/admin/streaming/pins');
      $('#signin').hidden = true;
      $('#auth-label').textContent = 'authenticated';
      $('#btn-signout').hidden = false;
      switchTab('pins');
    } catch (e) {
      // Only clear if the token is actually invalid, not on network hiccups.
      if (e.status === 401) S.clear();
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
  $('#btn-signout').addEventListener('click', () => { S.clear(); location.href = '/admin/'; });

  const tabs = ['pins', 'sessions', 'revocations', 'channels', 'edge'];
  function switchTab(name) {
    for (const t of tabs) {
      const panel = $(`#tab-${t}`);
      if (panel) panel.hidden = t !== name;
      const btn = document.querySelector(`.tab[data-tab="${t}"]`);
      if (btn) btn.classList.toggle('active', t === name);
    }
    if (name === 'pins')        loadPins();
    if (name === 'revocations') loadRevs();
    if (name === 'channels')    loadChannels();
    if (name === 'edge')        loadEdge();
  }
  $$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // ---- PINs ---------------------------------------------------------------

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
          } catch (e) { alert('Update failed: ' + e.message); }
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

  // Populate channel dropdown in the create-PIN modal from the main app's channels API.
  async function loadChannelDropdown(selectEl) {
    try {
      const j = await api('GET', '/v1/channels');
      selectEl.innerHTML = '<option value="">— any channel (unrestricted) —</option>';
      const items = j.items || j || [];
      for (const c of items) {
        const opt = document.createElement('option');
        opt.value = c.slug;
        opt.textContent = `${c.name || c.slug} (${c.slug})`;
        selectEl.appendChild(opt);
      }
    } catch {
      // Fall back to plain text input if we can't fetch — keeps the modal usable.
    }
  }

  function openModal(id)  { const m = $(id); m.hidden = false; m.classList.add('open'); }
  function closeModal(id)  { const m = $(id); m.classList.remove('open'); m.hidden = true; }

  $('#btn-newpin').addEventListener('click', () => {
    loadChannelDropdown($('#np-slug'));
    $('#np-err').textContent = '';
    openModal('#modal-newpin');
  });
  $('#np-cancel').addEventListener('click', () => closeModal('#modal-newpin'));
  // Click the backdrop (outside the card) to dismiss.
  $('#modal-newpin').addEventListener('click', (e) => { if (e.target.id === 'modal-newpin') closeModal('#modal-newpin'); });
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
      closeModal('#modal-newpin');
      alert(`PIN created: ${j.pin}\n\nGive this to the viewer. It's shown once.`);
      loadPins();
    } catch (e) { $('#np-err').textContent = e.message; }
  });

  // ---- Sessions -----------------------------------------------------------

  let sessTimer = null;
  async function loadSessions() {
    const pin = $('#sess-pin').value.trim();
    if (!pin) return;
    try {
      const j = await api('GET', `/v1/admin/streaming/pins/${pin}/sessions`);
      const tbody = $('#sess-tbody');
      tbody.innerHTML = '';
      if (!j.items.length) { $('#sess-empty').hidden = false; $('#sess-empty').textContent = 'No active sessions.'; return; }
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

  // ---- Revocations --------------------------------------------------------

  async function loadRevs() {
    try {
      const j = await api('GET', '/v1/admin/streaming/revocations?limit=200');
      const tbody = $('#rev-tbody');
      tbody.innerHTML = '';
      if (!j.items.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="6" class="muted" style="text-align:center;padding:20px">No revocations yet.</td>';
        tbody.appendChild(tr);
        return;
      }
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

  // ---- Channels + origin --------------------------------------------------

  const ORIGIN_HELP = {
    direct: 'App proxies the manifest and signs every URI with our HMAC. Zero setup, works for any HLS origin. Best for getting started.',
    bunny:  'Bunny.net Pull Zone with Token Authentication. Requires BUNNY_SECURITY_KEY env var. Zero bandwidth cost on your origin — Bunny validates at their edge.',
    nginx:  'Self-hosted nginx with secure_link module. Requires NGINX_SECURE_LINK_SECRET env var. Zero bandwidth cost on your app — nginx validates at your VPS edge.',
  };

  async function loadChannels() {
    try {
      const j = await api('GET', '/v1/channels');
      const items = j.items || j || [];
      const tbody = $('#chan-tbody');
      tbody.innerHTML = '';
      if (!items.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="4" class="muted" style="text-align:center;padding:20px">No channels yet. Create one in the main admin first.</td>';
        tbody.appendChild(tr);
        return;
      }
      for (const c of items) {
        let origin = { origin_type: 'direct', origin_base: null };
        try { origin = await api('GET', `/v1/admin/streaming/channels/${c.id}/origin`); } catch {}
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><b>${c.name || c.slug}</b><div class="muted" style="font-size:11px">${c.slug}</div></td>
          <td class="mono" style="font-size:11px">${c.live_url ? c.live_url.slice(0,60)+'…' : '—'}</td>
          <td>
            <select class="origin-sel" data-cid="${c.id}">
              <option value="direct" ${origin.origin_type==='direct'?'selected':''}>Direct (app-proxied)</option>
              <option value="bunny"  ${origin.origin_type==='bunny' ?'selected':''}>Bunny.net</option>
              <option value="nginx"  ${origin.origin_type==='nginx' ?'selected':''}>My VPS (nginx)</option>
            </select>
            <input class="origin-base" data-cid="${c.id}" placeholder="Origin URL (blank = use live_url)" value="${origin.origin_base || ''}" style="width:100%;margin-top:4px">
          </td>
          <td><button class="small" data-save-origin="${c.id}">Save</button></td>`;
        tbody.appendChild(tr);
      }
      tbody.querySelectorAll('.origin-sel').forEach((sel) => {
        sel.addEventListener('change', () => {
          $('#chan-help').textContent = ORIGIN_HELP[sel.value] || '';
        });
      });
      tbody.querySelectorAll('[data-save-origin]').forEach((b) => b.addEventListener('click', async () => {
        const cid = b.dataset.saveOrigin;
        const type = tbody.querySelector(`.origin-sel[data-cid="${cid}"]`).value;
        const base = tbody.querySelector(`.origin-base[data-cid="${cid}"]`).value.trim() || null;
        try {
          await api('PUT', `/v1/admin/streaming/channels/${cid}/origin`, { originType: type, originBase: base });
          b.textContent = 'Saved ✓';
          b.style.background = 'var(--ok)';
          setTimeout(() => { b.textContent = 'Save'; b.style.background = ''; }, 1200);
        } catch (e) { alert('Save failed: ' + e.message); }
      }));
    } catch (e) { alert('Load failed: ' + e.message); }
  }

  // ---- Edge config --------------------------------------------------------

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

  // ---- boot ---------------------------------------------------------------

  if (S.token) {
    afterAuth();
  } else {
    $('#signin').hidden = false;
  }
})();
