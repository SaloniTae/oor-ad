/* Ad Injection admin dashboard - a small hand-rolled SPA that speaks the same API
   your customers will use. No frameworks; every fetch is annotated so you can
   read it as documentation. */
(() => {
const app = document.getElementById('app');
const state = {
  session: localStorage.getItem('ai.session') || '',
  tenant:  JSON.parse(localStorage.getItem('ai.tenant') || 'null'),
};

// ---- api helper ------------------------------------------------------------
async function api(method, path, body, { multipart = false, asBlob = false } = {}) {
  const opts = { method, headers: {} };
  if (state.session) opts.headers['Authorization'] = 'Bearer ' + state.session;
  if (body != null) {
    if (multipart) { opts.body = body; }
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  const r = await fetch(path, opts);
  if (asBlob) return r.blob();
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text }; }
  if (!r.ok) { const e = new Error(j?.error?.message || r.statusText); e.status = r.status; e.body = j; throw e; }
  return j;
}
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v != null && v !== false) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) el.append(kid?.nodeType ? kid : document.createTextNode(kid ?? ''));
  return el;
};
const clone = (id) => document.getElementById(id).content.cloneNode(true);
const copy = (t) => navigator.clipboard.writeText(t);

// ---- routing ---------------------------------------------------------------
function render() {
  app.innerHTML = '';
  if (!state.session) return renderAuth();
  renderDash();
}

// ---- auth screens ----------------------------------------------------------
function renderAuth() {
  const n = clone('tpl-auth');
  const root = n.firstElementChild;
  const err = () => root.querySelector('[data-err]');
  const show = (v) => {
    root.querySelectorAll('[data-view]').forEach(s => s.classList.toggle('hidden', s.dataset.view !== v));
    root.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === v));
  };
  root.querySelectorAll('.tabs button').forEach(b => b.onclick = () => show(b.dataset.tab));
  root.querySelector('[data-act=login]').onclick = async () => {
    err().textContent = '';
    const email = root.querySelector('[data-view=login] [name=email]').value.trim();
    const password = root.querySelector('[data-view=login] [name=password]').value;
    try {
      const r = await api('POST', '/v1/auth/login', { email, password });
      setSession(r.session, r.tenant);
    } catch (e) { err().textContent = e.message; }
  };
  root.querySelector('[data-act=register]').onclick = async () => {
    err().textContent = '';
    const name = root.querySelector('[data-view=register] [name=name]').value.trim();
    const email = root.querySelector('[data-view=register] [name=email]').value.trim();
    const password = root.querySelector('[data-view=register] [name=password]').value;
    try {
      const r = await api('POST', '/v1/auth/register', { name, email, password });
      setSession(r.session, r.tenant);
    } catch (e) { err().textContent = e.message; }
  };
  app.append(n);
}

function setSession(session, tenant) {
  state.session = session; state.tenant = tenant;
  localStorage.setItem('ai.session', session);
  localStorage.setItem('ai.tenant',  JSON.stringify(tenant));
  render();
}
function logout() {
  state.session = ''; state.tenant = null;
  localStorage.removeItem('ai.session'); localStorage.removeItem('ai.tenant');
  render();
}
function isAdmin() { return state.tenant?.plan === 'admin'; }

