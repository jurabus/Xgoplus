import { sb, shell, S, h, $, clear, canonicalPhone, phoneEmail, errMsg, busy, param, brandLogo, claimSession, storedRef, moduleOn } from '../common.js';

const app = $('#app');
async function main() {
  const ctx = await shell('login');
  if (ctx.role !== 'guest' && ctx.role !== 'none') { location.replace('membership.html'); return; }
  clear(app);
  const first = h('input', { class: 'input', autocomplete: 'given-name', required: true, maxlength: 40 });
  const last = h('input', { class: 'input', autocomplete: 'family-name', required: true, maxlength: 40 });
  const phone = h('input', { class: 'input grow', type: 'tel', inputmode: 'tel', autocomplete: 'username', placeholder: '01xxxxxxxxx', required: true, maxlength: 16 });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true, minlength: 8, maxlength: 72 });
  const refOn = moduleOn('referrals');
  const ref = h('input', { class: 'input code-input', autocomplete: 'off', maxlength: 12, placeholder: 'ABC123', value: storedRef() || '' });
  const refMsg = h('small', { class: 'muted' });
  let refState = { code: '', valid: true };
  async function checkRef() {
    const c = ref.value.trim().toUpperCase();
    if (!c) { refState = { code: '', valid: true }; refMsg.textContent = ''; refMsg.className = 'muted'; return refState; }
    if (c === refState.code) return refState;
    const { data } = await sb.rpc('check_referral_code', { p_code: c });
    refState = { code: c, valid: !!data?.valid };
    refMsg.textContent = refState.valid ? S('signup_ref_ok').replace('{name}', data.name || '') : S('signup_ref_bad');
    refMsg.className = refState.valid ? 'ok' : 'bad';
    return refState;
  }
  ref.addEventListener('change', checkRef);
  if (ref.value) checkRef();
  const err = h('div', { class: 'form-error', role: 'alert' });
  const btn = h('button', { class: 'btn block', type: 'submit', text: S('signup_button') });
  const form = h('form', { class: 'card stack', novalidate: true },
    h('div', { class: 'row' },
      h('label', { class: 'field grow' }, h('span', { text: S('first_name_label') }), first),
      h('label', { class: 'field grow' }, h('span', { text: S('last_name_label') }), last)),
    h('label', { class: 'field' }, h('span', { text: S('phone_label') }), h('div', { class: 'phone-row' }, h('div', { class: 'cc', text: '+20' }), phone)),
    h('label', { class: 'field' }, h('span', { text: S('password_label') }), pass, h('small', { class: 'muted', text: 'At least 8 characters' })),
    refOn ? h('label', { class: 'field signup-ref' }, h('span', { text: S('signup_ref_label') }), ref, refMsg) : null,
    err, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const f = first.value.trim(), l = last.value.trim();
    const digits = canonicalPhone(phone.value);
    if (!f || !l) { err.textContent = 'Enter your first and last name.'; return; }
    if (!digits) { err.textContent = 'Enter a valid Egyptian mobile number (01xxxxxxxxx).'; return; }
    if (pass.value.length < 8) { err.textContent = 'Password must be at least 8 characters.'; return; }
    busy(btn, true);
    const meta = { phone: digits, first_name: f, last_name: l };
    if (refOn && ref.value.trim()) {
      const r = await checkRef();
      if (!r.valid) { busy(btn, false); err.textContent = S('signup_ref_bad'); ref.focus(); return; }
      meta.ref = r.code;
    }
    const { data, error } = await sb.auth.signUp({
      email: phoneEmail(digits), password: pass.value,
      options: { data: meta },
    });
    // With "Confirm email" OFF a session comes back. An existing phone returns an error or a user without session.
    if (error || !data?.session) {
      busy(btn, false);
      err.textContent = error ? errMsg(error) : S('signup_exists');
      return;
    }
    await claimSession();
    const next = param('next');
    location.replace(next && /^[a-z0-9_-]+\.html/i.test(next) ? next : 'membership.html');
  });
  app.append(h('div', { class: 'auth stack' }, h('div', { class: 'auth-hero' }, brandLogo()),
    h('h1', { text: S('signup_title') }), h('p', { class: 'muted', text: S('signup_subtitle') }), form,
    h('p', { class: 'center' }, 'Already a member? ', h('a', { href: `login.html${location.search}`, text: S('login_button') }))));
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
