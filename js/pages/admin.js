// Admin panel. Only reachable at /admin.html (not linked anywhere).
// Access = email+password, then a 6-digit code from an authenticator app (2FA),
// account listed in `admins`, IP not banned. Failed attempts are reported to the
// database, which bans the IP from admin after repeated suspicious activity.
import {
  sb, loadSettings, h, $, clear, errMsg, busy, logout, idleLogout, brandLogo, icon, debugErrors,
} from '../common.js';

debugErrors.on = true;  // admin sees technical error details

const TABS = [
  { id: 'dashboard', title: 'Dashboard' },
  { id: 'payments', title: 'Payments' },
  { id: 'providers', title: 'Providers' },
  { id: 'categories', title: 'Categories' },
  { id: 'areas', title: 'Areas' },
  { id: 'members', title: 'Members' },
  { id: 'banners', title: 'Banners' },
  { id: 'interests', title: 'Interests' },
  { id: 'explore', title: 'Explore ads' },
  { id: 'texts', title: 'Texts & settings' },
  { id: 'complaints', title: 'Reports' },
  { id: 'scans', title: 'Scans' },
  { id: 'security', title: 'Security' },
  { id: 'modules', title: 'Modules' },
];
const app = $('#app');

function frame(...content) {
  clear(app).append(h('div', { class: 'auth stack' }, h('div', { class: 'auth-hero' }, brandLogo()), ...content));
}
function deniedView() {
  sb.auth.signOut().catch(() => {});
  clear(app).append(h('div', { class: 'denied stack' }, icon('shield'), h('h1', { text: 'Access denied' }),
    h('p', { class: 'muted', text: 'Too many suspicious attempts from your network. Admin access is blocked for this IP address.' })));
}
async function gate() {
  const { data, error } = await sb.rpc('admin_gate');
  if (error) return { banned: false, listed: null, legacy: true };   // database not updated yet (008)
  return data;
}
async function report(kind, detail) {
  const { data } = await sb.rpc('report_admin_failure', { p_kind: kind, p_detail: detail || '' });
  return !!data?.banned;
}

function loginView(msg = '') {
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'username', required: true, maxlength: 200 });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true, maxlength: 72 });
  const err = h('div', { class: 'form-error', role: 'alert', text: msg });
  const btn = h('button', { class: 'btn block', type: 'submit', text: 'Continue' });
  const form = h('form', { class: 'card stack', novalidate: true },
    h('label', { class: 'field' }, h('span', { text: 'Email' }), email),
    h('label', { class: 'field' }, h('span', { text: 'Password' }), pass), err, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (!email.value.trim() || !pass.value) { err.textContent = 'Enter email and password.'; return; }
    busy(btn, true);
    const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
    if (error) {
      const banned = await report('password', email.value.trim().slice(0, 120));
      if (banned) { deniedView(); return; }
      busy(btn, false);
      err.textContent = /Invalid login/i.test(error.message) ? 'Wrong email or password.' : errMsg(error);
      pass.value = '';
      return;
    }
    main();
  });
  frame(h('h1', { text: 'Admin' }), form);
}