// ---- dashboard shell -------------------------------------------------------
function renderDash() {
  const n = clone('tpl-dash');
  app.append(n);
  document.querySelector('[data-who]').textContent =
    (state.tenant?.email || '') + (isAdmin() ? ' · ADMIN' : '');
  document.querySelector('[data-act=logout]').onclick = logout;
  // Show/hide admin-only nav
  document.querySelectorAll('.top nav a[data-admin]').forEach(a => a.classList.toggle('hidden', !isAdmin()));
  document.querySelectorAll('.top nav a[data-nav]').forEach(a => a.onclick = () => nav(a.dataset.nav));
  nav('overview');
}
function nav(name) {
  document.querySelectorAll('.top nav a[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === name));
  const view = document.getElementById('view');
  view.innerHTML = '';
  const fn = views[name];
  if (fn) fn(view).catch(e => view.append(h('div', { class: 'err' }, e.message)));
}

// ---- views -----------------------------------------------------------------
const views = {};

views.overview = async (view) => {
  const r = await api('GET', '/v1/analytics/overview');
  view.append(h('div', { class: 'wrap' },
    h('h1', {}, 'Overview'),
    h('div', { class: 'grid' },
      stat('Channels', r.channels),
      stat('Ads', r.ads),
      stat('Active viewers (now)', r.active_viewers),
      stat('Triggers (24h)', r.triggers_24h),
      stat('Impressions (24h)', r.impressions_24h),
    ),
    h('div', { class: 'card', style: 'margin-top:20px' },
      h('h2', {}, 'Quick start'),
      h('div', { class: 'muted', style: 'line-height:1.6' },
        '1. Create a ', h('b', {}, 'Channel'), ' with your live HLS URL. ',
        '2. Add ', h('b', {}, 'Ads'), ' (upload a video/image or paste a URL). ',
        '3. Issue a viewer token → give it to your player. ',
        '4. Trigger an ad from the channel page or via API.',
      ),
    ),
  ));
};
function stat(l, n) { return h('div', { class: 'stat' }, h('div', { class: 'l' }, l), h('div', { class: 'n' }, String(n ?? '-'))); }

views.channels = async (view) => {
  const { channels } = await api('GET', '/v1/channels');
  const wrap = h('div', { class: 'wrap' });
  wrap.append(h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:14px' },
    h('h1', {}, 'Channels'),
    h('button', { class: 'primary', onclick: () => openChannelForm(view) }, '+ New channel'),
  ));
  if (!channels.length) wrap.append(h('div', { class: 'card muted' }, 'No channels yet.'));
  else wrap.append(h('div', { class: 'grid' }, ...channels.map(c => channelCard(c, view))));
  view.append(wrap);
};

function channelCard(c, view) {
  return h('div', { class: 'card' },
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('h2', {}, c.name),
      h('span', { class: 'badge' }, c.slug),
    ),
    h('div', { class: 'muted', style: 'font-size:12px;margin:8px 0;word-break:break-all' }, c.live_url),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { onclick: () => openChannel(c, view) }, 'Manage'),
      h('button', { class: 'small', onclick: () => openViewer(c) }, 'Open player'),
    ),
  );
}

