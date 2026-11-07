import { sb, h, clear, errMsg, busy, toast, confirmDialog, mediaUrl, uploadImage } from '../common.js';
import { sheet, field, input, checkbox } from './ui.js';

let root;

function bannerSheet(b) {
  const isNew = !b;
  b = b || { title: '', subtitle: '', link_url: '', sort_order: 0, is_active: true, image_path: null };
  let imagePath = b.image_path;
  const slot = h('div', {}, imagePath ? h('img', { class: 'preview', src: mediaUrl(imagePath), alt: '' }) : h('div', { class: 'preview thumb', text: '+' }));
  const file = h('input', { type: 'file', accept: 'image/*' });
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    try {
      imagePath = await uploadImage('banners', file.files[0], 1600);
      clear(slot).append(h('img', { class: 'preview', src: mediaUrl(imagePath), alt: '' }));
    } catch (e) { toast(errMsg(e), 'bad'); }
  });
  const title = input({ maxlength: 120, value: b.title });
  const subtitle = input({ maxlength: 240, value: b.subtitle });
  const link = input({ maxlength: 500, value: b.link_url || '', placeholder: 'https://… or /provider.html?id=…' });
  const sort = input({ type: 'number', step: 1, value: b.sort_order });
  const active = checkbox(b.is_active);
  const err = h('div', { class: 'form-error' });
  const save = h('button', { class: 'btn block', type: 'submit', text: 'Save' });
  const del = isNew ? null : h('button', { class: 'btn block danger', type: 'button', text: 'Delete banner' });
  const form = h('form', { class: 'stack' },
    h('div', { class: 'img-pick' }, slot, file), h('small', { class: 'muted', text: 'Wide image works best (e.g. 1600×700).' }),
    field('Title', title), field('Subtitle', subtitle), field('Link (optional)', link), field('Sort order', sort),
    h('label', { class: 'switch' }, h('span', { text: 'Visible' }), active), err, save, del);
  const s = sheet(isNew ? 'New banner' : 'Edit banner', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    const l = link.value.trim();
    if (l && !/^(https:\/\/|\/[^/])/.test(l)) { err.textContent = 'Link must start with https:// or /'; return; }
    const row = { title: title.value.trim(), subtitle: subtitle.value.trim(), link_url: l || null, sort_order: Math.trunc(Number(sort.value) || 0), is_active: active.checked, image_path: imagePath };
    busy(save, true);
    const { error } = isNew ? await sb.from('banners').insert(row) : await sb.from('banners').update(row).eq('id', b.id);
    busy(save, false);
    if (error) { err.textContent = errMsg(error); return; }
    if (!isNew && b.image_path && b.image_path !== imagePath) sb.storage.from('media').remove([b.image_path]).catch(() => {});
    s.close(); toast('Saved'); draw();
  });
  del?.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete this banner?', 'Delete', true))) return;
    const { error } = await sb.from('banners').delete().eq('id', b.id);
    if (error) { toast(errMsg(error), 'bad'); return; }
    if (b.image_path) sb.storage.from('media').remove([b.image_path]).catch(() => {});
    s.close(); draw();
  });
}

async function draw() {
  clear(root).append(h('div', { class: 'row' }, h('h1', { class: 'grow', text: 'Banners' }), h('button', { class: 'btn sm', type: 'button', text: '+ Add', onclick: () => bannerSheet(null) })),
    h('p', { class: 'muted small', text: 'Shown at the top of the home page.' }));
  const { data, error } = await sb.from('banners').select('*').order('sort_order').order('created_at').limit(100);
  if (error) { root.append(h('p', { class: 'form-error', text: errMsg(error) })); return; }
  const list = h('div', { class: 'list' });
  if (!data.length) list.append(h('div', { class: 'empty', text: 'No banners yet.' }));
  data.forEach((b) => list.append(h('button', { class: 'item btn-reset', type: 'button', onclick: () => bannerSheet(b) },
    b.image_path ? h('img', { class: 'thumb', src: mediaUrl(b.image_path), alt: '' }) : h('div', { class: 'thumb', text: '▭' }),
    h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, h('b', { text: b.title || '(no title)' })), h('div', { class: 'small muted ellipsis', text: b.subtitle })),
    h('span', { class: `badge ${b.is_active ? 'ok' : 'bad'}`, text: b.is_active ? 'Visible' : 'Hidden' }))));
  root.append(list);
}

export async function render(r) { root = r; await draw(); }
