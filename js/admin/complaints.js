// Customer reports against partners.
import { sb, h, clear, errMsg, busy, toast, fmtDateTime, localPhone, S } from '../common.js';
import { sheet, field, textarea, pagedList } from './ui.js';

const STATUSES = ['open', 'in_review', 'resolved', 'dismissed'];
const CLS = { open: 'warn', in_review: 'brand', resolved: 'ok', dismissed: 'bad' };
let list, status = 'open';

function detail(c) {
  const sel = h('select', { class: 'input' }, STATUSES.map((s) => h('option', { value: s, text: S(`status_${s}`) })));
  sel.value = c.status;
  const note = textarea(c.admin_note || '', { maxlength: 1000, rows: 3, placeholder: 'Visible to the customer' });
  const save = h('button', { class: 'btn block', type: 'submit', text: 'Save' });
  const form = h('form', { class: 'stack' },
    h('div', { class: 'card stack' },
      h('div', {}, h('b', { text: c.reason })),
      c.details ? h('div', { class: 'notes small', text: c.details }) : null,
      h('div', { class: 'small' }, 'Partner: ', h('a', { href: `provider.html?id=${c.provider_id}`, text: c.provider_name })),
      h('div', { class: 'small' }, 'Customer: ', c.member_name, ' · ', h('a', { href: `tel:+${c.member_phone}`, text: localPhone(c.member_phone) })),
      h('div', { class: 'small muted', text: `${c.member_scans_here} scan(s) of this customer at this partner · ${fmtDateTime(c.created_at)}` })),
    field('Status', sel), field('Note to customer', note), save);
  const s = sheet('Report', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    busy(save, true);
    const { error } = await sb.rpc('admin_update_complaint', { p_id: c.id, p_status: sel.value, p_note: note.value });
    busy(save, false);
    if (error) { toast(errMsg(error), 'bad'); return; }
    s.close(); toast('Saved'); list.load();
  });
}

export async function render(root) {
  const seg = h('div', { class: 'seg' });
  const draw = () => clear(seg).append(...[['', 'All'], ...STATUSES.map((s) => [s, S(`status_${s}`)])].map(([v, l]) =>
    h('a', { href: '#complaints', class: v === status ? 'active' : '', text: l, onclick: (e) => { e.preventDefault(); status = v; draw(); list.reset(); } })));
  draw();
  root.append(h('h1', { text: 'Reports' }), h('p', { class: 'muted small', text: 'Customers report partners who refused or reduced their discount. Partners never see reports.' }), seg);
  list = pagedList(root, async (offset, limit) => {
    const { data, error } = await sb.rpc('admin_list_complaints', { p_status: status || null, p_limit: limit, p_offset: offset });
    if (error) { toast(errMsg(error), 'bad'); return { rows: [], total: 0 }; }
    return { rows: data, total: data[0]?.total ?? (offset ? null : 0) };
  }, (c) => h('button', { class: 'item btn-reset', type: 'button', onclick: () => detail(c) },
    h('div', { class: 'grow' },
      h('div', { class: 'ellipsis' }, h('b', { text: c.provider_name }), ' · ', c.reason),
      h('div', { class: 'small muted', text: `${c.member_name} · ${fmtDateTime(c.created_at)}` })),
    h('span', { class: `badge ${CLS[c.status]}`, text: S(`status_${c.status}`) })));
  list.load();
}