async function openChannelForm(view, existing) {
  view.innerHTML = '';
  const wrap = h('div', { class: 'wrap narrow' });
  const err = h('div', { class: 'err' });
  const f = {
    slug: h('input', { value: existing?.slug || '' }),
    name: h('input', { value: existing?.name || '' }),
    live_url: h('input', { value: existing?.live_url || 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' }),
  };
  const save = h('button', { class: 'primary', onclick: async () => {
    err.textContent = '';
    try {
      const body = { slug: f.slug.value.trim(), name: f.name.value.trim(), live_url: f.live_url.value.trim() };
      if (existing) await api('PATCH', `/v1/channels/${existing.id}`, body);
      else await api('POST', '/v1/channels', body);
      nav('channels');
    } catch (e) { err.textContent = e.message; }
  }}, existing ? 'Save' : 'Create channel');
  wrap.append(
    h('h1', {}, existing ? 'Edit channel' : 'New channel'),
    h('div', { class: 'card' },
      label('Slug (URL-safe)'), f.slug,
      label('Name'), f.name,
      label('Live HLS URL'), f.live_url,
      save, err,
    ),
    h('button', { class: 'link', onclick: () => nav('channels') }, '← back'),
  );
  view.append(wrap);
}

async function openChannel(c, view) {
  view.innerHTML = '';
  const [full, adsRes, triggers] = await Promise.all([
    api('GET', `/v1/channels/${c.id}`),
    api('GET', '/v1/ads'),
    api('GET', `/v1/channels/${c.id}/triggers?limit=20`),
  ]);
  const ch = full.channel;
  const wrap = h('div', { class: 'wrap' });

  const triggerErr = h('div', { class: 'err' });
  const adSelect = h('select', {},
    ...(adsRes.ads.length ? adsRes.ads.map(a => h('option', { value: a.id }, `${a.name} · ${a.type} · ${a.duration_seconds}s`))
                          : [h('option', { value: '' }, 'No ads yet — create one in Ad Library')])
  );
  const dur = h('input', { type: 'number', value: '', placeholder: 'override (optional)', min: 1, max: 600 });
  const doTrigger = h('button', { class: 'primary', onclick: async () => {
    triggerErr.textContent = '';
    try {
      const body = { ad_id: adSelect.value };
      const v = Number(dur.value); if (v) body.duration_seconds = v;
      const r = await api('POST', `/v1/channels/${ch.id}/trigger`, body);
      triggerErr.textContent = `Triggered ✓ delivered to ${r.delivered} viewer(s)`;
      triggerErr.className = 'ok';
      setTimeout(() => nav('channels'), 400) && openChannel(c, document.getElementById('view'));
    } catch (e) { triggerErr.className = 'err'; triggerErr.textContent = e.message; }
  }}, '▶ Trigger ad');
  const doResume = h('button', { onclick: async () => {
    try { await api('POST', `/v1/channels/${ch.id}/resume`); triggerErr.className='ok'; triggerErr.textContent='Resumed live ✓'; } catch(e){triggerErr.className='err';triggerErr.textContent=e.message;}
  }}, '■ Resume live');

  wrap.append(
    h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:14px' },
      h('h1', {}, ch.name),
      h('div', { class: 'row' },
        h('button', { class: 'edit', onclick: () => openChannelForm(view, ch) }, 'Edit'),
        h('button', { class: 'danger', onclick: async () => {
          if (!confirm('Delete channel?')) return;
          await api('DELETE', `/v1/channels/${ch.id}`); nav('channels');
        }}, 'Delete'),
      ),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'kv' },
        h('b', {}, 'Slug'),      h('span', {}, ch.slug),
        h('b', {}, 'Live URL'),  h('span', { style: 'word-break:break-all' }, ch.live_url),
        h('b', {}, 'State'),     h('span', {}, JSON.stringify(full.state)),
        h('b', {}, 'Viewers'),   h('span', {}, String(full.viewers)),
      ),
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('button', { onclick: async () => {
          const r = await api('POST', `/v1/channels/${ch.id}/viewer-token`, {});
          const url = `${location.origin}/player/?ws=${encodeURIComponent(r.ws_url)}`;
          prompt('Viewer URL (share or embed):', url);
        }}, 'Get viewer URL'),
        h('button', { onclick: () => openViewer(ch) }, 'Open player'),
      ),
    ),
    h('div', { class: 'card' },
      h('h2', {}, 'Trigger an ad'),
      label('Ad'), adSelect,
      label('Duration override (seconds, optional)'), dur,
      h('div', { class: 'row', style: 'margin-top:12px' }, doTrigger, doResume),
      triggerErr,
    ),
    h('div', { class: 'card' },
      h('h2', {}, 'Recent triggers'),
      triggers.triggers.length
        ? tbl(['When','Ad','Duration','Status'], triggers.triggers.map(t => [
            new Date(t.start_at).toLocaleString(),
            t.ad_id,
            t.duration_seconds + 's',
            t.status,
          ]))
        : h('div', { class: 'muted' }, 'No triggers yet.'),
    ),
    h('button', { class: 'link', onclick: () => nav('channels') }, '← all channels'),
  );
  view.append(wrap);
}

async function previewAd(ad) {
  const { url, type } = await api('GET', `/v1/ads/${ad.id}/signed-url`);
  const el = type === 'image'
    ? h('img', { class: 'preview', src: url, alt: ad.name })
    : h('video', { class: 'preview', src: url, controls: true, autoplay: true, playsinline: true });
  modal(
    h('h2', {}, ad.name),
    h('div', { class: 'muted' }, `${type} · ${ad.duration_seconds}s`),
    el,
    h('div', { class: 'muted', style: 'font-size:11px;word-break:break-all' }, url),
  );
}

async function openViewer(c) {
  const r = await api('POST', `/v1/channels/${c.id}/viewer-token`, {});
  const url = `${location.origin}/player/?ws=${encodeURIComponent(r.ws_url)}`;
  const embed = `<iframe src="${url}" style="width:100%;aspect-ratio:16/9;border:0"></iframe>`;
  modal(
    h('h2', {}, `Player for "${c.name || c.slug}"`),
    h('p', { class: 'muted' }, 'Direct link:'),
    h('pre', {}, url),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => window.open(url, '_blank') }, 'Open now'),
      h('button', { onclick: () => copy(url) }, 'Copy link'),
    ),
    h('p', { class: 'muted', style: 'margin-top:16px' }, 'Embed on any page:'),
    h('pre', {}, embed),
    h('button', { onclick: () => copy(embed) }, 'Copy embed code'),
    h('p', { class: 'muted', style: 'margin-top:16px' }, 'Note: this is a demo viewer token that expires in 1 hour. In production, your backend calls POST /v1/channels/{id}/viewer-token per user to issue short-lived scoped tokens.'),
  );
}

