import { sb, h, clear, errMsg, busy, toast, confirmDialog, mediaUrl, uploadImage, pct, initialOf, limitsEditor, dayNames, offerWhen } from '../common.js';
import { sheet, field, input, textarea, checkbox, pagedList } from './ui.js';

let list, q = '', cats = [], areas = [];

function areaSelect(selected) {
  const s = h('select', { class: 'input' }, h('option', { value: '', text: '— No area —' }),
    areas.map((a) => h('option', { value: a.id, text: `${a.name}${a.is_active ? '' : ' (hidden)'}` })));
  s.value = selected || '';
  return s;
}
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
  const area = areaSelect('');
  const file = h('input', { type: 'file', accept: 'image/*' });
  const err = h('div', { class: 'form-error' });
  const btn = h('button', { class: 'btn block', type: 'submit', text: 'Create provider' });
  const form = h('form', { class: 'stack' },
    field('Username (login)', username, '3–30 lowercase letters, numbers, _'),
    field('Password', password, 'Share it with the provider. They log in at /partner.html'),
    field('Business name', name), field('Category', cat), field('Area', area), field('Standard discount % (0 = only the offers below)', disc), field('Special notes', notes, 'Extra info. Day/usage limits are set separately (edit the provider after creating).'),
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
    if (cat.value || area.value) {
      const { error: ec } = await sb.rpc('admin_update_provider', { p_id: id, p_patch: { category_id: cat.value, area_id: area.value } });
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

// ---------- branches (admin only; RLS refuses writes from anyone else) ----------
function branchesSection(p) {
  const listEl = h('div', { class: 'stack' });
  const addBtn = h('button', { class: 'btn sm', type: 'button', text: '+ Add branch' });
  const box = h('div', { class: 'card stack' },
    h('div', { class: 'row' }, h('b', { class: 'grow', text: 'Branches' }), addBtn),
    h('p', { class: 'small muted', text: 'Each branch puts this partner under its area in the area filter and shows on the partner page Branches tab.' }),
    listEl);
  async function load() {
    const { data, error } = await sb.from('branches').select('id,area_id,name,address,phone,maps_url,sort_order,is_active,area:areas(name)')
      .eq('provider_id', p.id).order('sort_order').order('name').limit(200);
    clear(listEl);
    if (error) { listEl.append(h('p', { class: 'form-error', text: `Branches unavailable — run update 011. (${errMsg(error)})` })); addBtn.disabled = true; return; }
    if (!data.length) listEl.append(h('p', { class: 'small muted', text: 'No branches yet.' }));
    for (const b of data) {
      listEl.append(h('button', { class: 'item btn-reset branch-item', type: 'button', onclick: () => branchSheet(p, b, load) },
        h('div', { class: 'grow' },
          h('div', { class: 'ellipsis' }, h('b', { text: [b.area?.name, b.name].filter(Boolean).join(' · ') || '(no area)' })),
          h('div', { class: 'small muted ellipsis', text: [b.address, b.phone].filter(Boolean).join(' · ') })),
        h('span', { class: `badge ${b.is_active ? 'ok' : 'bad'}`, text: b.is_active ? 'Shown' : 'Hidden' })));
    }
  }
  addBtn.addEventListener('click', () => branchSheet(p, null, load));
  load();
  return box;
}

function branchSheet(p, b, reload) {
  const area = areaSelect(b?.area_id || '');
  const name = input({ maxlength: 80, value: b?.name || '', placeholder: 'Optional, e.g. Mall branch' });
  const address = textarea(b?.address || '', { maxlength: 300, rows: 2, placeholder: 'Street, building, landmark' });
  const phone = input({ type: 'tel', maxlength: 20, value: b?.phone || '', placeholder: '+20…', inputmode: 'tel' });
  const maps = input({ type: 'url', maxlength: 500, value: b?.maps_url || '', placeholder: 'https://maps.app.goo.gl/…' });
  const sort = input({ type: 'number', step: 1, value: b?.sort_order ?? 0 });
  const active = checkbox(b ? b.is_active : true);
  const err = h('div', { class: 'form-error' });
  const save = h('button', { class: 'btn block', type: 'submit', text: b ? 'Save branch' : 'Add branch' });
  const del = b ? h('button', { class: 'btn block danger', type: 'button', text: 'Delete branch' }) : null;
  const form = h('form', { class: 'stack' },
    field('Area', area), field('Branch name', name), field('Detailed address', address),
    field('Phone', phone), field('Google Maps link', maps, 'Optional. Share → Copy link in Google Maps. Without it the pin searches the address.'),
    field('Sort order', sort), h('label', { class: 'switch' }, h('span', { text: 'Shown to customers' }), active), err, save, del);
  const s = sheet(b ? 'Edit branch' : `New branch · ${p.name}`, form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    const row = {
      area_id: area.value || null, name: name.value.trim(), address: address.value.trim(),
      phone: phone.value.replace(/[^\d+]/g, '') || null, maps_url: maps.value.trim() || null,
      sort_order: Math.trunc(Number(sort.value) || 0), is_active: active.checked,
    };
    if (!row.area_id && !row.address) { err.textContent = 'Pick an area or enter an address.'; return; }
    busy(save, true);
    const { error } = b ? await sb.from('branches').update(row).eq('id', b.id)
      : await sb.from('branches').insert({ ...row, provider_id: p.id });
    busy(save, false);
    if (error) { err.textContent = branchErr(error); return; }
    s.close(); toast(b ? 'Branch saved' : 'Branch added'); reload();
  });
  del?.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete this branch?', 'Delete', true))) return;
    const { error } = await sb.from('branches').delete().eq('id', b.id);
    if (error) { toast(branchErr(error), 'bad'); return; }
    s.close(); toast('Branch deleted'); reload();
  });
}
function branchErr(e) {
  const m = e?.message || '';
  if (/branches_phone|phone/.test(m) && /check/.test(m)) return 'Phone must be 5–15 digits (optionally starting with +).';
  if (/maps_url/.test(m)) return 'Use a Google Maps link (google.com/maps or maps.app.goo.gl).';
  if (/branch_needs_area_or_address/.test(m)) return 'Pick an area or enter an address.';
  return errMsg(e);
}

