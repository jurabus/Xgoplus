import { sb, h, errMsg } from '../common.js';

// Database updates the website expects (file name -> schema_status key)
const MIGRATIONS = [
  ['m005', '005_categories_search.sql'], ['m006', '006_limits_history_complaints.sql'],
  ['m007', '007_areas.sql'], ['m008', '008_payments_security.sql'], ['m009', '009_trial_session_paylink.sql'], ['m010', '010_home_feed.sql'], ['m011', '011_branches.sql'], ['m012', '012_offers.sql'], ['m013', '013_interests_explore.sql'],
];

async function schemaWarning() {
  const { data, error } = await sb.rpc('schema_status');
  const missing = error ? MIGRATIONS.filter(([k]) => ['m007', 'm008', 'm009', 'm010', 'm011', 'm012', 'm013'].includes(k)).map((m) => m[1])
    : MIGRATIONS.filter(([k]) => !data[k]).map((m) => m[1]);
  if (!missing.length) return null;
  return h('div', { class: 'warnbox stack' }, h('b', { text: 'Database update needed' }),
    h('div', { class: 'small', text: 'Run these files in the Supabase SQL Editor, in this order:' }),
    h('ol', { class: 'small' }, missing.map((f) => h('li', {}, h('a', { href: `https://raw.githubusercontent.com/jurabus/Xgoplus/main/supabase/migrations/${f}`, target: '_blank', rel: 'noopener', text: f })))));
}

export async function render(root) {
  const [warn, { data, error }] = await Promise.all([schemaWarning(), sb.rpc('admin_stats')]);
  if (warn) root.append(warn);
  if (error || !data) { root.append(h('p', { class: 'form-error', text: errMsg(error || 'forbidden') })); return; }
  const stat = (n, label, href) => h(href ? 'a' : 'div', { class: 'stat', href }, h('b', { text: String(n ?? 0) }), h('span', { text: label }));
  root.append(h('h1', { text: 'Dashboard' }), h('div', { class: 'stats' },
    stat(data.requests_pending, 'Payment requests waiting', '#payments'),
    stat(data.complaints_open, 'Open reports', '#complaints'),
    stat(data.members, 'Customers'), stat(data.members_active, 'Active memberships'),
    stat(data.providers_active, `Active providers (of ${data.providers})`),
    stat(data.scans_today, 'Scans today'), stat(data.scans_total, 'Scans total'),
    stat(data.bans_active, 'Banned IPs', '#security')),
    h('h2', { text: 'Quick actions' }),
    h('div', { class: 'row wrap' },
      h('a', { class: 'btn ghost', href: '#payments', text: 'Payment requests' }),
      h('a', { class: 'btn ghost', href: '#providers', text: '+ Add provider' }),
      h('a', { class: 'btn ghost', href: '#banners', text: 'Edit banners' }),
      h('a', { class: 'btn ghost', href: '#texts', text: 'Edit texts' })));
}