views.ads = async (view) => {
  const { ads } = await api('GET', '/v1/ads');
  const wrap = h('div', { class: 'wrap' });
  wrap.append(h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:14px' },
    h('h1', {}, 'Ad Library'),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => openAdUpload(view) }, '⬆ Upload file'),
      h('button', { onclick: () => openAdUrl(view) }, '+ Add by URL'),
    ),
  ));
  wrap.append(ads.length ? tbl(['Name','Type','Duration','Source','Actions'], ads.map(a => [
    a.name,
    h('span',{class:'badge'}, a.type),
    a.duration_seconds + 's',
    a.is_upload ? h('span',{class:'muted'},'(uploaded file)') : h('span',{style:'word-break:break-all;font-size:12px'}, a.source),
    h('div', { class: 'row' },
      h('button', { class: 'small', onclick: () => previewAd(a) }, 'Preview'),
      h('button', { class: 'small edit', onclick: () => openAdEdit(document.getElementById('view'), a) }, 'Edit'),
      h('button', { class: 'small danger', onclick: async () => { if(confirm('Delete ad?')){await api('DELETE',`/v1/ads/${a.id}`);nav('ads');} } }, 'Delete'),
    ),
  ])) : h('div', { class: 'card muted' }, 'No ads yet.'));
  view.append(wrap);
};

function openAdUpload(view) {
  view.innerHTML = '';
  const err = h('div', { class: 'err' });
  const f = {
    name: h('input', { placeholder: 'Ad name' }),
    file: h('input', { type: 'file', accept: 'video/mp4,video/webm,video/quicktime,video/x-matroska,application/vnd.apple.mpegurl,application/x-mpegurl,image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,image/avif,image/bmp,video/*,image/*' }),
    duration: h('input', { type: 'number', value: 15, min: 1, max: 600 }),
    click_url: h('input', { placeholder: 'https://example.com (image ads)' }),
  };
  const submit = h('button', { class: 'primary', onclick: async () => {
    err.className = 'err'; err.textContent = '';
    const file = f.file.files[0];
    if (!file) { err.textContent = 'Choose a file'; return; }
    // Client sanity: warn early if the user picked something clearly unsupported.
    const looksOk = /^(image\/|video\/|application\/(vnd\.apple\.mpegurl|x-mpegurl))/i.test(file.type)
      || /\.(mp4|webm|mov|mkv|m3u8|png|jpe?g|webp|gif|heic|heif|avif|bmp)$/i.test(file.name);
    if (!looksOk) { err.textContent = `That file type (${file.type || 'unknown'}) isn't supported.`; return; }
    submit.disabled = true; submit.textContent = 'Uploading\u2026';
    const durNum = Number(f.duration.value);
    const durOk  = Number.isFinite(durNum) && durNum >= 1 ? durNum : 15;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('name', f.name.value || file.name);
    fd.append('duration_seconds', String(durOk));
    if (f.click_url.value) fd.append('click_url', f.click_url.value);
    try { await api('POST', '/v1/ads/upload', fd, { multipart: true }); nav('ads'); }
    catch (e) { err.textContent = e.message || 'Upload failed'; }
    finally { submit.disabled = false; submit.textContent = 'Upload'; }
  }}, 'Upload');
  view.append(h('div', { class: 'wrap narrow' },
    h('h1', {}, 'Upload ad'),
    h('div', { class: 'card' },
      label('Name'), f.name,
      label('File (mp4, webm, mov, m3u8, png, jpg, webp, gif, heic, avif)'), f.file,
      label('Duration (seconds)'), f.duration,
      label('Click-through URL (for image ads, optional)'), f.click_url,
      submit,
      err,
    ),
    h('button', { class: 'link', onclick: () => nav('ads') }, '← back'),
  ));
}

// Guess an ad's type from a URL. Extensions are the strongest hint;
// query strings are stripped before checking.
function detectAdTypeFromUrl(url) {
  const clean = String(url || '').split('?')[0].split('#')[0].toLowerCase();
  if (/\.m3u8$/.test(clean)) return 'hls';
  if (/\.(png|jpe?g|webp|gif|avif|heic|heif|bmp)$/.test(clean)) return 'image';
  if (/\.(mp4|webm|mov|mkv|m4v)$/.test(clean)) return 'video';
  if (/(image|photo|picture)/.test(clean)) return 'image';   // fallback heuristic
  return null;   // unknown -> let user pick
}

