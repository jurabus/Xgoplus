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
  if (/^(https:\/\/|tel:\+?\d+$|\/(?!\/)|\.\/|[a-z0-9_-]+\.html|#|blob:|data:image\/)/i.test(s) || s === '') return s;
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
};
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
export async function resizeImage(file, max = 900, quality = 0.85) {
  if (!file || !/^image\//.test(file.type)) throw new Error('not_image');
  const bmp = await createImageBitmap(file).catch(async () => {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode(); return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  });
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), hgt = Math.round(bmp.height * scale);
  const c = document.createElement('canvas'); c.width = w; c.height = hgt;
  c.getContext('2d').drawImage(bmp, 0, 0, w, hgt);
  const type = 'image/jpeg';
  const blob = await new Promise((res) => c.toBlob(res, type, quality));
  if (!blob) throw new Error('encode_failed');
  return blob;
}
export async function uploadImage(folder, file, max) {
  const blob = await resizeImage(file, max);
  const name = `${folder}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}.jpg`;
  const { error } = await sb.storage.from('media').upload(name, blob, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' });
  if (error) throw error;
  return name;
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
};
export function errMsg(e) {
  const m = String(e?.message || e || '');
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
function navFor(ctx) {
  const role = ctx.role;
  if (role === 'provider') {
    return [
      { href: 'partner.html#scan', key: 'scan', label: S('scan_title').split(' ')[0] || 'Scan', icon: 'scan' },
      { href: 'partner.html#profile', key: 'profile', label: S('partner_profile_title'), icon: 'store' },
      { href: 'partner.html#history', key: 'history', label: S('partner_history_title'), icon: 'clock' },
    ];
  }
  const off = new Set(Array.isArray(S('app_disabled_modules')) ? S('app_disabled_modules') : []);
  const items = [{ href: 'index.html', key: 'home', label: S('nav_home'), icon: 'home' }];
  if (!off.has('membership')) items.push({ href: 'membership.html', key: 'membership', label: S('nav_membership'), icon: 'card' });
  if (role === 'guest' || role === 'none') items.push({ href: 'login.html', key: 'login', label: S('nav_login'), icon: 'login' });
  else items.push({ href: 'account.html', key: 'account', label: S('nav_account'), icon: 'user' });
  if (role === 'admin') items.push({ href: 'admin.html', key: 'admin', label: 'Admin', icon: 'shield' });
  return items;
}
export async function shell(active, { requireRole } = {}) {
  await loadSettings();
  document.documentElement.dir = S('text_direction') === 'rtl' ? 'rtl' : 'ltr';
  const ctx = await getContext();
  if (requireRole && !requireRole.includes(ctx.role)) {
    location.replace(ctx.role === 'provider' ? 'partner.html' : `login.html?next=${encodeURIComponent(location.pathname.split('/').pop() + location.search)}`);
    throw new Error('redirect');
  }
  const items = navFor(ctx);
  const logoPath = S('logo_path');
  const logo = h('a', { class: 'logo', href: ctx.role === 'provider' ? 'partner.html' : 'index.html', 'aria-label': S('site_title') },
    logoPath ? h('img', { src: mediaUrl(logoPath), alt: S('site_title') }) : [S('site_title').replace(/\s*plus$/i, ''), h('span', { class: 'plus', text: 'Plus' })]);
  const top = h('header', { class: 'topbar' }, logo,
    h('nav', { class: 'topnav' }, items.map((i) => h('a', { href: i.href, class: i.key === active ? 'active' : '', text: i.label }))));
  const tab = h('nav', { class: 'tabbar', 'aria-label': 'Main' },
    items.map((i) => h('a', { href: i.href, class: i.key === active ? 'active' : '', 'aria-current': i.key === active ? 'page' : null }, icon(i.icon), h('span', { text: i.label }))));
  const foot = h('footer', { class: 'footer' }, S('footer_text'),
    S('contact_phone') ? [' · ', h('a', { href: `tel:${S('contact_phone').replace(/[^\d+]/g, '')}`, text: S('contact_phone') })] : null);
  document.body.prepend(top);
  document.body.append(foot, tab);
  if (S('site_title')) document.title = document.title.replace('XGo Plus', S('site_title'));
  return ctx;
}

// Idle auto-logout (admin)
export function idleLogout(minutes, to) {
  let t;
  const reset = () => { clearTimeout(t); t = setTimeout(() => logout(to), minutes * 60 * 1000); };
  ['pointerdown', 'keydown', 'scroll', 'visibilitychange'].forEach((e) => addEventListener(e, reset, { passive: true }));
  reset();
}

export function param(name) { return new URLSearchParams(location.search).get(name); }
export { DEFAULTS, SUPABASE_URL };
