// Shared core for every page: Supabase client, auth/role, settings, UI kit.
import { createClient } from './vendor/supabase.js';
import { SUPABASE_URL, SUPABASE_KEY, LOGIN_DOMAIN } from './config.js';
import DEFAULTS from './defaults.js';

// ---------- anti-clickjacking (frame-ancestors can't be set via <meta>) ----------
if (window.top !== window.self) {
  document.documentElement.classList.add('framed');
  try { window.top.location = window.self.location.href; } catch { /* cross-origin: stay hidden */ }
  throw new Error('framed');
}

// Show/hide password eye on every password field, wherever it is rendered
const EYE = 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z';
const EYE_OFF = 'M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.3 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2';
function enhancePasswords(root) {
  (root.querySelectorAll ? root.querySelectorAll('input[type=password]:not([data-eye])') : []).forEach((inp) => {
    inp.dataset.eye = '1';
    const wrap = document.createElement('div'); wrap.className = 'pw-wrap';
    inp.replaceWith(wrap); wrap.appendChild(inp);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'pw-eye'; btn.setAttribute('aria-label', 'Show password');
    const draw = () => { btn.replaceChildren(svgPath(inp.type === 'password' ? EYE : EYE_OFF)); };
    btn.addEventListener('click', () => {
      inp.type = inp.type === 'password' ? 'text' : 'password';
      btn.setAttribute('aria-label', inp.type === 'password' ? 'Show password' : 'Hide password');
      draw(); inp.focus();
    });
    draw(); wrap.appendChild(btn);
  });
}
new MutationObserver((ms) => { for (const m of ms) m.addedNodes.forEach((n) => { if (n.nodeType === 1) enhancePasswords(n.matches?.('input[type=password]') ? n.parentNode || n : n); }); })
  .observe(document.documentElement, { childList: true, subtree: true });

// Never render "null"/"false" when a section is intentionally empty
const nativeAppend = Element.prototype.append;
Element.prototype.append = function append(...nodes) { return nativeAppend.apply(this, nodes.filter((n) => n != null && n !== false)); };

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'xg-auth', detectSessionInUrl: false },
});

// ---------- escaping + tiny DOM builder (never use innerHTML with data) ----------
export function esc(v) {
  return String(v ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
}
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'href' || k === 'src') el.setAttribute(k, safeUrl(v));
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
export function safeUrl(u) {
  const s = String(u ?? '');
  if (/^(https:\/\/|tel:\+?\d+$|mailto:[^\s]+$|\/(?!\/)|\.\/|[a-z0-9_-]+\.html|#|blob:|data:image\/)/i.test(s) || s === '') return s;
  return '#';
}
export const $ = (sel, root = document) => root.querySelector(sel);
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  card: 'M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zm0 4h20M6 15h4',
  user: 'M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm-8 9a8 8 0 0 1 16 0',
  scan: 'M3 7V4a1 1 0 0 1 1-1h3m10 0h3a1 1 0 0 1 1 1v3m0 10v3a1 1 0 0 1-1 1h-3M7 21H4a1 1 0 0 1-1-1v-3M7 12h10',
  store: 'M4 9h16l-1.5-5h-13zM5 9v11h14V9M9 20v-6h6v6',
  shield: 'M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.3-4.3',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12M18 6 6 18',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-15v5l3 2',
  login: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
  flag: 'M5 21V4m0 0h11l-2 4 2 4H5',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5m4-1v5l3 2',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  pin: 'M12 22s7-7.1 7-12.5A7 7 0 0 0 5 9.5C5 14.9 12 22 12 22zm0-9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  chev: 'M6 9l6 6 6-6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  back: 'M15 18l-6-6 6-6',
  fire: 'M12 22c4.4 0 7-2.9 7-6.6 0-3.6-2.4-5.4-3.6-8.4-.6 2-1.6 3.1-2.8 3.6.4-3.4-.9-6.6-3.6-8.6.3 3.3-1.5 5.6-3.1 7.6C4.6 11.3 5 13 5 15.4 5 19.1 7.6 22 12 22z',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  share: 'M12 3v12M8 7l4-4 4 4M5 12v8h14v-8',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-11v6m0-9h.01',
  tag: 'M3 12V3h9l9 9-9 9zM7.5 7.5h.01',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  wa: 'M4 20l1.3-4A8 8 0 1 1 8 18.7zM9 9c0 3 3 6 6 6l1-1.5-2-1-1 1c-1 0-2.5-1.5-2.5-2.5l1-1-1-2z',
};
// Category icon set (admin picks one; stored as "i:<key>" in categories.icon)
export const CAT_ICONS = {
  food: 'M7 3v18M4 3v5a3 3 0 0 0 6 0V3M17 21V3c-2.2 0-4 2.7-4 7s1.8 5 4 5',
  cafe: 'M4 9h13v4a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6zM17 10h1.5a2.5 2.5 0 0 1 0 5H17M8 3c0 1.5 1 1.5 1 3M12 3c0 1.5 1 1.5 1 3',
  doc: 'M6 3H5v5a5 5 0 0 0 10 0V3h-1M10 13v2a5 5 0 0 0 10 0v-3M20 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
  salon: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12',
  car: 'M5 17h14v-5l-2.2-5H7.2L5 12zM5 17v2.5M19 17v2.5M5 12h14M8 14.5h.01M16 14.5h.01',
  shop: 'M6 8h12l1 13H5zM9 8V7a3 3 0 0 1 6 0v1',
  gym: 'M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12',
  spa: 'M12 21c-4.5-1.5-8-5-8-9.5 3 0 6 1.5 8 4 2-2.5 5-4 8-4 0 4.5-3.5 8-8 9.5zM12 15.5c-1.3-3.5-1.3-7.5 0-11.5 1.3 4 1.3 8 0 11.5',
  pharm: 'M10.5 3.5a5 5 0 0 1 7 7l-7 7a5 5 0 0 1-7-7zM7 10l7 7',
  edu: 'M2 9l10-5 10 5-10 5zM6 11v5c3 2 9 2 12 0v-5M22 9v6',
  hotel: 'M3 20V5M3 13h18v7M21 13a4 4 0 0 0-4-4h-6v4M7 11a2 2 0 1 0 0-.01',
  pet: 'M8 13c2-2 6-2 8 0s2 6-4 6-6-4-4-6zM5 9a1.5 2 0 1 0 0-.01M9 5.5a1.5 2 0 1 0 0-.01M15 5.5a1.5 2 0 1 0 0-.01M19 9a1.5 2 0 1 0 0-.01',
  fun: 'M4 7h16v10H4zM8 12h.01M12 10v4M10 12h4M16 11h.01M17 13h.01',
  tech: 'M4 5h16v11H4zM2 19h20',
  more: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  pct: 'M12 2.5l2.3 1.7 2.9-.2.9 2.7 2.4 1.6-.9 2.7.9 2.7-2.4 1.6-.9 2.7-2.9-.2L12 21.5l-2.3-1.7-2.9.2-.9-2.7-2.4-1.6.9-2.7-.9-2.7 2.4-1.6.9-2.7 2.9.2zM9 15l6-6M9.5 9.5h.01M14.5 14.5h.01',
};
export function svgPath(d, cls = '', sw = '2') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', sw); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.append(p);
  return svg;
}
export function catIcon(iconValue, cls = 'cat-ic') {
  const v = String(iconValue || '');
  if (v.startsWith('i:') && CAT_ICONS[v.slice(2)]) return svgPath(CAT_ICONS[v.slice(2)], cls, '1.8');
  if (v) return h('span', { class: 'cat-emoji', text: v });
  return svgPath(CAT_ICONS.more, cls, '1.8');
}