function openAdUrl(view) {
  view.innerHTML = '';
  const err = h('div', { class: 'err' });
  const detectedTag = h('span', { class: 'pill', style: 'margin-left:8px' }, '');
  const f = {
    name: h('input', { placeholder: 'Ad name' }),
    type: h('select', {}, h('option',{value:'hls'},'HLS (.m3u8)'), h('option',{value:'video'},'Video (mp4/webm)'), h('option',{value:'image'},'Image')),
    source: h('input', { placeholder: 'https://… (auto-detect from extension)' }),
    duration: h('input', { type: 'number', value: 15, min: 1, max: 600 }),
    click_url: h('input', { placeholder: 'https://example.com (optional)' }),
  };
  let userOverrodeType = false;
  f.type.addEventListener('change', () => { userOverrodeType = true; detectedTag.textContent = 'manual'; });
  f.source.addEventListener('input', () => {
    if (userOverrodeType) return;
    const guess = detectAdTypeFromUrl(f.source.value);
    if (guess) { f.type.value = guess; detectedTag.textContent = 'auto: ' + guess; }
    else       { detectedTag.textContent = ''; }
  });
  view.append(h('div', { class: 'wrap narrow' },
    h('h1', {}, 'Add ad by URL'),
    h('div', { class: 'card' },
      label('Name'), f.name,
      label('Source URL'), f.source,
      h('label', {}, 'Type ', detectedTag),
      f.type,
      label('Duration (seconds)'), f.duration,
      label('Click-through URL (optional)'), f.click_url,
      h('button', { class: 'primary', onclick: async () => {
        err.textContent = '';
        const body = {
          name: f.name.value.trim(), type: f.type.value, source: f.source.value.trim(),
          duration_seconds: Number(f.duration.value) || 15,
          metadata: f.click_url.value ? { click_url: f.click_url.value } : {},
        };
        try { await api('POST', '/v1/ads', body); nav('ads'); } catch (e) { err.textContent = e.message; }
      }}, 'Create'),
      err,
    ),
    h('button', { class: 'link', onclick: () => nav('ads') }, '← back'),
  ));
}


function openAdEdit(view, ad) {
  view.innerHTML = '';
  const err = h('div', { class: 'err' });
  const meta = ad.metadata || {};
  const isUrl = !ad.is_upload;
  const f = {
    name: h('input', { value: ad.name }),
    duration: h('input', { type: 'number', value: ad.duration_seconds, min: 1, max: 600 }),
    click_url: h('input', { value: meta.click_url || '', placeholder: 'https://example.com (image ads)' }),
    source: h('input', { value: ad.source, placeholder: 'https://…' }),
  };
  view.append(h('div', { class: 'wrap narrow' },
    h('h1', {}, 'Edit ad'),
    h('div', { class: 'card' },
      label('Name'), f.name,
      label('Duration (seconds)'), f.duration,
      isUrl ? label('Source URL') : null,
      isUrl ? f.source            : null,
      label('Click-through URL'), f.click_url,
      h('div', { class: 'muted', style: 'font-size:11px;margin-top:6px' }, isUrl ? 'URL-based ad. You can change the source.' : 'Uploaded file. Delete and re-upload to change bytes.'),
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('button', { class: 'primary', onclick: async () => {
          err.textContent = '';
          try {
            const body = {
              name: f.name.value.trim(),
              duration_seconds: Number(f.duration.value) || ad.duration_seconds,
              metadata: f.click_url.value ? { ...meta, click_url: f.click_url.value } : (function(){ const m = {...meta}; delete m.click_url; return m; })(),
            };
            if (isUrl && f.source.value.trim()) body.source = f.source.value.trim();
            await api('PATCH', `/v1/ads/${ad.id}`, body);
            nav('ads');
          } catch (e) { err.className = 'err'; err.textContent = e.message; }
        }}, 'Save'),
        h('button', { onclick: () => nav('ads') }, 'Cancel'),
      ),
      err,
    ),
  ));
}