// ---------- discount offers (admin only; RLS refuses writes from anyone else) ----------
const OFFER_KINDS = { time: 'Time window', first: 'First visit', service: 'Service' };
function offersSection(p) {
  const listEl = h('div', { class: 'stack' });
  const addBtn = h('button', { class: 'btn sm', type: 'button', text: '+ Add offer' });
  const box = h('div', { class: 'card stack' },
    h('div', { class: 'row' }, h('b', { class: 'grow', text: 'Discount offers' }), addBtn),
    h('p', { class: 'small muted', text: 'Extra discounts on top of the standard one: a time window (e.g. 12:00–15:00 50%), a first-visit discount, or a % per service. The scan picks the best time/first-visit discount automatically and lists the services.' }),
    listEl);
  async function load() {
    const { data, error } = await sb.from('discount_rules').select('id,kind,title,percent,start_time,end_time,days,sort_order,is_active')
      .eq('provider_id', p.id).order('kind').order('sort_order').order('percent', { ascending: false }).limit(100);
    clear(listEl);
    if (error) { listEl.append(h('p', { class: 'form-error', text: `Offers unavailable — run update 012. (${errMsg(error)})` })); addBtn.disabled = true; return; }
    if (!data.length) listEl.append(h('p', { class: 'small muted', text: 'No offers — only the standard discount applies.' }));
    for (const r of data) {
      const sub = r.kind === 'time' ? offerWhen(r) : r.kind === 'first' ? 'On the member\'s first visit' : 'Shown at checkout';
      listEl.append(h('button', { class: 'item btn-reset offer-item', type: 'button', onclick: () => offerSheet(p, r, load) },
        h('span', { class: 'offer-pct', text: `${pct(r.percent)}%` }),
        h('div', { class: 'grow' },
          h('div', { class: 'ellipsis' }, h('b', { text: `${OFFER_KINDS[r.kind]}${r.title ? ` · ${r.title}` : ''}` })),
          h('div', { class: 'small muted ellipsis', text: sub })),
        h('span', { class: `badge ${r.is_active ? 'ok' : 'bad'}`, text: r.is_active ? 'On' : 'Off' })));
    }
  }
  addBtn.addEventListener('click', () => offerSheet(p, null, load));
  load();
  return box;
}