// Brand wordmark (inline SVG so it uses the page font). Uploaded logo (settings.logo_path) wins.
let logoSeq = 0;
export function logoSVG() {
  const ns = 'http://www.w3.org/2000/svg';
  const id = `lg${++logoSeq}`;
  const el = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const svg = el('svg', { viewBox: '0 0 236 104', role: 'img', 'aria-label': 'XGo+' });
  const defs = el('defs', {});
  const g = el('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '1' });
  g.append(el('stop', { offset: '0', 'stop-color': '#5b25d9' }), el('stop', { offset: '1', 'stop-color': '#a04dff' }));
  defs.append(g); svg.append(defs);
  svg.append(el('path', { d: 'M30 88 C 4 74, 14 40, 70 30 C 104 24, 142 28, 150 36', fill: 'none', stroke: `url(#${id})`, 'stroke-width': '7', 'stroke-linecap': 'round' }));
  const t1 = el('text', { x: '16', y: '84', class: 'logo-xgo', fill: '#1d1452', 'font-family': 'Poppins, -apple-system, sans-serif', 'font-weight': '800', 'font-style': 'italic', 'font-size': '72', 'letter-spacing': '-5' });
  t1.textContent = 'XGo';
  // the "+" (rounded, slightly slanted like the italic text)
  // brand "+" is yellow everywhere (soft purple shadow keeps it readable on white)
  const PLUS = 'M188 40a7 7 0 0 1 14 0v14h14a7 7 0 0 1 0 14h-14v14a7 7 0 0 1-14 0V68h-14a7 7 0 0 1 0-14h14z';
  svg.append(t1,
    el('path', { d: PLUS, fill: '#3c1896', opacity: '.28', transform: 'skewX(-8) translate(12.5 3.5)' }),
    el('path', { d: PLUS, class: 'logo-plus', fill: '#ffc928', transform: 'skewX(-8) translate(10 0)' }));
  const pin = el('g', { transform: 'translate(176 -2) scale(1.15)' });
  pin.append(el('path', { d: 'M12 22s7-7.1 7-12.5A7 7 0 0 0 5 9.5C5 14.9 12 22 12 22z', fill: `url(#${id})` }), el('circle', { cx: '12', cy: '9.5', r: '2.8', fill: '#fff' }));
  svg.append(pin);
  return svg;
}
export function brandLogo() {
  const lp = S('logo_path');
  return lp ? h('img', { src: mediaUrl(lp), alt: S('site_title') }) : logoSVG();
}
export function icon(name, cls = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', ICONS[name] || ''); svg.append(p);
  return svg;
}

// ---------- settings ----------
const SETTINGS_KEY = 'xg-settings-v1';
let settings = { ...DEFAULTS };
export function S(key) {
  const v = settings[key];
  return v === undefined || v === null || v === '' ? DEFAULTS[key] ?? '' : v;
}
export function allSettings() { return settings; }
export async function loadSettings({ fresh = false } = {}) {
  try {
    const cached = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!fresh && cached && Date.now() - cached.t < 5 * 60 * 1000) {
      settings = { ...DEFAULTS, ...cached.d };
      return settings;
    }
  } catch { /* ignore */ }
  const { data, error } = await sb.from('settings').select('data').eq('id', 1).maybeSingle();
  if (!error && data) {
    settings = { ...DEFAULTS, ...(data.data || {}) };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ t: Date.now(), d: data.data || {} })); } catch { /* private mode */ }
  }
  return settings;
}
export function bustSettingsCache() { try { localStorage.removeItem(SETTINGS_KEY); } catch { /* */ } }