views.keys = async (view) => {
  const { keys } = await api('GET', '/v1/auth/keys');
  const err = h('div', { class: 'err' });
  const wrap = h('div', { class: 'wrap' });
  const newKeyName = h('input', { placeholder: 'e.g. Production backend' });
  wrap.append(
    h('h1', {}, 'API Keys'),
    h('div', { class: 'card' },
      h('h2', {}, 'Create new key'),
      h('div', { class: 'muted', style: 'margin-bottom:8px' }, 'Keys are shown once — copy and store securely.'),
      label('Name'), newKeyName,
      h('button', { class: 'primary', onclick: async () => {
        err.textContent = '';
        try {
          const r = await api('POST', '/v1/auth/keys', { name: newKeyName.value || 'unnamed' });
          err.className = 'ok';
          err.innerHTML = '';
          err.append('Created. Copy now: ');
          const code = h('code', {}, r.key);
          const btn = h('button', { class: 'copy', onclick: () => copy(r.key) }, 'Copy');
          err.append(code, btn);
          setTimeout(() => nav('keys'), 8000);
        } catch (e) { err.className='err'; err.textContent = e.message; }
      }}, 'Create'),
      err,
    ),
    h('div', { class: 'card' },
      h('h2', {}, 'Your keys'),
      keys.length ? tbl(['Name','Prefix','Rate limit','Last used','Actions'], keys.map(k => [
        k.name,
        h('code',{}, `adi_${k.key_prefix}_…`),
        (k.rate_limit_rpm || 'default') + '/min',
        k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '—',
        h('button', { class: 'small danger', onclick: async () => { if(confirm('Revoke?')){await api('DELETE',`/v1/auth/keys/${k.id}`);nav('keys');} } }, 'Revoke'),
      ])) : h('div',{class:'muted'},'None.'),
    ),
  );
  view.append(wrap);
};

views.settings = async (view) => {
  const { tenant } = await api('GET', '/v1/auth/me');
  const err = h('div', { class: 'err' });
  const webhook = h('input', { value: tenant.webhook_url || '', placeholder: 'https://yourdomain.com/webhooks/ad-injection' });
  const cors = h('textarea', {}, (tenant.cors_origins||[]).join('\n'));
  view.append(h('div', { class: 'wrap' },
    h('h1', {}, 'Settings'),
    h('div', { class: 'card' },
      h('h2', {}, 'Webhook'),
      h('div', { class: 'muted' }, 'HTTPS URL to receive `ad.triggered`, `ad.completed`, `ad.resumed` events. Body is signed with `X-AdInjection-Signature: sha256=<hmac>` using your webhook secret.'),
      label('Webhook URL'), webhook,
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'primary', onclick: async () => {
          try { await api('PATCH', '/v1/auth/me', { webhook_url: webhook.value.trim() || null }); err.className='ok'; err.textContent='Saved.'; }
          catch (e) { err.className='err'; err.textContent = e.message; }
        }}, 'Save'),
        h('button', { onclick: async () => {
          try { const r = await api('POST', '/v1/webhooks/test'); err.className='ok'; err.textContent = 'Test event dispatched to ' + r.dispatched_to; }
          catch (e) { err.className='err'; err.textContent = e.message; }
        }}, 'Send test event'),
        h('button', { onclick: async () => {
          if (!confirm('Rotate secret? Existing signatures will stop verifying.')) return;
          const r = await api('POST', '/v1/auth/me/rotate-webhook-secret');
          modal(h('div', {},
            h('h2', {}, 'New webhook secret'),
            h('p', { class: 'muted' }, 'Store this now — it is only shown once. Use it to verify HMAC signatures on incoming webhook requests.'),
            h('pre', {}, r.webhook_secret),
            h('button', { class: 'primary', onclick: () => copy(r.webhook_secret) }, 'Copy'),
          ));
        }}, 'Rotate secret'),
      ),
    ),
    h('div', { class: 'card' },
      h('h2', {}, 'CORS origins'),
      h('div', { class: 'muted' }, 'One per line. Use `*` to allow any origin (not recommended for prod).'),
      label('Allowed origins'), cors,
      h('button', { class: 'primary', onclick: async () => {
        try { await api('PATCH', '/v1/auth/me', { cors_origins: cors.value.split('\n').map(s=>s.trim()).filter(Boolean) }); err.className='ok'; err.textContent='Saved.'; }
        catch (e) { err.className='err'; err.textContent = e.message; }
      }}, 'Save'),
      err,
    ),
  ));
};

