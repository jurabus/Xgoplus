import { sb, shell, S, h, $, clear, canonicalPhone, phoneEmail, errMsg, busy, param, getContext, brandLogo, claimSession } from '../common.js';

const app = $('#app');
function safeNext() {
  const n = param('next') || '';
  return /^[a-z0-9_-]+\.html(\?[\w=&%.-]*)?$/i.test(n) ? n : 'membership.html';
}
async function main() {
  const ctx = await shell('login');
  if (ctx.role === 'customer' || ctx.role === 'admin') { location.replace(ctx.role === 'admin' && !param('next') ? 'admin.html' : safeNext()); return; }
  if (ctx.role === 'provider') { location.replace('partner.html'); return; }
  clear(app);
  const phone = h('input', { class: 'input grow', type: 'tel', inputmode: 'tel', autocomplete: 'username', placeholder: '01xxxxxxxxx', required: true, maxlength: 16 });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true, maxlength: 72 });
  const err = h('div', { class: 'form-error', role: 'alert', text: param('revoked') ? S('session_revoked') : '' });
  const btn = h('button', { class: 'btn block', type: 'submit', text: S('login_button') });
  const form = h('form', { class: 'card stack', novalidate: true },
    h('label', { class: 'field' }, h('span', { text: S('phone_label') }), h('div', { class: 'phone-row' }, h('div', { class: 'cc', text: '+20' }), phone)),
    h('label', { class: 'field' }, h('span', { text: S('password_label') }), pass),
    err, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const digits = canonicalPhone(phone.value);
    if (!digits) { err.textContent = 'Enter a valid Egyptian mobile number (01xxxxxxxxx).'; return; }
    if (!pass.value) { err.textContent = 'Enter your password.'; return; }
    busy(btn, true);
    const { error } = await sb.auth.signInWithPassword({ email: phoneEmail(digits), password: pass.value });
    if (error) { busy(btn, false); err.textContent = errMsg(error); return; }
    await claimSession();   // signs this account out everywhere else
    const c = await getContext(true);
    location.replace(c.role === 'admin' && !param('next') ? 'admin.html' : safeNext());
  });
  app.append(h('div', { class: 'auth stack' }, h('div', { class: 'auth-hero' }, brandLogo()),
    h('h1', { text: S('login_title') }), h('p', { class: 'muted', text: S('login_subtitle') }), form,
    h('p', { class: 'center' }, 'New here? ', h('a', { href: `signup.html${location.search}`, text: S('signup_button') })),
    h('p', { class: 'center small' }, h('a', { href: 'partner.html', text: S('nav_partner') }))));
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