// ---------- auth / role ----------
let ctxPromise = null;
export function getContext(force = false) {
  if (!ctxPromise || force) {
    ctxPromise = (async () => {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return { role: 'guest' };
      const { data, error } = await sb.rpc('get_my_context');
      if (error) return { role: 'guest', error };
      return data;
    })();
  }
  return ctxPromise;
}
// This customer account was opened on another device: sign out here.
export async function sessionRevoked() {
  await sb.auth.signOut({ scope: 'local' }).catch(() => {});
  ctxPromise = null;
  location.replace('login.html?revoked=1');
}
// Call right after a customer logs in / signs up: makes this the only active session.
export async function claimSession() {
  const { error } = await sb.rpc('claim_session');
  if (error) console.warn('claim_session:', error.message);
}
export async function logout(to = 'index.html') {
  await sb.auth.signOut().catch(() => {});
  ctxPromise = null;
  location.href = to;
}

// Egyptian mobile: 01xxxxxxxxx / +201xxxxxxxxx / 201xxxxxxxxx -> 201xxxxxxxxx
export function canonicalPhone(input) {
  let d = String(input || '').replace(/[^\d+]/g, '');
  d = d.replace(/^\+/, '').replace(/^00/, '');
  if (/^01\d{9}$/.test(d)) d = '2' + d;
  else if (/^1\d{9}$/.test(d)) d = '20' + d;
  return /^201[0125]\d{8}$/.test(d) ? d : null;
}
export const phoneEmail = (digits) => `u${digits}@${LOGIN_DOMAIN}`;
export const providerEmail = (username) => `${String(username).trim().toLowerCase()}@p.${LOGIN_DOMAIN}`;
export const localPhone = (digits) => (digits && digits.startsWith('20') ? '0' + digits.slice(2) : digits || '');

// ---------- storage ----------
export function mediaUrl(path, v) {
  if (!path) return '';
  const enc = String(path).split('/').map(encodeURIComponent).join('/');
  return `${SUPABASE_URL}/storage/v1/object/public/media/${enc}${v ? `?v=${encodeURIComponent(v)}` : ''}`;
}
// Resize + re-encode before upload (also strips EXIF/GPS).
// Resize + re-encode before upload (also strips EXIF/GPS). WebP when the browser can encode it,
// otherwise JPEG; quality is lowered step by step until the file is under `maxBytes`.
let webpOk = null;
function canWebp() {
  if (webpOk === null) {
    try { const c = document.createElement('canvas'); c.width = c.height = 2; webpOk = c.toDataURL('image/webp').startsWith('data:image/webp'); }
    catch { webpOk = false; }
  }
  return webpOk;
}
export async function resizeImage(file, max = 900, maxBytes = 180 * 1024) {
  if (!file || !/^image\//.test(file.type)) throw new Error('not_image');
  if (file.size > 25 * 1024 * 1024) throw new Error('image_too_big');
  const bmp = await createImageBitmap(file).catch(async () => {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode(); return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  });
  let scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const type = canWebp() ? 'image/webp' : 'image/jpeg';
  let blob = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const w = Math.max(1, Math.round(bmp.width * scale)), hgt = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement('canvas'); c.width = w; c.height = hgt;
    const g = c.getContext('2d');
    if (type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, w, hgt); }   // no black background for PNGs
    g.drawImage(bmp, 0, 0, w, hgt);
    const q = [0.82, 0.74, 0.66, 0.58, 0.5, 0.5, 0.45, 0.4][attempt];
    blob = await new Promise((res) => c.toBlob(res, type, q));
    if (!blob) throw new Error('encode_failed');
    if (blob.size <= maxBytes) break;
    if (attempt >= 4) scale *= 0.85;                                                   // still too big: shrink dimensions
  }
  return blob;
}
const extFor = (t) => (t === 'image/webp' ? 'webp' : 'jpg');
export async function uploadImage(folder, file, max, maxBytes) {
  const blob = await resizeImage(file, max, maxBytes || (max >= 1400 ? 300 * 1024 : max <= 400 ? 60 * 1024 : 160 * 1024));
  const name = `${folder}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}.${extFor(blob.type)}`;
  const { error } = await sb.storage.from('media').upload(name, blob, { contentType: blob.type, upsert: false, cacheControl: '31536000' });
  if (error) throw error;
  return name;
}
// Transfer screenshot -> PRIVATE bucket (proofs/<user id>/<request id>-<rand>.<ext>)
export async function uploadProof(userId, requestId, file) {
  const blob = await resizeImage(file, 1400, 350 * 1024);
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  const name = `${userId}/${requestId}-${rand}.${extFor(blob.type)}`;
  const { error } = await sb.storage.from('proofs').upload(name, blob, { contentType: blob.type, upsert: false });
  if (error) throw error;
  return name;
}

// Partner lists with their area name. If the areas update (007) isn't in the database yet,
// fall back to the plain columns instead of showing nothing.
let areasEmbedOk = true;
export async function selectProviders(build) {
  if (areasEmbedOk) {
    const r = await build(PROVIDER_COLS, true);
    if (!r.error) return r;
    if (!/areas|relationship|schema cache|area_id/i.test(r.error.message || '')) return r;
    areasEmbedOk = false;
    console.warn('Areas not available in the database yet — run supabase/migrations/007_areas.sql');
  }
  return build('id,name,image_path,discount_percent', false);
}