// ---- events log ------------------------------------------------------------
views.events = async (view) => {
  const wrap = h('div', { class: 'wrap' });
  const list = h('div', { class: 'card', style: 'max-height:70vh;overflow:auto' }, h('div', { class: 'muted' }, 'Loading…'));
  wrap.append(h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:14px' },
    h('h1', {}, 'Events'),
    h('button', { onclick: () => views.events(view) }, 'Refresh'),
  ), list);
  view.append(wrap);
  const { events } = await api('GET', '/v1/analytics/events?limit=200');
  list.innerHTML = '';
  if (!events.length) list.append(h('div', { class: 'muted' }, 'No events yet.'));
  else events.forEach(e => list.append(h('div', { class: 'event-row' },
    h('span', { class: 't' }, new Date(e.created_at).toLocaleTimeString()),
    h('span', { class: 'n' }, e.event_type + (e.viewer_id ? ` · viewer=${e.viewer_id}` : '') + (e.ad_id ? ` · ad=${e.ad_id.slice(0,8)}` : '')),
    h('span', { class: 't' }, e.channel_id ? e.channel_id.slice(0, 8) : ''),
  )));
};

// ---- Platform admin --------------------------------------------------------
views.platform = async (view) => {
  if (!isAdmin()) { view.append(h('div', { class: 'wrap' }, h('div', { class: 'err' }, 'Platform-admin only.'))); return; }
  const [stats, tenants] = await Promise.all([
    api('GET', '/v1/admin/stats'),
    api('GET', '/v1/admin/tenants'),
  ]);
  const wrap = h('div', { class: 'wrap' });
  wrap.append(
    h('h1', {}, 'Platform Admin'),
    h('div', { class: 'grid' },
      stat('Tenants',    stats.totals.tenants),
      stat('Channels',   stats.totals.channels),
      stat('Ads',        stats.totals.ads),
      stat('Active keys',stats.totals.api_keys),
      stat('Viewers now',stats.active_viewers),
      stat('Triggers 24h', stats.triggers_24h),
      stat('Impressions 24h', stats.impressions_24h),
    ),
  );
  const search = h('input', { placeholder: 'Search by name/email', style: 'max-width:320px' });
  const rows = () => tbl(
    ['Name','Email','Plan','Status','Channels','Ads','Triggers 7d','Actions'],
    tenants.tenants.filter(t => !search.value || (t.name+t.email).toLowerCase().includes(search.value.toLowerCase())).map(t => [
      t.name,
      t.email,
      h('span', { class: 'pill ' + (t.plan === 'admin' ? 'admin' : '') }, t.plan),
      h('span', { class: 'pill ' + (t.disabled ? 'off' : 'on') }, t.disabled ? 'disabled' : 'active'),
      String(t.channels), String(t.ads), String(t.triggers_7d),
      h('div', { class: 'row' },
        h('button', { class: 'small', onclick: () => openTenant(view, t.id) }, 'Manage'),
        h('button', { class: 'small', onclick: () => impersonate(t.id) }, 'Impersonate'),
      ),
    ]),
  );
  const tblHolder = h('div', {});
  const rerender = () => { tblHolder.innerHTML = ''; tblHolder.append(rows()); };
  search.oninput = rerender;
  wrap.append(
    h('div', { class: 'card' },
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' },
        h('h2', {}, 'Tenants'), search,
      ),
      tblHolder,
    ),
  );
  view.append(wrap);
  rerender();
};