function offerSheet(p, r, reload) {
  const kind = h('select', { class: 'input' }, Object.entries(OFFER_KINDS).map(([v, t]) => h('option', { value: v, text: t })));
  kind.value = r?.kind || 'time';
  const title = input({ maxlength: 80, value: r?.title || '' });
  const percent = input({ type: 'number', min: 0.01, max: 100, step: 0.01, value: r ? pct(r.percent) : '' });
  const from = input({ type: 'time', value: (r?.start_time || '12:00').slice(0, 5) });
  const to = input({ type: 'time', value: (r?.end_time || '15:00').slice(0, 5) });
  const names = dayNames(true);
  const dayBoxes = names.map((n, i) => { const c = checkbox(!r?.days || r.days.includes(i)); c.dataset.day = i; return h('label', { class: 'day-pick' }, c, h('span', { text: n })); });
  const sort = input({ type: 'number', step: 1, value: r?.sort_order ?? 0 });
  const active = checkbox(r ? r.is_active : true);
  const timeBox = h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('div', { class: 'grow' }, field('From', from)), h('div', { class: 'grow' }, field('To', to))),
    h('small', { class: 'muted', text: 'Egypt time. If "To" is earlier than "From" the window runs past midnight.' }),
    h('div', { class: 'field' }, h('span', { text: 'Days' }), h('div', { class: 'day-picks' }, dayBoxes)));
  const titleField = field('Name', title);
  const err = h('div', { class: 'form-error' });
  const save = h('button', { class: 'btn block', type: 'submit', text: r ? 'Save offer' : 'Add offer' });
  const del = r ? h('button', { class: 'btn block danger', type: 'button', text: 'Delete offer' }) : null;
  const sync = () => {
    timeBox.hidden = kind.value !== 'time';
    titleField.querySelector('span').textContent = kind.value === 'service' ? 'Service name (required)' : 'Label (optional, e.g. Lunch hours)';
    title.placeholder = kind.value === 'service' ? 'e.g. Initial assessment' : '';
  };
  kind.addEventListener('change', sync); sync();
  const form = h('form', { class: 'stack' }, field('Type', kind), titleField, field('Discount %', percent), timeBox,
    field('Sort order', sort), h('label', { class: 'switch' }, h('span', { text: 'Active' }), active), err, save, del);
  const s = sheet(r ? 'Edit offer' : `New offer · ${p.name}`, form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    const k = kind.value;
    const days = dayBoxes.map((l) => l.querySelector('input')).filter((c) => c.checked).map((c) => Number(c.dataset.day));
    const v = Number(percent.value);
    if (k === 'service' && !title.value.trim()) { err.textContent = 'Enter the service name.'; return; }
    if (!(v > 0 && v <= 100)) { err.textContent = 'Enter a discount between 0.01 and 100.'; return; }
    if (k === 'time' && (!from.value || !to.value || from.value === to.value)) { err.textContent = 'Pick two different times.'; return; }
    if (k === 'time' && !days.length) { err.textContent = 'Pick at least one day.'; return; }
    const row = {
      kind: k, title: title.value.trim(), percent: v, sort_order: Math.trunc(Number(sort.value) || 0), is_active: active.checked,
      start_time: k === 'time' ? from.value : null, end_time: k === 'time' ? to.value : null,
      days: k === 'time' && days.length < 7 ? days : null,
    };
    busy(save, true);
    const { error } = r ? await sb.from('discount_rules').update(row).eq('id', r.id)
      : await sb.from('discount_rules').insert({ ...row, provider_id: p.id });
    busy(save, false);
    if (error) { err.textContent = /discount_rules_one_first|duplicate/.test(error.message || '') ? 'This partner already has a first-visit offer.' : errMsg(error); return; }
    s.close(); toast(r ? 'Offer saved' : 'Offer added'); reload(); list.load();
  });
  del?.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete this offer?', 'Delete', true))) return;
    const { error } = await sb.from('discount_rules').delete().eq('id', r.id);
    if (error) { toast(errMsg(error), 'bad'); return; }
    s.close(); toast('Offer deleted'); reload(); list.load();
  });
}

async function editSheet(p0) {
  const { data: lim } = await sb.from('providers').select('limit_count,limit_period,allowed_days,area_id').eq('id', p0.id).maybeSingle();
  const p = { ...p0, ...(lim || {}) };
  const limits = limitsEditor(p);
  let imagePath = p.image_path;
  const prev = thumb(p); prev.classList.add('preview');
  const file = h('input', { type: 'file', accept: 'image/*' });
  const name = input({ maxlength: 80, value: p.name });
  const disc = input({ type: 'number', min: 0, max: 100, step: 0.01, value: pct(p.discount_percent) });
  const notes = textarea(p.notes || '', { maxlength: 1000, rows: 3 });
  const sort = input({ type: 'number', step: 1, value: p.sort_order });
  const cat = catSelect(p.category_id);
  const area = areaSelect(p.area_id);
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
    field('Business name', name), field('Category', cat), field('Area', area), field('Discount %', disc), field('Special notes', notes),
    h('div', { class: 'card stack' }, h('b', { text: 'Usage limits' }), limits.el),
    field('Sort order (lower shows first)', sort),
    h('label', { class: 'switch' }, h('span', { text: 'Active (visible + can scan)' }), active), err, save);
  const pw = input({ type: 'text', maxlength: 72, placeholder: 'New password (min 8)', autocomplete: 'off' });
  const pwBtn = h('button', { class: 'btn ghost', type: 'button', text: 'Set password' });
  const del = h('button', { class: 'btn block danger', type: 'button', text: 'Delete provider' });
  const s = sheet(p.name, h('p', { class: 'small muted' }, 'Username: ', h('b', { text: p.username })), form, offersSection(p), branchesSection(p),
    h('h2', { text: 'Reset password' }), h('div', { class: 'row' }, h('div', { class: 'grow' }, pw), pwBtn),
    h('div', { class: 'stack' }, h('div'), del));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    busy(save, true);
    const { error } = await sb.rpc('admin_update_provider', { p_id: p.id, p_patch: {
      name: name.value.trim(), discount_percent: Number(disc.value), notes: notes.value.trim(),
      sort_order: Math.trunc(Number(sort.value) || 0), is_active: active.checked, image_path: imagePath, category_id: cat.value, area_id: area.value, ...limits.value(),
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
  const { data: as } = await sb.from('areas').select('id,name,is_active').order('sort_order').order('name').limit(500);
  areas = as || [];
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