// ---------- feedback ----------
const ERRORS = {
  forbidden: 'You are not allowed to do that.',
  rate_limited: 'Too many attempts. Please wait a minute and try again.',
  already_active: 'Your membership is already active.',
  payment_required: 'Online payment is not available yet.',
  no_membership: 'You don\'t have a membership yet.',
  username_taken: 'This username is already taken.',
  weak_password: 'Password must be 8–72 characters.',
  invalid_username: 'Username: 3–30 lowercase letters, numbers or _.',
  invalid_signup: 'Please check your details and try again.',
  invalid_image_path: 'Image upload failed. Please try again.',
  not_found: 'Not found.',
  invalid_days: 'Enter a number of days between 1 and 3660.',
  invalid_reason: 'Please choose one of the listed reasons.',
  session_revoked: 'Your account was opened on another device.',
  trial_used: 'Your free trial has already been used.',
  trial_unavailable: 'The free trial is not available right now.',
  payment_accounts_pay_link_check: 'The InstaPay link must look like https://ipn.eg/S/name/instapay/CODE',
  payments_unavailable: 'Membership requests are not available right now.',
  method_unavailable: 'This payment method is not available right now.',
  request_pending: 'You already have a request under review.',
  proof_required: 'Please upload the transfer screenshot.',
  already_decided: 'This request was already handled.',
  invalid_wallet_number: 'Vodafone Cash number must be 11 digits starting with 01.',
  invalid_ip: 'Enter a valid IP address.',
  cannot_ban_self: 'You cannot ban your own IP address.',
  image_too_big: 'This image is too large.',
  not_image: 'Please choose an image file.',
  too_many_reports: 'You already reported this partner twice this week. We are on it.',
  providers_limit_check: 'Uses per period must be between 1 and 100.',
  providers_days_check: 'Pick at least one day.',
};
// Admin pages show the technical reason too (helps diagnose problems from a phone).
export const debugErrors = { on: false };
export function errMsg(e) {
  const m = String(e?.message || e || '');
  const friendly = errMsgFriendly(m);
  return debugErrors.on && m && !friendly.includes(m) ? `${friendly} [${m.slice(0, 160)}]` : friendly;
}
function errMsgFriendly(m) {
  for (const k of Object.keys(ERRORS)) if (m.includes(k)) return ERRORS[k];
  if (/Invalid login credentials/i.test(m)) return S('login_error');
  if (/already registered|already exists/i.test(m)) return S('signup_exists');
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Connection problem. Check your internet and try again.';
  if (/check constraint|violates/i.test(m)) return 'Some values are not valid.';
  return 'Something went wrong. Please try again.';
}
let toastTimer;
export function toast(msg, kind = '') {
  let wrap = $('.toast-wrap');
  if (!wrap) { wrap = h('div', { class: 'toast-wrap', role: 'status', 'aria-live': 'polite' }); document.body.append(wrap); }
  clear(wrap).append(h('div', { class: `toast ${kind}`, text: msg }));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => clear(wrap), 3200);
}
export function confirmDialog(text, okText = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const done = (v) => { back.remove(); resolve(v); };
    const back = h('div', { class: 'dialog-back', onclick: (e) => { if (e.target === back) done(false); } },
      h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
        h('p', { text }),
        h('div', { class: 'row' },
          h('button', { class: 'btn light sm', onclick: () => done(false), text: 'Cancel' }),
          h('button', { class: `btn sm ${danger ? 'danger' : ''}`, onclick: () => done(true), text: okText }))));
    document.body.append(back);
    back.querySelector('.btn:last-child').focus();
  });
}
export function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
export function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function pct(n) {
  const v = Number(n);
  return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '';
}
export function initialOf(name) { return (String(name || '?').trim()[0] || '?').toUpperCase(); }
export function busy(btn, on, label) {
  if (on) { btn.dataset.label = btn.textContent; btn.disabled = true; btn.textContent = label || '…'; }
  else { btn.disabled = false; btn.textContent = btn.dataset.label || btn.textContent; }
}

// ---------- page shell ----------
export function moduleOn(id) {
  const off = S('app_disabled_modules');
  return !(Array.isArray(off) && off.includes(id));
}
function navFor(ctx) {
  const role = ctx.role;
  if (role === 'provider') {
    return [
      moduleOn('scanner') && { href: 'partner.html#scan', key: 'scan', label: S('scan_title').split(' ')[0] || 'Scan', icon: 'scan' },
      moduleOn('provider-profile') && { href: 'partner.html#profile', key: 'profile', label: S('partner_profile_title'), icon: 'store' },
      { href: 'partner.html#history', key: 'history', label: S('partner_history_title'), icon: 'clock' },
    ].filter(Boolean);
  }
  const items = [
    { href: 'index.html', key: 'home', label: S('nav_home'), icon: 'home' },
    { href: 'offers.html', key: 'offers', label: S('nav_offers'), icon: 'tag' },
  ];
  if (moduleOn('membership')) items.push({ href: 'membership.html', key: 'membership', label: S('nav_membership'), icon: 'card' });
  if (role === 'customer' && moduleOn('complaints')) items.push({ href: 'report.html', key: 'report', label: S('nav_report'), icon: 'flag' });
  if (role === 'guest' || role === 'none') items.push({ href: 'login.html', key: 'login', label: S('nav_login'), icon: 'login' });
  else items.push({ href: role === 'admin' ? 'admin.html' : 'account.html', key: 'account', label: role === 'admin' ? 'Admin' : S('nav_account'), icon: role === 'admin' ? 'shield' : 'user' });
  return items;
}

