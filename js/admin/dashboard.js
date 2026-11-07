import { sb, h, errMsg } from '../common.js';

export async function render(root) {
  const { data, error } = await sb.rpc('admin_stats');
  if (error) { root.append(h('p', { class: 'form-error', text: errMsg(error) })); return; }
  const stat = (n, label) => h('div', { class: 'stat' }, h('b', { text: String(n ?? 0) }), h('span', { text: label }));
  root.append(h('h1', { text: 'Dashboard' }), h('div', { class: 'stats' },
    stat(data.members, 'Customers'), stat(data.members_active, 'Active memberships'),
    stat(data.providers_active, `Active providers (of ${data.providers})`),
    stat(data.scans_today, 'Scans today'), stat(data.scans_total, 'Scans total')),
    h('h2', { text: 'Quick actions' }),
    h('div', { class: 'row wrap' },
      h('a', { class: 'btn ghost', href: '#providers', text: '+ Add provider' }),
      h('a', { class: 'btn ghost', href: '#banners', text: 'Edit banners' }),
      h('a', { class: 'btn ghost', href: '#texts', text: 'Edit texts' })));
}
