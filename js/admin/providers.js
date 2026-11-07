import { sb, h, clear, errMsg, busy, toast, confirmDialog, mediaUrl, uploadImage, pct, initialOf } from '../common.js';
import { sheet, field, input, textarea, checkbox, pagedList } from './ui.js';

let list, q = '', cats = [];

function catSelect(selected) {
  const s = h('select', { class: 'input' }, h('option', { value: '', text: '— No category —' }),
    cats.map((c) => h('option', { value: c.id, text: `${c.icon ? c.icon + ' ' : ''}${c.name}${c.is_active ? '' : ' (hidden)'}` })));
  s.value = selected || '';
  return s;
}

function thumb(p) {
  return p.image_path ? h('img', { class: 'thumb', src: mediaUrl(p.image_path), alt: '', loading: 'lazy' }) : h('div', { class: 'thumb', text: initialOf(p.name) });
}

function createSheet() {
  const username = input({ autocapitalize: 'none', spellcheck: 'false', maxlength: 30, placeholder: 'e.g. cafe_one' });
  const password = input({ type: 'text', maxlength: 72, autocomplete: 'off' });
  password.value = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
  const name = input({ maxlength: 80 });
  const disc = input({ type: 'number', min: 0.01, max: 100, step: 0.01, inputmode: 'decimal' });
  const notes = textarea('', { maxlength: 1000, rows: 3 });
  const cat = catSelect('');
  const file = h('input', { type: 'file', accept: 'image/*' });
  const err = h('div', { class: 'form-error' });
  const btn = h('button', { class: 'btn block', type: 'submit', text: 'Create provider' });
  const form = h('form', { class: 'stack' },
    field('Username (login)', username, '3–30 lowercase letters, numbers, _'),
    field('Password', password, 'Share it with the provider. They log in at /partner.html'),
    field('Business name', name), field('Category', cat), field('Discount %', disc), field('Special notes', notes, 'e.g. Offer only valid on Fridays'),
    field('Image / logo', file), err, btn);
  const s = sheet('New provider', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    busy(btn, true, 'Creating…');
    const { data: id, error } = await sb.rpc('admin_create_provider', {
      p_username: username.value.trim().toLowerCase(), p_password: password.value, p_name: name.value.trim(),
      p_discount: Number(disc.value), p_notes: notes.value.trim(),
    });
    if (error) { busy(btn, false); err.textContent = errMsg(error); return; }
    if (cat.value) {
      const { error: ec } = await sb.rpc('admin_update_provider', { p_id: id, p_patch: { category_id: cat.value } });
      if (ec) toast(`Created, but category failed: ${errMsg(ec)}`, 'bad');
    }
    if (file.files[0]) {
      try {
        const path = await uploadImage(`providers/${id}`, file.files[0], 900);
        const { error: e2 } = await sb.rpc('admin_update_provider', { p_id: id, p_patch: { image_path: path } });
        if (e2) throw e2;
      } catch (e3) { toast(`Created, but image failed: ${errMsg(e3)}`, 'bad'); }
    }
    s.close(); toast('Provider created'); list.reset();
  });
}