function categoriesDropdown() {
  const menu = h('div', { class: 'navdrop-menu', hidden: true });
  const btn = h('button', { type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, S('nav_categories'), icon('chev'));
  const wrap = h('div', { class: 'navdrop' }, btn, menu);
  let filled = false;
  btn.addEventListener('click', async () => {
    const open = menu.hidden;
    menu.hidden = !open; btn.setAttribute('aria-expanded', String(open));
    if (open && !filled) {
      filled = true;
      const cats = await loadCategories();
      menu.append(...cats.map((c) => h('a', { href: `offers.html?cat=${encodeURIComponent(c.id)}` }, catIcon(c.icon), h('span', { text: c.name }))),
        h('a', { href: 'offers.html' }, svgPath(CAT_ICONS.more, 'cat-ic', '1.8'), h('b', { text: S('all_categories') })));
    }
  });
  document.addEventListener('pointerdown', (e) => { if (!wrap.contains(e.target)) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
  return wrap;
}

export async function shell(active, { requireRole, searchBar } = {}) {
  await loadSettings();
  document.documentElement.dir = S('text_direction') === 'rtl' ? 'rtl' : 'ltr';
  const ctx = await getContext();
  if (ctx.role === 'revoked') { await sessionRevoked(); throw new Error('redirect'); }
  if (requireRole && !requireRole.includes(ctx.role)) {
    location.replace(ctx.role === 'provider' ? 'partner.html' : `login.html?next=${encodeURIComponent(location.pathname.split('/').pop() + location.search + location.hash)}`);
    throw new Error('redirect');
  }
  const items = navFor(ctx);
  const isProvider = ctx.role === 'provider';
  const logo = h('a', { class: 'logo', href: isProvider ? 'partner.html' : 'index.html', 'aria-label': S('site_title') }, brandLogo());
  const row = h('div', { class: 'head-row' }, logo);
  if (isProvider) {
    row.append(h('nav', { class: 'mainnav' }, items.map((i) => h('a', { href: i.href, class: i.key === active ? 'active' : '' }, icon(i.icon), i.label))),
      h('div', { class: 'spacer' }),
      ctx.provider?.area_name ? h('span', { class: 'area-pill', title: S('area_label') }, icon('pin', 'pin'), h('span', { text: ctx.provider.area_name })) : null,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Log out', onclick: () => logout('partner.html') }, icon('logout')));
  } else {
    const navEls = [
      h('a', { href: 'index.html', class: active === 'home' ? 'active' : '' }, active === 'home' ? icon('home') : null, S('nav_home')),
      h('a', { href: 'offers.html', class: active === 'offers' ? 'active' : '', text: S('nav_offers') }),
      categoriesDropdown(),
      h('a', { href: 'about.html', class: active === 'about' ? 'active' : '', text: S('nav_about') }),
      h('a', { href: 'about.html#contact', text: S('nav_contact') }),
    ];
    const loggedIn = ctx.role !== 'guest' && ctx.role !== 'none';
    const acctHref = ctx.role === 'admin' ? 'admin.html' : loggedIn ? 'account.html' : 'login.html';
    const acctLabel = ctx.role === 'admin' ? 'Admin' : loggedIn ? (ctx.profile?.first_name || S('nav_account')) : S('nav_signup');
    const searchToggle = h('button', { class: 'icon-btn head-search-toggle', type: 'button', 'aria-label': 'Search' }, icon('search'));
    row.append(h('nav', { class: 'mainnav', 'aria-label': 'Main' }, navEls), h('div', { class: 'spacer' }),
      areaPill(), searchToggle,
      h('a', { class: 'login-pill', href: acctHref }, icon('user'), h('span', { text: acctLabel })),
      h('a', { class: 'icon-btn head-account', href: acctHref, 'aria-label': acctLabel }, icon('user')));
    if (searchBar !== false) {
      import('./search.js').then((m) => {
        const input = m.mountSearch(row, typeof searchBar === 'string' ? searchBar : '');
        searchToggle.addEventListener('click', () => { input.closest('.hsearch').classList.toggle('open'); input.focus(); });
        if (typeof searchBar === 'string' && searchBar) input.closest('.hsearch').classList.add('open');
      }).catch(() => {});
    } else {
      searchToggle.addEventListener('click', () => { const i = document.querySelector('.hero-search input'); if (i) { i.scrollIntoView({ block: 'center', behavior: 'smooth' }); i.focus(); } else location.href = 'search.html'; });
    }
  }
  const top = h('header', { class: 'site-head' }, row);
  const tab = h('nav', { class: 'tabbar', 'aria-label': 'Main' },
    items.map((i) => h('a', { href: i.href, class: i.key === active ? 'active' : '', 'aria-current': i.key === active ? 'page' : null }, icon(i.icon), h('span', { text: i.label }))));
  const foot = h('footer', { class: 'footer' },
    h('div', { class: 'foot-share' }, h('button', { class: 'share-link', type: 'button', onclick: () => shareSheet() }, icon('share'), h('span', { text: S('share_link') }))),
    S('footer_text'), ' · ', h('a', { href: 'about.html', text: S('nav_about') }),
    S('contact_phone') ? [' · ', h('a', { href: `tel:${S('contact_phone').replace(/[^\d+]/g, '')}`, text: S('contact_phone') })] : null);
  document.body.prepend(top);
  document.body.append(foot, tab);
  if (S('site_title')) document.title = document.title.replace('XGo+', S('site_title'));
  registerSW();
  if (!isProvider) setTimeout(maybeInstallPrompt, 2500);
  return ctx;
}

// ---------- areas (customer's chosen area is remembered on this device) ----------
const AREA_KEY = 'xg-area';
let areasPromise = null;
export function loadAreas() {
  if (!areasPromise) {
    areasPromise = sb.from('areas').select('id,name').eq('is_active', true).order('sort_order').order('name').limit(200)
      .then(({ data }) => data || []).catch(() => []);
  }
  return areasPromise;
}
export function getArea() { try { return localStorage.getItem(AREA_KEY) || ''; } catch { return ''; } }
export async function currentArea() {
  const id = getArea();
  if (!id) return null;
  const a = (await loadAreas()).find((x) => x.id === id);
  if (!a) { try { localStorage.removeItem(AREA_KEY); } catch { /* */ } }
  return a || null;
}
export function setArea(id) {
  try { if (id) localStorage.setItem(AREA_KEY, id); else localStorage.removeItem(AREA_KEY); } catch { /* */ }
}
export function areaPill(extraClass = '') {
  const label = h('span', { text: S('area_all') });
  const btn = h('button', { class: `area-pill ${extraClass}`, type: 'button', 'aria-label': S('area_label') }, icon('pin', 'pin'), label, icon('chev', 'chev'));
  currentArea().then((a) => { if (a) label.textContent = a.name; });
  btn.addEventListener('click', pickArea);
  return btn;
}
export async function pickArea() {
  const areas = await loadAreas();
  const cur = getArea();
  const opt = (id, name) => h('button', { class: `area-opt${(cur || '') === id ? ' on' : ''}`, type: 'button', onclick: () => { setArea(id); location.reload(); } },
    icon(id ? 'pin' : 'grid'), h('span', { class: 'grow', text: name }), (cur || '') === id ? icon('check') : null);
  sheet(S('area_pick_title'), h('div', { class: 'area-list' }, opt('', S('area_all')), areas.map((a) => opt(a.id, a.name))));
}

// ---------- share the website ----------
const SHARE_ICONS = {
  whatsapp: ICONS.wa,
  facebook: 'M14 8h3V4h-3a4 4 0 0 0-4 4v2H7v4h3v8h4v-8h3l1-4h-4V8.5a.5.5 0 0 1 .5-.5z',
  instagram: 'M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4zm5 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm5.5-1.5h.01',
  messenger: 'M12 3C7 3 3 6.7 3 11.3c0 2.6 1.3 4.9 3.3 6.4V21l3-1.7c.9.3 1.8.4 2.7.4 5 0 9-3.7 9-8.4S17 3 12 3zm-4 10.5 3-3.2 2 2 3-3.3-3 3.3-2-2z',
  telegram: 'M21 4 3 11l6 2 2 6 3-4 5 4zM9 13l9-6',
  x: 'M4 4l16 16M20 4 4 20',
  sms: 'M4 5h16v11H8l-4 4zM8 10h8',
  email: ICONS.mail,
  copy: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  more: ICONS.share,
};
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch { /* fall back */ }
  const ta = h('textarea', { class: 'offscreen', 'aria-hidden': 'true' }); ta.value = t; document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { /* */ } ta.remove(); return ok;
}
export function shareSheet() {
  const url = `${location.origin}/`;
  const text = S('share_text');
  const msg = `${text}\n${url}`;
  const e = encodeURIComponent;
  const mobile = platform() !== 'other';
  const canNative = typeof navigator.share === 'function';
  const native = async (app) => {
    if (canNative) { try { await navigator.share({ title: S('share_title'), text, url }); return; } catch (err) { if (err?.name === 'AbortError') return; } }
    await copyText(msg);
    toast(app ? S('share_paste_hint').replace('%', app) : S('share_copied'));
  };
  const opts = [
    { k: 'whatsapp', label: 'WhatsApp', href: `https://wa.me/?text=${e(msg)}` },
    { k: 'facebook', label: 'Facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${e(url)}` },
    { k: 'instagram', label: 'Instagram', run: () => native('Instagram') },
    mobile ? { k: 'messenger', label: 'Messenger', href: `fb-messenger://share/?link=${e(url)}` } : null,
    { k: 'telegram', label: 'Telegram', href: `https://t.me/share/url?url=${e(url)}&text=${e(text)}` },
    { k: 'x', label: 'X', href: `https://x.com/intent/post?text=${e(text)}&url=${e(url)}` },
    mobile ? { k: 'sms', label: 'SMS', href: `sms:?&body=${e(msg)}` } : null,
    { k: 'email', label: 'Email', href: `mailto:?subject=${e(S('share_title'))}&body=${e(msg)}` },
    { k: 'copy', label: S('share_copy'), run: async () => { toast((await copyText(url)) ? S('share_copied') : url); } },
    canNative ? { k: 'more', label: S('share_more'), run: () => native() } : null,
  ].filter(Boolean);
  const s = sheet(S('share_title'), h('div', { class: 'share-grid' }, opts.map((o) => {
    const ic = h('span', { class: `share-ic si-${o.k}` }, svgPath(SHARE_ICONS[o.k]));
    const attrs = { class: 'share-opt', 'data-app': o.k };
    if (o.href) return h('a', { ...attrs, href: o.href, target: o.href.startsWith('http') ? '_blank' : null, rel: 'noopener', onclick: () => setTimeout(() => s.close(), 300) }, ic, h('span', { text: o.label }));
    return h('button', { ...attrs, type: 'button', onclick: () => { o.run(); s.close(); } }, ic, h('span', { text: o.label }));
  })), h('div', { class: 'share-url ellipsis', text: url }));
}

// ---------- bottom sheet ----------
export function sheet(title, ...content) {
  const close = () => back.remove();
  const back = h('div', { class: 'sheet-back', onclick: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'row' }, h('h2', { class: 'grow', text: title }), h('button', { class: 'btn sm light', type: 'button', text: 'Close', onclick: close })),
      ...content));
  document.body.append(back);
  return { close, el: back };
}

// ---------- installable app + "add to home screen" popup ----------
let deferredInstall = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
addEventListener('appinstalled', () => { try { localStorage.setItem('xg-install-dismissed', String(Date.now() + 3650 * 864e5)); } catch { /* */ } });
export function isStandalone() {
  try { if (new URLSearchParams(location.search).get('source') === 'pwa') sessionStorage.setItem('xg-pwa', '1'); } catch { /* */ }
  return window.matchMedia?.('(display-mode: standalone)').matches || window.matchMedia?.('(display-mode: fullscreen)').matches
    || navigator.standalone === true || (() => { try { return sessionStorage.getItem('xg-pwa') === '1'; } catch { return false; } })();
}
export function platform() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}
function registerSW() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
}
export function maybeInstallPrompt(force = false) {
  const plat = platform();
  if (!force) {
    if (isStandalone() || plat === 'other' || document.querySelector('.install-back')) return;
    try { if (Number(localStorage.getItem('xg-install-dismissed') || 0) > Date.now()) return; } catch { return; }
  }
  const snooze = (days) => { try { localStorage.setItem('xg-install-dismissed', String(Date.now() + days * 864e5)); } catch { /* */ } };
  const close = (days) => { snooze(days); back.remove(); };
  const steps = String(S(plat === 'ios' ? 'install_ios_steps' : 'install_android_steps')).split('\n').filter(Boolean);
  const list = h('ol', {}, steps.map((t, i) => h('li', {}, t, plat === 'ios' && i === 0 ? [' ', svgPath(ICONS.share, 'share-ic')] : null)));
  const actions = h('div', { class: 'row' });
  if (plat === 'android' && deferredInstall) {
    actions.append(h('button', { class: 'btn light grow', type: 'button', text: S('install_later'), onclick: () => close(7) }),
      h('button', { class: 'btn grow', type: 'button', text: S('install_button'), onclick: async () => {
        try { deferredInstall.prompt(); const r = await deferredInstall.userChoice; close(r?.outcome === 'accepted' ? 3650 : 7); } catch { close(7); }
      } }));
  } else {
    actions.append(h('button', { class: 'btn light grow', type: 'button', text: S('install_later'), onclick: () => close(7) }),
      h('button', { class: 'btn grow', type: 'button', text: S('install_done'), onclick: () => close(30) }));
  }
  const back = h('div', { class: 'install-back', onclick: (e) => { if (e.target === back) close(7); } },
    h('div', { class: 'install', role: 'dialog', 'aria-modal': 'true', 'aria-label': S('install_title') },
      h('div', { class: 'install-head' }, h('img', { src: '/img/icon-192.png', alt: '' }),
        h('div', {}, h('h2', { text: S('install_title') }), h('div', { class: 'small muted', text: S('install_text') }))),
      plat === 'android' && deferredInstall ? null : list, actions));
  document.body.append(back);
}

