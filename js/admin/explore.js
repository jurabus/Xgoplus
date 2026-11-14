// Explore ads: posts from non-partner businesses, shown to members whose
// interest in the ad's category is high enough (see Interests tab).
import { sb, h, clear, errMsg, busy, toast, confirmDialog, mediaUrl, uploadImage, pct, fmtDate, bustSettingsCache, initialOf } from '../common.js';
import { sheet, field, input, textarea, checkbox } from './ui.js';

let root, cats = [], settings = {};

const toLocal = (iso) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocal = (v) => (v ? new Date(v).toISOString() : null);

function status(a) {
  const now = Date.now();
  if (!a.is_active) return ['bad', 'Hidden'];
  if (a.starts_at && new Date(a.starts_at) > now) return ['warn', 'Scheduled'];
  if (a.ends_at && new Date(a.ends_at) <= now) return ['bad', 'Ended'];
  return ['ok', 'Live'];
}

function imagePicker(path, prefix, maxW, label) {
  let value = path;
  const slot = h('div', {}, value ? h('img', { class: 'preview', src: mediaUrl(value), alt: '' }) : h('div', { class: 'preview thumb', text: '+' }));
  const file = h('input', { type: 'file', accept: 'image/*' });
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    try {
      value = await uploadImage(prefix, file.files[0], maxW);
      clear(slot).append(h('img', { class: 'preview', src: mediaUrl(value), alt: '' }));
    } catch (e) { toast(errMsg(e), 'bad'); }
  });
  return { el: h('div', { class: 'field' }, h('span', { text: label }), h('div', { class: 'img-pick' }, slot, file)), get: () => value };
}

