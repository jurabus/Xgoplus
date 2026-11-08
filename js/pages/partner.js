import {
  sb, shell, S, h, $, clear, icon, errMsg, busy, toast, providerEmail, getContext, mediaUrl,
  uploadImage, pct, fmtDate, fmtDateTime, initialOf, logout, moduleOn, limitsEditor, passwordForm, rulesText, usageText, platform, brandLogo,
} from '../common.js';

const app = $('#app');
let ctx;

// ---------------- login ----------------
function loginView() {
  const user = h('input', { class: 'input', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: 30, required: true });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', maxlength: 72, required: true });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const btn = h('button', { class: 'btn block', type: 'submit', text: S('login_button') });
  const form = h('form', { class: 'card stack', novalidate: true },
    h('label', { class: 'field' }, h('span', { text: S('username_label') }), user),
    h('label', { class: 'field' }, h('span', { text: S('password_label') }), pass), err, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const u = user.value.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,30}$/.test(u) || !pass.value) { err.textContent = 'Enter your username and password.'; return; }
    busy(btn, true);
    const { error } = await sb.auth.signInWithPassword({ email: providerEmail(u), password: pass.value });
    if (error) { busy(btn, false); err.textContent = /Invalid login/i.test(error.message) ? 'Wrong username or password.' : errMsg(error); return; }
    const c = await getContext(true);
    if (c.role !== 'provider') { await sb.auth.signOut(); busy(btn, false); err.textContent = 'This account is not an active partner.'; return; }
    location.replace('partner.html#scan');
    location.reload();
  });
  clear(app).append(h('div', { class: 'auth stack' }, h('div', { class: 'auth-hero' }, brandLogo()),
    h('h1', { text: S('partner_login_title') }), h('p', { class: 'muted', text: S('partner_login_subtitle') }), form,
    h('p', { class: 'center small' }, h('a', { href: 'login.html', text: 'Customer login' }))));
}

// ---------------- scanner ----------------
let stream = null, raf = 0;
function stopCamera() {
  cancelAnimationFrame(raf); raf = 0;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}
// Camera permission help per platform
function cameraHelp(err) {
  const plat = platform();
  const name = err?.name || '';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.';
  if (name === 'NotReadableError') return 'The camera is being used by another app. Close it and tap “Try again”.';
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return 'This browser cannot open the camera. Open the site in Safari (iPhone) or Chrome (Android).';
  if (plat === 'ios') return 'Camera access is blocked. In Safari tap “aA” in the address bar → Website Settings → Camera → Allow, then tap “Try again”. (Or iPhone Settings → Safari → Camera → Allow.)';
  if (plat === 'android') return 'Camera access is blocked. In Chrome tap the icon left of the address (⋮ or 🔒) → Permissions → Camera → Allow, then tap “Try again”.';
  return 'Camera access is blocked. Allow the camera for this site in your browser settings, then tap “Try again”.';
}

// Prefer the browser's native QR reader (Android Chrome) — fast and robust; fall back to jsQR (iPhone, others).
async function makeDecoder() {
  try {
    if ('BarcodeDetector' in window) {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const det = new window.BarcodeDetector({ formats: ['qr_code'] });
        return { kind: 'native', decode: async (src) => (await det.detect(src))[0]?.rawValue || null };
      }
    }
  } catch { /* fall back */ }
  const { jsQR } = await import('../vendor/qrscan.js');
  const c = document.createElement('canvas');
  const g = c.getContext('2d', { willReadFrequently: true });
  return {
    kind: 'jsqr',
    decode: async (video) => {
      const w = 480, hgt = Math.round((video.videoHeight / video.videoWidth) * w) || 640;
      c.width = w; c.height = hgt;
      g.drawImage(video, 0, 0, w, hgt);
      return jsQR(g.getImageData(0, 0, w, hgt).data, w, hgt, { inversionAttempts: 'attemptBoth' })?.data || null;
    },
  };
}