// Idle auto-logout (admin)
export function idleLogout(minutes, to) {
  let t;
  const reset = () => { clearTimeout(t); t = setTimeout(() => logout(to), minutes * 60 * 1000); };
  ['pointerdown', 'keydown', 'scroll', 'visibilitychange'].forEach((e) => addEventListener(e, reset, { passive: true }));
  reset();
}

// ---------- partners: categories + card (shared by home, search) ----------
let catsPromise = null;
export function loadCategories() {
  if (!catsPromise) {
    catsPromise = sb.from('categories').select('id,name,icon,image_path').eq('is_active', true)
      .order('sort_order').order('name').limit(100)
      .then(({ data }) => data || []).catch(() => []);
  }
  return catsPromise;
}
export function providerCard(p) {
  const extra = Number(p.areas_count) > 1 ? ` +${Number(p.areas_count) - 1}` : '';
  const area = (p.area?.name || p.area_name || '') + ((p.area?.name || p.area_name) ? extra : '');
  return h('a', { class: 'dcard', href: `provider.html?id=${encodeURIComponent(p.id)}` },
    p.image_path
      ? h('img', { src: mediaUrl(p.image_path), alt: '', loading: 'lazy', decoding: 'async', width: 400, height: 430 })
      : h('div', { class: 'ph', text: initialOf(p.name) }),
    h('span', { class: 'off' }, `${pct(p.discount_percent)}%`, h('small', { text: S('off_suffix').replace('%', '').trim() })),
    h('div', { class: 'meta' }, h('span', { class: 'name', text: p.name }),
      area ? h('span', { class: 'area' }, icon('pin'), h('span', { text: area })) : null));
}
export const PROVIDER_COLS = 'id,name,image_path,discount_percent,area:areas(name)';
export function categoryChips(cats, selected, onPick) {
  const bar = h('div', { class: 'chips', role: 'tablist', 'aria-label': S('categories_heading') });
  const mk = (id, label, iconTxt) => {
    const b = h('button', { type: 'button', role: 'tab', class: `chip${(selected || '') === (id || '') ? ' active' : ''}`, 'aria-selected': String((selected || '') === (id || '')) },
      iconTxt ? catIcon(iconTxt) : null, h('span', { text: label }));
    b.addEventListener('click', () => {
      bar.querySelectorAll('.chip').forEach((c) => { c.classList.remove('active'); c.setAttribute('aria-selected', 'false'); });
      b.classList.add('active'); b.setAttribute('aria-selected', 'true');
      b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      onPick(id);
    });
    return b;
  };
  bar.append(mk('', S('categories_all'), ''), ...cats.map((c) => mk(c.id, c.name, c.icon)));
  return bar;
}
// Infinite list: loader(offset) -> rows; renders into grid; returns { reset }
export function infiniteGrid(grid, more, loader, pageSize, emptyText) {
  let offset = 0, done = false, loading = false, seq = 0;
  const sentinel = h('div', { class: 'sentinel', 'aria-hidden': 'true' });
  async function load(reset) {
    if (reset) { offset = 0; done = false; loading = false; clear(grid); }
    if (loading || done) return;
    loading = true;
    const my = ++seq;
    clear(more).append(h('div', { class: 'spinner' }));
    let rows, error;
    try { rows = await loader(offset); } catch (e) { error = e; }
    if (my !== seq) return;
    loading = false;
    clear(more);
    if (error) { more.append(h('p', { class: 'muted center', text: errMsg(error) })); return; }
    rows.forEach((p) => grid.append(providerCard(p)));
    offset += rows.length;
    if (rows.length < pageSize) done = true;
    if (!offset) more.append(h('div', { class: 'empty', text: typeof emptyText === 'function' ? emptyText() : emptyText }));
    if (!done) more.append(sentinel);
  }
  new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) load(false); }, { rootMargin: '600px' }).observe(sentinel);
  return { reset: () => load(true), more: () => load(false) };
}

