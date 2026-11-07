// Partner categories (filter chips on the home + search pages).
import { sb, h, clear, errMsg, busy, toast, confirmDialog, mediaUrl, uploadImage } from '../common.js';
import { sheet, field, input, checkbox } from './ui.js';

let root;

function catSheet(c, nextSort) {
  const isNew = !c;
  c = c || { name: '', icon: '', image_path: null, sort_order: nextSort, is_active: true };
  let imagePath = c.image_path;
  const slot = h('div', {}, imagePath ? h('img', { class: 'preview', src: mediaUrl(imagePath), alt: '' }) : h('div', { class: 'preview thumb', text: c.icon || '+' }));
  const file = h('input', { type: 'file', accept: 'image/*' });
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    try { imagePath = await uploadImage('categories', file.files[0], 400); clear(slot).append(h('img', { class: 'preview', src: mediaUrl(imagePath), alt: '' })); }
    catch (e) { toast(errMsg(e), 'bad'); }
  });
  const name = input({ maxlength: 60, value: c.name, placeholder: 'e.g. Cafés' });
  const ic = input({ maxlength: 8, value: c.icon, placeholder: 'Emoji, e.g. ☕' });
  const sort = input({ type: 'number', step: 1, value: c.sort_order });
  const active = checkbox(c.is_active);
  const err = h('div', { class: 'form-error' });
  const save = h('button', { class: 'btn block', type: 'submit', text: 'Save' });
  const del = isNew ? null : h('button', { class: 'btn block danger', type: 'button', text: 'Delete category' });
  const form = h('form', { class: 'stack' },
    field('Name', name), field('Icon (emoji, shown on the filter chip)', ic),
    h('div', { class: 'img-pick' }, slot, file), h('small', { class: 'muted', text: 'Image is optional (used in future category pages).' }),
    field('Sort order (lower shows first)', sort),
    h('label', { class: 'switch' }, h('span', { text: 'Visible' }), active), err, save, del);
  const s = sheet(isNew ? 'New category' : 'Edit category', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    if (!name.value.trim()) { err.textContent = 'Enter a name.'; return; }
    const row = { name: name.value.trim(), icon: ic.value.trim(), image_path: imagePath, sort_order: Math.trunc(Number(sort.value) || 0), is_active: active.checked };
    busy(save, true);
    const { error } = isNew ? await sb.from('categories').insert(row) : await sb.from('categories').update(row).eq('id', c.id);
    busy(save, false);
    if (error) { err.textContent = errMsg(error); return; }
    if (!isNew && c.image_path && c.image_path !== imagePath) sb.storage.from('media').remove([c.image_path]).catch(() => {});
    s.close(); toast('Saved'); draw();
  });
  del?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Delete "${c.name}"? Its partners stay, just without a category.`, 'Delete', true))) return;
    const { error } = await sb.from('categories').delete().eq('id', c.id);
    if (error) { toast(errMsg(error), 'bad'); return; }
    if (c.image_path) sb.storage.from('media').remove([c.image_path]).catch(() => {});
    s.close(); draw();
  });
}

async function move(list, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  const a = list[i], b = list[j];
  // re-number everything so the order is always clean (10, 20, 30…)
  const order = list.slice(); order[i] = b; order[j] = a;
  const updates = order.map((c, k) => sb.from('categories').update({ sort_order: (k + 1) * 10 }).eq('id', c.id));
  const res = await Promise.all(updates);
  const bad = res.find((r) => r.error);
  if (bad) toast(errMsg(bad.error), 'bad');
  draw();
}

async function draw() {
  clear(root).append(h('div', { class: 'row' }, h('h1', { class: 'grow', text: 'Categories' }), h('button', { class: 'btn sm', type: 'button', text: '+ Add', onclick: () => catSheet(null, (rows.at(-1)?.sort_order || 0) + 10) })),
    h('p', { class: 'muted small', text: 'Shown as filter chips on the home and search pages. Assign a category to each provider in the Providers tab.' }));
  const [{ data, error }, counts] = await Promise.all([
    sb.from('categories').select('id,name,icon,image_path,sort_order,is_active').order('sort_order').order('name').limit(200),
    sb.rpc('admin_category_counts'),
  ]);
  if (error) { root.append(h('p', { class: 'form-error', text: errMsg(error) })); return; }
  rows = data;
  const n = new Map((counts.data || []).map((r) => [r.category_id, r.providers]));
  const list = h('div', { class: 'list' });
  if (!data.length) list.append(h('div', { class: 'empty', text: 'No categories yet.' }));
  data.forEach((c, i) => list.append(h('div', { class: 'item' },
    h('button', { class: 'btn-reset row grow', type: 'button', onclick: () => catSheet(c) },
      c.image_path ? h('img', { class: 'thumb', src: mediaUrl(c.image_path), alt: '' }) : h('div', { class: 'thumb', text: c.icon || c.name[0] }),
      h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, h('b', { text: c.name })), h('div', { class: 'small muted', text: `${n.get(c.id) || 0} providers${c.is_active ? '' : ' · hidden'}` }))),
    h('button', { class: 'btn sm light', type: 'button', 'aria-label': 'Move up', text: '↑', disabled: i === 0, onclick: () => move(data, i, -1) }),
    h('button', { class: 'btn sm light', type: 'button', 'aria-label': 'Move down', text: '↓', disabled: i === data.length - 1, onclick: () => move(data, i, 1) }))));
  root.append(list);
}
let rows = [];
export async function render(r) { root = r; await draw(); }