async function openCamera() {
  const tries = [
    { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
    { video: { facingMode: 'environment' }, audio: false },
    { video: true, audio: false },
  ];
  let lastErr;
  for (const c of tries) {
    try { return await navigator.mediaDevices.getUserMedia(c); } catch (e) {
      lastErr = e;
      if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') break; // permission problem: retrying won't help
    }
  }
  throw lastErr;
}

async function scanView() {
  stopCamera();
  const video = h('video', { playsinline: true, muted: true, autoplay: true });
  video.muted = true; video.setAttribute('webkit-playsinline', '');
  const msg = h('div', { class: 'msg', text: S('scan_hint') });
  const box = h('div', { class: 'scanner' }, video, h('div', { class: 'frame' }), msg);
  clear(app).append(h('h1', { text: S('scan_title') }), h('div', { id: 'scan-area' }, box));
  const decoderP = makeDecoder();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no-media');
    stream = await openCamera();
  } catch (e) {
    box.className = 'scanner err';
    clear(box).append(h('div', { class: 'msg stack' }, h('b', { text: S('scan_title') }), h('div', { text: cameraHelp(e) }),
      h('button', { class: 'btn block', type: 'button', text: 'Try again', onclick: () => scanView() })));
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  const decoder = await decoderP;
  box.dataset.decoder = decoder.kind;
  let last = 0, busyDecode = false;
  const tick = async (t) => {
    raf = requestAnimationFrame(tick);
    if (busyDecode || t - last < 120 || video.readyState < 2 || !video.videoWidth) return;
    last = t; busyDecode = true;
    try {
      const data = await decoder.decode(video);
      if (data && raf) { stopCamera(); verify(data); }
    } catch { /* keep scanning */ } finally { busyDecode = false; }
  };
  raf = requestAnimationFrame(tick);
}
const TOKEN_RE = /XG1\.[0-9a-f]{32}\.[0-9]{9,11}\.[0-9a-f]{32}/;
export function extractToken(data) { return (String(data || '').match(TOKEN_RE) || [null])[0]; }
function takePendingToken() {
  try {
    const p = JSON.parse(sessionStorage.getItem('xg-verify') || 'null');
    sessionStorage.removeItem('xg-verify');
    if (p && Date.now() - p.at < 175 * 1000) return extractToken(p.t);
  } catch { /* */ }
  return null;
}
function hasPendingToken() { try { return !!sessionStorage.getItem('xg-verify'); } catch { return false; } }

export async function verify(token) {
  clear(app).append(h('div', { class: 'spinner' }));
  const { data, error } = await sb.rpc('verify_member_qr', { p_token: extractToken(token) || String(token).slice(0, 200) });
  const again = h('button', { class: 'btn block', type: 'button', text: S('scan_again'), onclick: () => scanView() });
  if (error) { clear(app).append(h('div', { class: 'result warn' }, h('h2', { text: errMsg(error) })), h('div', { class: 'stack' }, again)); return; }
  let box;
  const usage = data.usage ? usageText(data.usage) : '';
  if (data.status === 'active') {
    box = h('div', { class: 'result ok' }, icon('check', 'icon'), h('h2', { text: S('scan_active') }),
      h('div', { text: S('scan_discount_label') }), h('div', { class: 'big', text: `${pct(data.discount_percent)}%` }),
      h('div', {}, h('b', { text: data.member_name })),
      data.trial ? h('div', { class: 'badge brand', text: S('scan_trial') }) : null,
      data.repeat ? h('div', { class: 'badge warn', text: S('scan_repeat') }) : null,
      data.expires_at && !data.trial ? h('div', { class: 'small', text: `${S('membership_valid_until')}: ${fmtDate(data.expires_at)}` }) : null,
      data.usage?.limit_count ? h('div', { class: 'small', text: usage }) : null,
      data.notes ? h('div', { class: 'notes small', text: data.notes }) : null);
  } else if (data.status === 'limit_reached' || data.status === 'not_today') {
    box = h('div', { class: 'result bad' }, icon('x', 'icon'),
      h('h2', { text: data.status === 'limit_reached' ? S('scan_limit_reached') : S('scan_not_today') }),
      h('div', {}, h('b', { text: data.member_name })),
      h('div', { class: 'small', text: rulesText(data.usage || {}).join(' · ') }),
      data.status === 'limit_reached' && usage ? h('div', { class: 'small', text: usage }) : null);
  } else if (data.status === 'trial_used') {
    box = h('div', { class: 'result bad' }, icon('x', 'icon'), h('h2', { text: S('scan_trial_used') }),
      h('div', {}, h('b', { text: data.member_name })));
  } else if (data.status === 'expired') {
    box = h('div', { class: 'result bad' }, icon('x', 'icon'), h('h2', { text: S('scan_expired') }),
      h('div', {}, h('b', { text: data.member_name })),
      data.expires_at ? h('div', { class: 'small', text: `${fmtDate(data.expires_at)}` }) : null);
  } else {
    box = h('div', { class: 'result warn' }, icon('x', 'icon'), h('h2', { text: data.status === 'stale' ? S('scan_stale') : S('scan_invalid') }));
  }
  clear(app).append(h('h1', { text: S('scan_title') }), box, h('div', { class: 'stack' }, h('div'), again));
}

// ---------------- profile ----------------
async function profileView() {
  stopCamera();
  clear(app).append(h('div', { class: 'spinner' }));
  const { data: lim } = await sb.from('providers').select('limit_count,limit_period,allowed_days').eq('id', ctx.provider.id).maybeSingle();
  const p = { ...ctx.provider, ...(lim || {}) };
  let imagePath = p.image_path;
  const preview = imagePath ? h('img', { class: 'preview', src: mediaUrl(imagePath), alt: '' }) : h('div', { class: 'preview thumb', text: initialOf(p.name) });
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const pick = h('button', { class: 'btn sm ghost', type: 'button', text: 'Change image', onclick: () => file.click() });
  const name = h('input', { class: 'input', value: p.name, maxlength: 80, required: true });

  const notes = h('textarea', { class: 'input', maxlength: 1000, rows: 4 }); notes.value = p.notes || '';
  const rules = rulesText(p);
  const save = h('button', { class: 'btn block', type: 'submit', text: 'Save' });
  file.addEventListener('change', async () => {
    const f = file.files[0]; if (!f) return;
    busy(pick, true, 'Uploading…');
    try {
      const path = await uploadImage(`providers/${p.id}`, f, 900);
      const { error } = await sb.from('providers').update({ image_path: path }).eq('id', p.id);
      if (error) throw error;
      const old = imagePath; imagePath = path;
      const img = h('img', { class: 'preview', src: mediaUrl(path), alt: '' });
      preview.replaceWith(img);
      if (old) sb.storage.from('media').remove([old]).catch(() => {});
      toast('Image updated');
      setTimeout(() => location.reload(), 600);
    } catch (e) { toast(errMsg(e), 'bad'); }
    busy(pick, false); file.value = '';
  });
  const form = h('form', { class: 'card stack' },
    h('div', { class: 'img-pick' }, preview, pick, file),
    h('label', { class: 'field' }, h('span', { text: 'Business name' }), name),
    h('div', { class: 'card-sub stack locked' },
      h('div', { class: 'row' }, h('b', { class: 'grow', text: 'Discount' }), h('span', { class: 'offpill sm', text: `${pct(p.discount_percent)}%` })),
      h('div', {}, h('b', { text: S('partner_limits_title') }),
        rules.length ? h('ul', { class: 'small' }, rules.map((r) => h('li', { text: r }))) : h('div', { class: 'small muted', text: 'No limits — valid every day.' })),
      h('div', { class: 'small muted', text: S('partner_discount_locked') })),
    h('label', { class: 'field' }, h('span', { text: S('provider_notes_title') }), notes, h('small', { class: 'muted', text: 'Extra info for customers.' })),
    save);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!name.value.trim()) { toast('Enter the business name.', 'bad'); return; }
    busy(save, true);
    const { error } = await sb.from('providers').update({ name: name.value.trim(), notes: notes.value.trim() }).eq('id', p.id);
    busy(save, false);
    if (error) { toast(errMsg(error), 'bad'); return; }
    toast('Saved');
    ctx = await getContext(true);
  });
  const out = h('button', { class: 'btn block danger', type: 'button', text: 'Log out', onclick: () => logout('partner.html') });
  clear(app).append(h('h1', { text: S('partner_profile_title') }),
    h('p', { class: 'muted small' }, 'Username: ', h('b', { text: p.username }), p.area_name ? [' · 📍 ', h('b', { text: p.area_name })] : null, ' · ', h('a', { href: `provider.html?id=${p.id}`, text: 'View public page' })),
    form, h('div', { class: 'stack' }, h('div'), passwordForm(), out));
}