// ---------- usage rules (generated from the provider's limits; never free text) ----------
const tpl = (t, vars) => String(t).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
export function dayNames(short) { return String(S(short ? 'day_short' : 'day_names')).split(',').map((x) => x.trim()); }
export function rulesText(p) {
  const out = [];
  if (Array.isArray(p.allowed_days) && p.allowed_days.length && p.allowed_days.length < 7) {
    const names = dayNames(false);
    out.push(`${S('rule_days')} ${p.allowed_days.map((d) => names[d]).join(', ')}`);
  }
  if (p.limit_count && p.limit_period) {
    out.push(tpl(p.limit_count === 1 ? S('rule_uses_one') : S('rule_uses_many'), { n: p.limit_count, period: S(`period_${p.limit_period}`) }));
  }
  return out;
}
export function usageText(u) {
  if (!u) return '';
  if (u.valid_today === false) return S('usage_not_today');
  if (u.limit_count && u.uses_left === 0) return tpl(S('usage_none_left'), { date: fmtDate(u.resets_at) });
  if (u.limit_count) return tpl(S('usage_left'), { n: u.uses_left, period: S(`period_${u.limit_period}`) });
  return '';
}
export function limitsEditor(p) {
  const on = h('input', { type: 'checkbox' }); on.checked = !!p.limit_count;
  const count = h('input', { class: 'input', type: 'number', min: 1, max: 100, step: 1, value: p.limit_count || 1, inputmode: 'numeric' });
  const period = h('select', { class: 'input' }, ['day', 'week', 'month', 'year'].map((x) => h('option', { value: x, text: `/ ${S(`period_${x}`)}` })));
  period.value = p.limit_period || 'month';
  const usesRow = h('div', { class: 'row' }, h('div', { class: 'grow' }, count), h('div', { class: 'grow' }, period));
  const sync = () => { usesRow.hidden = !on.checked; };
  on.addEventListener('change', sync); sync();
  const days = new Set(Array.isArray(p.allowed_days) && p.allowed_days.length ? p.allowed_days : [0, 1, 2, 3, 4, 5, 6]);
  const short = dayNames(true);
  const preview = h('div', { class: 'notes small' });
  const dayBtns = short.map((label, d) => {
    const b = h('button', { type: 'button', class: `daybtn${days.has(d) ? ' on' : ''}`, 'aria-pressed': String(days.has(d)), text: label });
    b.addEventListener('click', () => {
      if (days.has(d)) { if (days.size > 1) days.delete(d); } else days.add(d);
      b.classList.toggle('on', days.has(d)); b.setAttribute('aria-pressed', String(days.has(d))); upd();
    });
    return b;
  });
  const value = () => ({
    limit_count: on.checked ? Math.min(100, Math.max(1, Math.trunc(Number(count.value) || 1))) : null,
    limit_period: on.checked ? period.value : null,
    allowed_days: days.size === 7 ? null : [...days].sort((a, b) => a - b),
  });
  function upd() { const t = rulesText(value()); preview.textContent = t.length ? t.join(' · ') : 'No limits — valid every day, unlimited uses.'; }
  [on, count, period].forEach((el) => el.addEventListener('input', upd)); on.addEventListener('change', upd); upd();
  const el = h('div', { class: 'stack limits' },
    h('label', { class: 'switch' }, h('span', { text: S('limits_enable') }), on), usesRow,
    h('div', {}, h('div', { class: 'small', text: S('limits_days') }), h('div', { class: 'days' }, dayBtns)),
    h('div', {}, h('div', { class: 'small muted', text: 'Customers will see:' }), preview));
  return { el, value };
}