function editSheet(p) {
  let imagePath = p.image_path;
  const prev = thumb(p); prev.classList.add('preview');
  const file = h('input', { type: 'file', accept: 'image/*' });
  const name = input({ maxlength: 80, value: p.name });
  const disc = input({ type: 'number', min: 0.01, max: 100, step: 0.01, value: pct(p.discount_percent) });
  const notes = textarea(p.notes || '', { maxlength: 1000, rows: 3 });
  const sort = input({ type: 'number', step: 1, value: p.sort_order });
  const cat = catSelect(p.category_id);
  const active = checkbox(p.is_active);
  const err = h('div', { class: 'form-error' });
  const save = h('button', { class: 'btn block', type: 'submit', text: 'Save' });
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    try {
      imagePath = await uploadImage(`providers/${p.id}`, file.files[0], 900);
      const img = h('img', { class: 'preview', src: mediaUrl(imagePath), alt: '' });
      clear(prev.parentElement.querySelector('.slot')).append(img);
    } catch (e) { toast(errMsg(e), 'bad'); }
  });
  const form = h('form', { class: 'stack' },
    h('div', { class: 'img-pick' }, h('div', { class: 'slot' }, prev), file),
    field('Business name', name), field('Category', cat), field('Discount %', disc), field('Special notes', notes),
    field('Sort order (lower shows first)', sort),
    h('label', { class: 'switch' }, h('span', { text: 'Active (visible + can scan)' }), active), err, save);
  const pw = input({ type: 'text', maxlength: 72, placeholder: 'New password (min 8)', autocomplete: 'off' });
  const pwBtn = h('button', { class: 'btn ghost', type: 'button', text: 'Set password' });
  const del = h('button', { class: 'btn block danger', type: 'button', text: 'Delete provider' });
  const s = sheet(p.name, h('p', { class: 'small muted' }, 'Username: ', h('b', { text: p.username })), form,
    h('h2', { text: 'Reset password' }), h('div', { class: 'row' }, h('div', { class: 'grow' }, pw), pwBtn),
    h('div', { class: 'stack' }, h('div'), del));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    busy(save, true);
    const { error } = await sb.rpc('admin_update_provider', { p_id: p.id, p_patch: {
      name: name.value.trim(), discount_percent: Number(disc.value), notes: notes.value.trim(),
      sort_order: Math.trunc(Number(sort.value) || 0), is_active: active.checked, image_path: imagePath, category_id: cat.value,
    } });
    busy(save, false);
    if (error) { err.textContent = errMsg(error); return; }
    if (p.image_path && p.image_path !== imagePath) sb.storage.from('media').remove([p.image_path]).catch(() => {});
    s.close(); toast('Saved'); list.load();
  });
  pwBtn.addEventListener('click', async () => {
    busy(pwBtn, true);
    const { error } = await sb.rpc('admin_set_provider_password', { p_id: p.id, p_password: pw.value });
    busy(pwBtn, false);
    toast(error ? errMsg(error) : 'Password changed', error ? 'bad' : '');
    if (!error) pw.value = '';
  });
  del.addEventListener('click', async () => {
    if (!(await confirmDialog(`Delete "${p.name}" and its login? Its scan history is deleted too.`, 'Delete', true))) return;
    const { error } = await sb.rpc('admin_delete_provider', { p_id: p.id });
    if (error) { toast(errMsg(error), 'bad'); return; }
    if (p.image_path) sb.storage.from('media').remove([p.image_path]).catch(() => {});
    s.close(); toast('Deleted'); list.load();
  });
}

export async function render(root) {
  const { data: cs } = await sb.from('categories').select('id,name,icon,is_active').order('sort_order').order('name').limit(200);
  cats = cs || [];
  const search = input({ type: 'search', placeholder: 'Search name or username', maxlength: 60 });
  let t; search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { q = search.value.trim(); list.reset(); }, 250); });
  root.append(h('div', { class: 'row' }, h('h1', { class: 'grow', text: 'Providers' }), h('button', { class: 'btn sm', type: 'button', text: '+ Add', onclick: createSheet })),
    h('div', { class: 'searchbar' }, search));
  list = pagedList(root, async (offset, limit) => {
    const { data, error } = await sb.rpc('admin_list_providers', { p_search: q, p_limit: limit, p_offset: offset });
    if (error) { toast(errMsg(error), 'bad'); return { rows: [], total: 0 }; }
    return { rows: data, total: data[0]?.total ?? (offset ? null : 0) };
  }, (p) => h('button', { class: 'item btn-reset', type: 'button', onclick: () => editSheet(p) },
    thumb(p),
    h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, h('b', { text: p.name })), h('div', { class: 'small muted', text: `@${p.username} · ${pct(p.discount_percent)}%${p.category_name ? ` · ${p.category_name}` : ''}` })),
    h('span', { class: `badge ${p.is_active ? 'ok' : 'bad'}`, text: p.is_active ? 'Active' : 'Off' })));
  list.load();
}