// ---------------- history ----------------
async function historyView() {
  stopCamera();
  const list = h('div', { class: 'list' });
  const more = h('div', { class: 'more' });
  clear(app).append(h('h1', { text: S('partner_history_title') }), list, more);
  let offset = 0;
  const LABEL = { active: ['ok', S('membership_active_label')], expired: ['bad', S('membership_expired_label')], invalid: ['warn', S('scan_invalid')], stale: ['warn', S('scan_invalid')], limit_reached: ['bad', S('scan_limit_reached')], not_today: ['bad', S('scan_not_today')], trial_used: ['bad', S('scan_trial_used')] };
  async function load() {
    clear(more).append(h('div', { class: 'spinner' }));
    const { data, error } = await sb.from('scans').select('id,member_label,result,discount_percent,created_at')
      .order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + 29);
    clear(more);
    if (error) { more.append(h('p', { text: errMsg(error) })); return; }
    data.forEach((s) => {
      const [cls, label] = LABEL[s.result] || ['warn', s.result];
      list.append(h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, h('b', { text: s.member_label || '—' })), h('div', { class: 'small muted', text: fmtDateTime(s.created_at) })),
        s.discount_percent ? h('b', { text: `${pct(s.discount_percent)}%` }) : null,
        h('span', { class: `badge ${cls}`, text: label })));
    });
    offset += data.length;
    if (!offset) list.replaceWith(h('div', { class: 'empty', text: 'No scans yet.' }));
    if (data.length === 30) more.append(h('button', { class: 'btn ghost', type: 'button', text: 'Load more', onclick: load }));
  }
  load();
}

function route() {
  let r = (location.hash || '#scan').slice(1);
  if (r === 'scan' && !moduleOn('scanner')) r = moduleOn('provider-profile') ? 'profile' : 'history';
  if (r === 'profile' && !moduleOn('provider-profile')) r = 'history';
  document.querySelectorAll('.tabbar a, .topnav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `partner.html#${r}`));
  if (r === 'profile') profileView();
  else if (r === 'history') historyView();
  else scanView();
}

async function main() {
  ctx = await shell('scan', { searchBar: false });
  if (ctx.role !== 'provider') {
    if (ctx.role === 'customer') { clear(app).append(h('div', { class: 'card stack' }, h('p', { text: hasPendingToken() ? 'This is an XGo+ membership code. Only partner businesses can check it.' : 'You are logged in as a customer. Log out to sign in as a partner.' }), h('button', { class: 'btn', type: 'button', text: 'Log out', onclick: () => logout('partner.html') }))); return; }
    loginView();
    return;
  }
  addEventListener('hashchange', route);
  addEventListener('pagehide', stopCamera);
  const pending = takePendingToken();          // opened from the phone camera (v.html)
  if (pending) { history.replaceState(null, '', 'partner.html#scan'); verify(pending); return; }
  route();
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
