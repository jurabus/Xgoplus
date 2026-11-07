import { sb, h, errMsg, busy, toast, confirmDialog, fmtDate, localPhone } from '../common.js';
import { sheet, field, input, pagedList } from './ui.js';

let list, q = '';
const BADGE = { active: ['ok', 'Active'], expired: ['bad', 'Expired'], none: ['brand', 'No membership'] };

function memberSheet(m) {
  const days = input({ type: 'number', min: 1, max: 3660, value: 365 });
  const grant = h('button', { class: 'btn', type: 'button', text: 'Add days' });
  const revoke = h('button', { class: 'btn block danger', type: 'button', text: 'End membership now' });
  const [cls, label] = BADGE[m.status];
  const s = sheet(`${m.first_name} ${m.last_name}`,
    h('div', { class: 'card stack' },
      h('div', {}, 'Phone: ', h('a', { href: `tel:+${m.phone}`, text: localPhone(m.phone) })),
      h('div', {}, 'Joined: ', fmtDate(m.created_at)),
      h('div', {}, 'Membership: ', h('span', { class: `badge ${cls}`, text: label }), m.expires_at ? ` until ${fmtDate(m.expires_at)}` : '')),
    h('h2', { text: 'Extend / grant membership' }),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Days to add', days)), grant),
    m.status === 'active' ? h('div', { class: 'stack' }, h('div'), revoke) : null);
  grant.addEventListener('click', async () => {
    busy(grant, true);
    const { error } = await sb.rpc('admin_grant_membership', { p_user_id: m.id, p_days: Math.trunc(Number(days.value)) });
    busy(grant, false);
    if (error) { toast(errMsg(error), 'bad'); return; }
    s.close(); toast('Membership updated'); list.load();
  });
  revoke.addEventListener('click', async () => {
    if (!(await confirmDialog('End this membership now? The member QR will show "expired".', 'End now', true))) return;
    const { error } = await sb.rpc('admin_revoke_membership', { p_user_id: m.id });
    if (error) { toast(errMsg(error), 'bad'); return; }
    s.close(); toast('Membership ended'); list.load();
  });
}

export async function render(root) {
  const search = input({ type: 'search', placeholder: 'Search phone or name', maxlength: 40 });
  let t; search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { q = search.value.trim(); list.reset(); }, 300); });
  root.append(h('h1', { text: 'Members' }), h('div', { class: 'searchbar' }, search));
  list = pagedList(root, async (offset, limit) => {
    const { data, error } = await sb.rpc('admin_list_members', { p_search: q, p_limit: limit, p_offset: offset });
    if (error) { toast(errMsg(error), 'bad'); return { rows: [], total: 0 }; }
    return { rows: data, total: data[0]?.total ?? (offset ? null : 0) };
  }, (m) => {
    const [cls, label] = BADGE[m.status];
    return h('button', { class: 'item btn-reset', type: 'button', onclick: () => memberSheet(m) },
      h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, h('b', { text: `${m.first_name} ${m.last_name}` })),
        h('div', { class: 'small muted', text: `${localPhone(m.phone)}${m.expires_at ? ` · until ${fmtDate(m.expires_at)}` : ''}` })),
      h('span', { class: `badge ${cls}`, text: label }));
  });
  list.load();
}
