// Admin panel shell: email+password login, admins checked in the database,
// idle auto-logout, one tab per feature (js/admin/<tab>.js).
import { sb, loadSettings, S, h, $, clear, errMsg, busy, getContext, logout, idleLogout, brandLogo } from '../common.js';

const TABS = [
  { id: 'dashboard', title: 'Dashboard' },
  { id: 'providers', title: 'Providers' },
  { id: 'categories', title: 'Categories' },
  { id: 'areas', title: 'Areas' },
  { id: 'members', title: 'Members' },
  { id: 'banners', title: 'Banners' },
  { id: 'texts', title: 'Texts & settings' },
  { id: 'complaints', title: 'Reports' },
  { id: 'scans', title: 'Scans' },
  { id: 'modules', title: 'Modules' },
];
const app = $('#app');

function loginView(msg = '') {
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'username', required: true, maxlength: 200 });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true, maxlength: 72 });
  const err = h('div', { class: 'form-error', role: 'alert', text: msg });
  const btn = h('button', { class: 'btn block', type: 'submit', text: 'Log in' });
  const form = h('form', { class: 'card stack', novalidate: true },
    h('label', { class: 'field' }, h('span', { text: 'Email' }), email),
    h('label', { class: 'field' }, h('span', { text: 'Password' }), pass), err, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    busy(btn, true);
    const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
    if (error) { busy(btn, false); err.textContent = /Invalid login/i.test(error.message) ? 'Wrong email or password.' : errMsg(error); return; }
    const c = await getContext(true);
    if (c.role !== 'admin') { await sb.auth.signOut(); busy(btn, false); err.textContent = 'This account is not an admin.'; return; }
    location.reload();
  });
  clear(app).append(h('div', { class: 'auth stack' }, h('div', { class: 'auth-hero' }, brandLogo()), h('h1', { text: 'Admin' }), form,
    h('p', { class: 'center small' }, h('a', { href: 'index.html', text: '← Website' }))));
}

async function main() {
  await loadSettings({ fresh: true });
  const ctx = await getContext();
  if (ctx.role !== 'admin') {
    if (ctx.role !== 'guest') await sb.auth.signOut();
    loginView(ctx.role !== 'guest' ? 'This account is not an admin.' : '');
    return;
  }
  idleLogout(20, 'admin.html');
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
  addEventListener('hashchange', route);
  route();
}
main().catch((e) => console.error(e));