function adSheet(a) {
  const isNew = !a;
  a = a || { advertiser: '', body: '', link_url: '', cta_label: '', category_id: '', min_pct: null, show_to_all: false, starts_at: null, ends_at: null, sort_order: 0, is_active: true };
  const img = imagePicker(a.image_path, 'explore', 1600, 'Ad image (large, e.g. 1080×1080 or 1080×1350)');
  const logo = imagePicker(a.logo_path, 'explore', 300, 'Advertiser logo (optional)');
  const advertiser = input({ maxlength: 80, value: a.advertiser, placeholder: 'Business name' });
  const body = textarea(a.body || '', { maxlength: 2000, rows: 5, placeholder: 'Ad text' });
  const link = input({ type: 'url', maxlength: 500, value: a.link_url || '', placeholder: 'https://… (optional)' });
  const cta = input({ maxlength: 30, value: a.cta_label || '', placeholder: 'Visit us' });
  const cat = h('select', { class: 'input' }, h('option', { value: '', text: '— Choose category —' }),
    cats.map((c) => h('option', { value: c.id, text: `${c.name}${c.is_active ? '' : ' (hidden)'}` })));
  cat.value = a.category_id || '';
  const minPct = input({ type: 'number', min: 0, max: 100, step: 1, value: a.min_pct ?? '', placeholder: `${pct(settings.min_pct)} (default)` });
  const all = checkbox(a.show_to_all);
  const starts = input({ type: 'datetime-local', value: toLocal(a.starts_at) });
  const ends = input({ type: 'datetime-local', value: toLocal(a.ends_at) });
  const sort = input({ type: 'number', step: 1, value: a.sort_order });
  const active = checkbox(a.is_active);
  const reach = h('div', { class: 'card small' });
  const err = h('div', { class: 'form-error' });
  const save = h('button', { class: 'btn block', type: 'submit', text: isNew ? 'Publish ad' : 'Save' });
  const del = isNew ? null : h('button', { class: 'btn block danger', type: 'button', text: 'Delete ad' });
  let t;
  const estimate = () => {
    clearTimeout(t);
    if (!cat.value) { reach.textContent = 'Pick a category to see how many members this ad reaches.'; return; }
    t = setTimeout(async () => {
      const m = minPct.value === '' ? null : Number(minPct.value);
      const { data, error } = await sb.rpc('admin_ad_audience', { p_category: cat.value, p_min_pct: m });
      reach.textContent = error ? errMsg(error)
        : `Reaches ${data ?? 0} member${data === 1 ? '' : 's'} with ≥ ${pct(m ?? settings.min_pct)}% interest in this category${all.checked ? ' first, then everyone else' : ''}.`;
    }, 250);
  };
  [cat, minPct].forEach((x) => x.addEventListener('input', estimate)); all.addEventListener('change', estimate);
  estimate();
  const form = h('form', { class: 'stack' },
    img.el, field('Advertiser name', advertiser), logo.el, field('Text', body),
    field('Link for the button', link, 'Must start with https://. Leave empty for no button.'), field('Button label', cta),
    h('h2', { text: 'Targeting' }),
    field('Category', cat), field('Minimum interest %', minPct, 'Members whose scans in this category are at least this share of all their scans. Empty = default.'),
    h('label', { class: 'switch' }, h('span', {}, h('b', { text: 'Also show to everyone else' }), h('br'), h('small', { class: 'muted', text: 'After the targeted ads, to all members and visitors' })), all),
    reach,
    h('h2', { text: 'Schedule' }),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Start (optional)', starts)), h('div', { class: 'grow' }, field('End (optional)', ends))),
    field('Sort order (lower shows first)', sort),
    h('label', { class: 'switch' }, h('span', { text: 'Active' }), active), err, save, del);
  const s = sheet(isNew ? 'New Explore ad' : 'Edit ad', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    const l = link.value.trim();
    if (!img.get()) { err.textContent = 'Add the ad image.'; return; }
    if (!advertiser.value.trim()) { err.textContent = 'Enter the advertiser name.'; return; }
    if (!cat.value) { err.textContent = 'Choose a category.'; return; }
    if (l && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(l)) { err.textContent = 'The link must start with https://'; return; }
    if (starts.value && ends.value && new Date(ends.value) <= new Date(starts.value)) { err.textContent = 'End must be after start.'; return; }
    const row = {
      image_path: img.get(), logo_path: logo.get() || null, advertiser: advertiser.value.trim(), body: body.value.trim(),
      link_url: l || null, cta_label: cta.value.trim(), category_id: cat.value,
      min_pct: minPct.value === '' ? null : Math.min(100, Math.max(0, Number(minPct.value))), show_to_all: all.checked,
      starts_at: fromLocal(starts.value), ends_at: fromLocal(ends.value), sort_order: Math.trunc(Number(sort.value) || 0), is_active: active.checked,
    };
    busy(save, true);
    const { error } = isNew ? await sb.from('explore_ads').insert(row) : await sb.from('explore_ads').update(row).eq('id', a.id);
    busy(save, false);
    if (error) { err.textContent = errMsg(error); return; }
    const old = [a.image_path, a.logo_path].filter((p) => p && p !== row.image_path && p !== row.logo_path);
    if (!isNew && old.length) sb.storage.from('media').remove(old).catch(() => {});
    s.close(); toast(isNew ? 'Ad published' : 'Saved'); draw();
  });
  del?.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete this ad and its results?', 'Delete', true))) return;
    const { error } = await sb.from('explore_ads').delete().eq('id', a.id);
    if (error) { toast(errMsg(error), 'bad'); return; }
    sb.storage.from('media').remove([a.image_path, a.logo_path].filter(Boolean)).catch(() => {});
    s.close(); draw();
  });
}