async function openTenant(view, id) {
  const r = await api('GET', `/v1/admin/tenants/${id}`);
  const t = r.tenant;
  const err = h('div', { class: 'err' });
  const planSel = h('select', {}, ...['free','pro','admin'].map(p => h('option', p === t.plan ? { value:p, selected:true } : { value:p }, p)));
  const disabledCb = h('input', { type:'checkbox', ...(t.disabled ? { checked:true } : {}) });
  view.innerHTML = '';
  view.append(h('div', { class: 'wrap' },
    h('button', { class: 'link', onclick: () => nav('platform') }, '← all tenants'),
    h('h1', {}, `Tenant: ${t.name}`),
    h('div', { class: 'kv card' },
      h('b', {}, 'ID'),         h('span', {}, t.id),
      h('b', {}, 'Email'),      h('span', {}, t.email),
      h('b', {}, 'Created'),    h('span', {}, new Date(t.created_at).toLocaleString()),
      h('b', {}, 'Webhook'),    h('span', {}, t.webhook_url || '—'),
      h('b', {}, 'CORS'),       h('span', {}, (t.cors_origins||[]).join(', ') || '—'),
      h('b', {}, 'Triggers 30d'),    h('span', {}, String(r.usage.triggers_30d)),
      h('b', {}, 'Impressions 30d'), h('span', {}, String(r.usage.impressions_30d)),
    ),
    h('div', { class: 'card' },
      h('h2', {}, 'Manage'),
      label('Plan'), planSel,
      h('label', { style: 'margin-top:14px' }, disabledCb, ' Disabled (blocks all API + login)'),
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('button', { class: 'primary', onclick: async () => {
          try { await api('PATCH', `/v1/admin/tenants/${t.id}`, { plan: planSel.value, disabled: disabledCb.checked }); err.className='ok'; err.textContent='Saved.'; }
          catch (e) { err.className='err'; err.textContent = e.message; }
        }}, 'Save'),
        h('button', { onclick: () => impersonate(t.id) }, 'Impersonate'),
        h('button', { class: 'danger', onclick: async () => {
          if (!confirm(`Permanently delete tenant "${t.name}" and ALL their data?`)) return;
          try { await api('DELETE', `/v1/admin/tenants/${t.id}`); nav('platform'); }
          catch (e) { err.className='err'; err.textContent = e.message; }
        }}, 'Delete tenant'),
      ),
      err,
    ),
    h('div', { class: 'card' },
      h('h2', {}, `Channels (${r.channels.length})`),
      r.channels.length ? tbl(['Slug','Name','Live URL'], r.channels.map(c => [c.slug, c.name, h('span', { style:'font-size:11px;word-break:break-all' }, c.live_url)])) : h('div', { class: 'muted' }, 'None.'),
    ),
    h('div', { class: 'card' },
      h('h2', {}, `Ads (${r.ads.length})`),
      r.ads.length ? tbl(['Name','Type','Duration'], r.ads.map(a => [a.name, h('span',{class:'badge'},a.type), a.duration_seconds+'s'])) : h('div', { class: 'muted' }, 'None.'),
    ),
    h('div', { class: 'card' },
      h('h2', {}, `API Keys (${r.keys.length})`),
      r.keys.length ? tbl(['Name','Prefix','Status','Last used'], r.keys.map(k => [k.name, h('code',{},`adi_${k.key_prefix}_…`), h('span',{class:'pill '+(k.disabled?'off':'on')}, k.disabled?'off':'on'), k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '—'])) : h('div', { class: 'muted' }, 'None.'),
    ),
  ));
}

async function impersonate(tid) {
  if (!confirm('Impersonate this tenant? Your admin session will be replaced with a 30-min session for that tenant. Log out to return to your admin account.')) return;
  const r = await api('POST', `/v1/admin/tenants/${tid}/impersonate`, {});
  setSession(r.session, { id: r.tenant.id, email: r.tenant.email, name: r.tenant.name, plan: 'free' });
}

views.audit = async (view) => {
  if (!isAdmin()) { view.append(h('div', { class: 'wrap' }, h('div', { class: 'err' }, 'Platform-admin only.'))); return; }
  const { audit } = await api('GET', '/v1/admin/audit?limit=300');
  view.append(h('div', { class: 'wrap' },
    h('h1', {}, 'Audit log'),
    audit.length ? tbl(['When','Tenant','Actor','Action','Resource','IP','Metadata'], audit.map(a => [
      new Date(a.created_at).toLocaleString(),
      a.tenant_id || '—',
      a.actor,
      h('code', {}, a.action),
      a.resource || '—',
      a.ip || '—',
      a.metadata ? h('code', { style: 'font-size:11px' }, JSON.stringify(a.metadata)) : '—',
    ])) : h('div', { class: 'card muted' }, 'No entries.'),
  ));
};

// ---- Modal helper ----------------------------------------------------------
function modal(...content) {
  const bd = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === bd) bd.remove(); } },
    h('div', { class: 'modal' }, ...content,
      h('div', { style: 'text-align:right;margin-top:16px' },
        h('button', { onclick: () => bd.remove() }, 'Close'),
      ),
    ),
  );
  document.body.append(bd);
}

// ---- helpers ---------------------------------------------------------------
function label(t) { return h('label', {}, t); }
function tbl(headers, rows) {
  const th = h('tr', {}, ...headers.map(x => h('th', {}, x)));
  const trs = rows.map(r => h('tr', {}, ...r.map(c => h('td', {}, c))));
  return h('div', { class: 'card', style: 'overflow:auto' }, h('table', {}, h('thead', {}, th), h('tbody', {}, ...trs)));
}

render();
})();
