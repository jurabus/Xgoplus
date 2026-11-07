import { sb, shell, S, h, $, clear, errMsg, busy, toast, logout, localPhone, fmtDate } from '../common.js';

const app = $('#app');
async function main() {
  const ctx = await shell('account', { requireRole: ['customer', 'admin', 'provider', 'none'] });
  clear(app);
  app.append(h('h1', { text: S('nav_account') }));
  if (ctx.role === 'customer') {
    const p = ctx.profile;
    const first = h('input', { class: 'input', value: p.first_name, maxlength: 40, autocomplete: 'given-name' });
    const last = h('input', { class: 'input', value: p.last_name, maxlength: 40, autocomplete: 'family-name' });
    const save = h('button', { class: 'btn', type: 'submit', text: 'Save' });
    const form = h('form', { class: 'card stack' },
      h('label', { class: 'field' }, h('span', { text: S('phone_label') }), h('input', { class: 'input', value: localPhone(p.phone), disabled: true })),
      h('div', { class: 'row' },
        h('label', { class: 'field grow' }, h('span', { text: S('first_name_label') }), first),
        h('label', { class: 'field grow' }, h('span', { text: S('last_name_label') }), last)),
      save);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!first.value.trim() || !last.value.trim()) { toast('Enter your first and last name.', 'bad'); return; }
      busy(save, true);
      const { error } = await sb.from('profiles').update({ first_name: first.value.trim(), last_name: last.value.trim() }).eq('id', p.id);
      busy(save, false);
      toast(error ? errMsg(error) : 'Saved', error ? 'bad' : '');
    });
    const m = ctx.membership || {};
    app.append(form,
      h('a', { class: 'card row', href: 'membership.html' },
        h('div', { class: 'grow' }, h('b', { text: S('membership_title') }),
          h('div', { class: 'small muted', text: m.expires_at ? `${S('membership_valid_until')}: ${fmtDate(m.expires_at)}` : S('membership_cta') })),
        h('span', { class: `badge ${m.status === 'active' ? 'ok' : m.status === 'expired' ? 'bad' : 'brand'}`,
          text: m.status === 'active' ? S('membership_active_label') : m.status === 'expired' ? S('membership_expired_label') : '→' })));
  } else if (ctx.role === 'admin') {
    app.append(h('a', { class: 'btn block ghost', href: 'admin.html', text: 'Open admin panel' }));
  }
  const out = h('button', { class: 'btn block danger', type: 'button', text: 'Log out' });
  out.addEventListener('click', () => logout('index.html'));
  app.append(h('div', { class: 'stack' }, out));
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