function targetingCard(row) {
  const enabled = new Set(row.data?.app_enabled_modules || []);
  const disabled = new Set(row.data?.app_disabled_modules || []);
  const on = checkbox(enabled.has('explore') && !disabled.has('explore'));
  const minPct = input({ type: 'number', min: 0, max: 100, step: 1, value: settings.min_pct });
  const minScans = input({ type: 'number', min: 1, max: 1000, step: 1, value: settings.min_scans });
  const save = h('button', { class: 'btn block', type: 'button', text: 'Save' });
  save.addEventListener('click', async () => {
    const en = new Set(enabled); const dis = new Set(disabled);
    if (on.checked) { en.add('explore'); dis.delete('explore'); } else en.delete('explore');
    const data = { ...row.data, app_enabled_modules: [...en], app_disabled_modules: [...dis],
      explore_min_pct: Math.min(100, Math.max(0, Number(minPct.value) || 0)), explore_min_scans: Math.max(1, Math.trunc(Number(minScans.value) || 1)) };
    busy(save, true);
    const { error } = await sb.from('settings').update({ data }).eq('id', 1);
    busy(save, false);
    if (error) { toast(errMsg(error), 'bad'); return; }
    bustSettingsCache(); toast('Saved'); draw();
  });
  return h('div', { class: 'card stack' },
    h('label', { class: 'switch' }, h('span', {}, h('b', { text: 'Explore tab on the website' }), h('br'), h('small', { class: 'muted', text: 'Off = the tab is hidden and no ads are shown' })), on),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Default minimum interest %', minPct)), h('div', { class: 'grow' }, field('Minimum lifetime scans', minScans))),
    h('small', { class: 'muted', text: 'A member counts as interested in a category when at least this % of their scans are in it and they have at least this many scans in total. Each ad can use its own %.' }),
    save);
}

async function draw() {
  clear(root).append(h('div', { class: 'row' }, h('h1', { class: 'grow', text: 'Explore ads' }), h('button', { class: 'btn sm', type: 'button', text: '+ New ad', onclick: () => adSheet(null) })),
    h('p', { class: 'muted small', text: 'Ads for businesses that aren\'t partners, shown in the Explore tab to the members most interested in the ad\'s category.' }));
  const [setRes, catRes, adRes, statRes] = await Promise.all([
    sb.from('settings').select('data').eq('id', 1).single(),
    sb.from('categories').select('id,name,icon,is_active').order('sort_order').order('name'),
    sb.from('explore_ads').select('*').order('is_active', { ascending: false }).order('sort_order').order('created_at', { ascending: false }).limit(200),
    sb.rpc('admin_explore_stats'),
  ]);
  if (adRes.error) { root.append(h('p', { class: 'form-error', text: `${errMsg(adRes.error)} — run update 013.` })); return; }
  cats = catRes.data || [];
  settings = { min_pct: Number(setRes.data?.data?.explore_min_pct ?? 40), min_scans: Number(setRes.data?.data?.explore_min_scans ?? 1) };
  const stats = Object.fromEntries((statRes.data || []).map((x) => [x.ad_id, x]));
  root.append(h('h2', { text: 'Targeting' }), targetingCard(setRes.data || { data: {} }), h('h2', { text: 'Ads' }));
  const list = h('div', { class: 'list' });
  if (!adRes.data.length) list.append(h('div', { class: 'empty', text: 'No ads yet.' }));
  for (const a of adRes.data) {
    const st = stats[a.id] || { views: 0, reach: 0, clicks: 0, audience: 0 };
    const [cls, label] = status(a);
    const catName = cats.find((c) => c.id === a.category_id)?.name || 'No category';
    const ctr = st.reach ? `${pct((100 * st.clicks) / st.reach)}%` : '–';
    list.append(h('button', { class: 'item btn-reset ad-item', type: 'button', onclick: () => adSheet(a) },
      a.image_path ? h('img', { class: 'thumb', src: mediaUrl(a.image_path), alt: '' }) : h('div', { class: 'thumb', text: initialOf(a.advertiser) }),
      h('div', { class: 'grow' },
        h('div', { class: 'ellipsis' }, h('b', { text: a.advertiser })),
        h('div', { class: 'small muted ellipsis', text: `${catName} · ≥ ${pct(a.min_pct ?? settings.min_pct)}%${a.show_to_all ? ' + everyone' : ''} · audience ${st.audience}` }),
        h('div', { class: 'small ellipsis', text: `${st.reach} reached · ${st.views} views · ${st.clicks} clicks · CTR ${ctr}${a.ends_at ? ` · ends ${fmtDate(a.ends_at)}` : ''}` })),
      h('span', { class: `badge ${cls}`, text: label })));
  }
  root.append(list);
}

export async function render(r) { root = r; await draw(); }
