// Auto-detect mode: on :6780 talk to the split admin API on :6779; otherwise same-origin /api.
const host  = location.hostname;
const proto = location.protocol;
const multiPort = location.port === '6780';
const API = multiPort ? `${proto}//${host}:6779` : `${proto}//${location.host}/api`;

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const statsEl = $('stats');

function log(...args) {
  const t = new Date().toISOString().split('T')[1].replace('Z','');
  logEl.textContent = `[${t}] ${args.join(' ')}\n` + logEl.textContent;
}

const tokenInput = $('token');
tokenInput.value = localStorage.getItem('adminToken') || '';
$('tokenState').textContent = tokenInput.value ? 'loaded from storage' : 'not set';

$('save').onclick = () => {
  localStorage.setItem('adminToken', tokenInput.value.trim());
  $('tokenState').textContent = 'saved';
  refresh();
};

function auth() {
  const t = tokenInput.value.trim();
  return t ? { 'Authorization': `Bearer ${t}` } : {};
}

async function refresh() {
  try {
    const r = await fetch(`${API}/stats`, { headers: auth() });
    const j = await r.json();
    statsEl.textContent = JSON.stringify(j, null, 2);
  } catch (e) { statsEl.textContent = 'error: ' + e.message; }
}
$('refresh').onclick = refresh;

$('trigger').onclick = async () => {
  const adUrl = $('adUrl').value.trim();
  const duration = Number($('duration').value) || 15;
  if (!adUrl) return log('adUrl required');
  try {
    const r = await fetch(`${API}/trigger-ad`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth() },
      body: JSON.stringify({ adUrl, duration }),
    });
    log('trigger →', JSON.stringify(await r.json()));
  } catch (e) { log('trigger error', e.message); }
};

$('resume').onclick = async () => {
  try {
    const r = await fetch(`${API}/resume-live`, { method: 'POST', headers: auth() });
    log('resume →', JSON.stringify(await r.json()));
  } catch (e) { log('resume error', e.message); }
};

refresh();
setInterval(refresh, 5000);