async function mfaView() {
  const err = h('div', { class: 'form-error', role: 'alert' });
  const code = h('input', { class: 'input otp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]*', required: true });
  const btn = h('button', { class: 'btn block', type: 'submit', text: 'Verify' });
  const out = h('button', { class: 'btn block light', type: 'button', text: 'Cancel', onclick: () => logout('admin.html') });
  const { data: f, error: fe } = await sb.auth.mfa.listFactors();
  if (fe) { frame(h('p', { class: 'form-error', text: errMsg(fe) }), out); return; }
  let factorId = (f?.totp || []).find((x) => x.status === 'verified')?.id;
  const parts = [];
  if (!factorId) {
    // first time: set up the authenticator app
    for (const x of f?.all || []) if (x.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: x.id }).catch(() => {});
    const { data: en, error: ee } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: `XGo admin ${new Date().toISOString().slice(0, 16)}` });
    if (ee) { frame(h('p', { class: 'form-error', text: errMsg(ee) }), out); return; }
    factorId = en.id;
    parts.push(h('div', { class: 'card stack' },
      h('b', { text: 'Set up two-step verification (one time)' }),
      h('ol', { class: 'small' },
        h('li', { text: 'Install Google Authenticator or Microsoft Authenticator on your phone.' }),
        h('li', { text: 'Tap “+” and scan this QR code — or choose “Enter a setup key” and paste the key below.' }),
        h('li', { text: 'Type the 6-digit code the app shows.' })),
      h('div', { class: 'mfa-qr' }, h('img', { src: en.totp.qr_code, alt: 'Authenticator QR code', width: 196, height: 196 })),
      h('div', { class: 'mfa-secret', id: 'mfa-secret', text: en.totp.secret })));
  }
  const form = h('form', { class: 'card stack', novalidate: true },
    h('label', { class: 'field' }, h('span', { text: '6-digit code from your authenticator app' }), code), err, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    if (!/^\d{6}$/.test(code.value.trim())) { err.textContent = 'Enter the 6 digits.'; return; }
    busy(btn, true);
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: code.value.trim() });
    if (error) {
      const banned = await report('mfa', '');
      if (banned) { deniedView(); return; }
      busy(btn, false); code.value = '';
      err.textContent = /invalid|code/i.test(error.message) ? 'Wrong or expired code. Try the next one.' : errMsg(error);
      return;
    }
    main();
  });
  frame(h('h1', { text: 'Two-step verification' }), ...parts, form, out);
  code.focus();
}

async function panel() {
  idleLogout(20, 'admin.html');
  document.querySelector('.site-head')?.remove();
  const top = h('header', { class: 'site-head' }, h('div', { class: 'head-row' },
    h('a', { class: 'logo', href: 'index.html' }, brandLogo()), h('span', { class: 'badge brand', text: 'Admin' }), h('div', { class: 'spacer' }),
    h('button', { class: 'btn sm light', type: 'button', text: 'Log out', onclick: () => logout('admin.html') })));
  document.body.prepend(top);
  const nav = h('div', { class: 'admin-tabs', role: 'tablist' });
  const body = h('div', { id: 'tab-body' });
  clear(app).append(nav, body);
  const buttons = TABS.map((t) => h('button', { type: 'button', role: 'tab', 'data-id': t.id, text: t.title, onclick: () => { location.hash = t.id; } }));
  nav.append(...buttons);
  async function route() {
    const id = TABS.some((t) => t.id === location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard';
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.id === id));
    clear(body).append(h('div', { class: 'spinner' }));
    try {
      const mod = await import(`../admin/${id}.js`);
      clear(body);
      await mod.render(body);
    } catch (e) {
      console.error(e);
      clear(body).append(h('p', { class: 'form-error', text: errMsg(e) }));
    }
  }
  if (!panel.bound) { addEventListener('hashchange', route); panel.bound = true; }
  route();
}

async function main() {
  await loadSettings({ fresh: true });
  const { data: { session } } = await sb.auth.getSession();
  const g = await gate();
  if (g.banned) { deniedView(); return; }
  if (!session) { loginView(); return; }
  if (g.legacy) {   // before update 008: old rules (no 2FA yet)
    const { data: ok } = await sb.rpc('is_admin');
    if (ok) { panel(); return; }
    await sb.auth.signOut(); loginView('This account is not an admin.'); return;
  }
  if (!g.listed) { await sb.auth.signOut(); loginView('This account is not an admin.'); return; }
  if (g.aal !== 'aal2') { mfaView(); return; }
  panel();
}
main().catch((e) => { console.error(e); clear(app).append(h('p', { class: 'form-error', text: errMsg(e) })); });
