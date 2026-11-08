// Areas (e.g. 6th of October, Sheikh Zayed). Customers filter by area; admin assigns each provider an area.
import { sb, h, clear, errMsg, busy, toast, confirmDialog, icon } from '../common.js';
import { sheet, field, input, checkbox } from './ui.js';

let root, rows = [];

function areaSheet(a) {
  const isNew = !a;
  a = a || { name: '', sort_order: (rows.at(-1)?.sort_order || 0) + 10, is_active: true };
  const name = input({ maxlength: 60, value: a.name, placeholder: 'e.g. 6th of October' });
  const sort = input({ type: 'number', step: 1, value: a.sort_order });
  const active = checkbox(a.is_active);
  const err = h('div', { class: 'form-error' });
  const save = h('button', { class: 'btn block', type: 'submit', text: 'Save' });
  const del = isNew ? null : h('button', { class: 'btn block danger', type: 'button', text: 'Delete area' });
  const form = h('form', { class: 'stack' }, field('Area name', name), field('Sort order (lower shows first)', sort),
    h('label', { class: 'switch' }, h('span', { text: 'Visible to customers' }), active), err, save, del);
  const s = sheet(isNew ? 'New area' : 'Edit area', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    if (!name.value.trim()) { err.textContent = 'Enter a name.'; return; }
    const row = { name: name.value.trim(), sort_order: Math.trunc(Number(sort.value) || 0), is_active: active.checked };
    busy(save, true);
    const { error } = isNew ? await sb.from('areas').insert(row) : await sb.from('areas').update(row).eq('id', a.id);
    busy(save, false);
    if (error) { err.textContent = errMsg(error); return; }
    s.close(); toast('Saved'); draw();
  });
  del?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Delete "${a.name}"? Its partners stay, just without an area.`, 'Delete', true))) return;
    const { error } = await sb.from('areas').delete().eq('id', a.id);
    if (error) { toast(errMsg(error), 'bad'); return; }
    s.close(); draw();
  });
}

async function draw() {
  clear(root).append(h('div', { class: 'row' }, h('h1', { class: 'grow', text: 'Areas' }), h('button', { class: 'btn sm', type: 'button', text: '+ Add', onclick: () => areaSheet(null) })),
    h('p', { class: 'muted small', text: 'Customers pick an area to see only nearby partners. Assign each provider an area in the Providers tab.' }));
  const [{ data, error }, counts] = await Promise.all([
    sb.from('areas').select('id,name,sort_order,is_active').order('sort_order').order('name').limit(500),
    sb.rpc('admin_area_counts'),
  ]);
  if (error) { root.append(h('p', { class: 'form-error', text: errMsg(error) })); return; }
  rows = data;
  const n = new Map((counts.data || []).map((r) => [r.area_id, r.providers]));
  const list = h('div', { class: 'list' });
  if (!data.length) list.append(h('div', { class: 'empty', text: 'No areas yet.' }));
  data.forEach((a) => list.append(h('button', { class: 'item btn-reset', type: 'button', onclick: () => areaSheet(a) },
    h('div', { class: 'thumb' }, icon('pin')),
    h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, h('b', { text: a.name })), h('div', { class: 'small muted', text: `${n.get(a.id) || 0} providers` })),
    h('span', { class: `badge ${a.is_active ? 'ok' : 'bad'}`, text: a.is_active ? 'Visible' : 'Hidden' }))));
  root.append(list);
}
export async function render(r) { root = r; await draw(); }