// ---------- change password (re-checks the current password first) ----------
export function passwordForm() {
  const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', maxlength: 72 });
  const nw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 72 });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const btn = h('button', { class: 'btn', type: 'submit', text: S('password_title') });
  const form = h('form', { class: 'card stack', novalidate: true },
    h('b', { text: S('password_title') }),
    h('label', { class: 'field' }, h('span', { text: S('current_password_label') }), cur),
    h('label', { class: 'field' }, h('span', { text: S('new_password_label') }), nw), err, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    if (nw.value.length < 8 || nw.value.length > 72) { err.textContent = ERRORS.weak_password; return; }
    if (nw.value === cur.value) { err.textContent = 'New password must be different.'; return; }
    busy(btn, true);
    const { data: { user } } = await sb.auth.getUser();
    const re = await sb.auth.signInWithPassword({ email: user?.email || '', password: cur.value });
    if (re.error) { busy(btn, false); err.textContent = S('password_wrong_current'); return; }
    const { error } = await sb.auth.updateUser({ password: nw.value });
    busy(btn, false);
    if (error) { err.textContent = errMsg(error); return; }
    cur.value = ''; nw.value = '';
    toast(S('password_changed'));
  });
  return form;
}

// ---------- discount filter ----------
export const DISCOUNT_STEPS = [10, 20, 30, 50];
export function discountSelect(value, onChange) {
  const sel = h('select', { class: 'input discount-sel', 'aria-label': S('discount_filter_label') },
    h('option', { value: '', text: S('discount_any') }),
    DISCOUNT_STEPS.map((n) => h('option', { value: String(n), text: `${n}${S('discount_min_suffix')}` })));
  sel.value = value ? String(value) : '';
  sel.addEventListener('change', () => onChange(sel.value ? Number(sel.value) : null));
  return sel;
}

export function param(name) { return new URLSearchParams(location.search).get(name); }
export { DEFAULTS, SUPABASE_URL };
