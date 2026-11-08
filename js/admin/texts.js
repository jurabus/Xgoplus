// Every customer-facing text/setting, generated from the defaults file.
import { sb, h, clear, errMsg, busy, toast, DEFAULTS, loadSettings, bustSettingsCache, mediaUrl, uploadImage } from '../common.js';
import { field, input, textarea, checkbox } from './ui.js';

const GROUPS = [
  ['General', /^(site_title|tagline|text_direction|footer_text)/],
  ['Home hero & sections', /^(hero_|top_deals|view_all|all_categories|offers_title|membership_promo|area_)/],
  ['About & contact', /^(about_|contact_)/],
  ['Install-app popup', /^install_/],
  ['Home & partner page', /^(home_|off_suffix|provider_|categor)/],
  ['Search', /^search_/],
  ['Navigation', /^nav_/],
  ['Log in & sign up', /^(login_|signup_|phone_|password_|first_name|last_name)/],
  ['Membership', /^(membership_|qr_)/],
  ['Payment (InstaPay / Vodafone Cash)', /^pay_/],
  ['Partner portal & scanner', /^(partner_|username_|scan_|limits_)/],
  ['Usage rules', /^(rules_|rule_|period_|day_|usage_)/],
  ['History, password, reports', /^(history_|password_|current_password|new_password|report_|my_reports|complaint_|status_|nav_report|nav_history)/],
  ['Filters', /^discount_/],
];
const SKIP = new Set(['app_disabled_modules', 'membership_free', 'membership_price_egp', 'membership_renew_window_days']);
const label = (k) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export async function render(root) {
  const current = await loadSettings({ fresh: true });
  const { data: row } = await sb.from('settings').select('data').eq('id', 1).single();
  const stored = row?.data || {};
  const controls = {};
  let logoPath = stored.logo_path || '';

  const logoSlot = h('div', {}, logoPath ? h('img', { class: 'preview', src: mediaUrl(logoPath), alt: '' }) : h('div', { class: 'preview thumb', text: 'Logo' }));
  const logoFile = h('input', { type: 'file', accept: 'image/*' });
  const logoClear = h('button', { class: 'btn sm light', type: 'button', text: 'Use text logo', onclick: () => { logoPath = ''; clear(logoSlot).append(h('div', { class: 'preview thumb', text: 'Logo' })); } });
  logoFile.addEventListener('change', async () => {
    if (!logoFile.files[0]) return;
    try { logoPath = await uploadImage('settings', logoFile.files[0], 600); clear(logoSlot).append(h('img', { class: 'preview', src: mediaUrl(logoPath), alt: '' })); }
    catch (e) { toast(errMsg(e), 'bad'); }
  });

  let heroPath = stored.hero_image_path || '';
  const heroSlot = h('div', {}, h('img', { class: 'preview', src: heroPath ? mediaUrl(heroPath) : '/img/hero.webp', alt: '' }));
  const heroFile = h('input', { type: 'file', accept: 'image/*' });
  const heroClear = h('button', { class: 'btn sm light', type: 'button', text: 'Use default art', onclick: () => { heroPath = ''; clear(heroSlot).append(h('img', { class: 'preview', src: '/img/hero.webp', alt: '' })); } });
  heroFile.addEventListener('change', async () => {
    if (!heroFile.files[0]) return;
    try { heroPath = await uploadImage('settings', heroFile.files[0], 1600); clear(heroSlot).append(h('img', { class: 'preview', src: mediaUrl(heroPath), alt: '' })); }
    catch (e) { toast(errMsg(e), 'bad'); }
  });
  const form = h('form', { class: 'stack' });
  form.append(h('div', { class: 'card stack' }, h('b', { text: 'Logo' }), h('small', { class: 'muted', text: 'Upload your logo (PNG with transparent background works best), or keep the built-in XGo plus logo.' }),
    h('div', { class: 'img-pick' }, logoSlot, h('div', { class: 'stack' }, logoFile, logoClear))));
  form.append(h('div', { class: 'card stack' }, h('b', { text: 'Home hero image' }), h('small', { class: 'muted', text: 'Shown next to the headline on the home page. Wide image, about 1300×780.' }),
    h('div', { class: 'img-pick' }, heroSlot, h('div', { class: 'stack' }, heroFile, heroClear))));
  const keys = Object.keys(DEFAULTS).filter((k) => !SKIP.has(k));
  const used = new Set();
  for (const [title, re] of [...GROUPS, ['Other', /.*/]]) {
    const ks = keys.filter((k) => !used.has(k) && re.test(k));
    if (!ks.length) continue;
    const card = h('div', { class: 'card stack' }, h('b', { text: title }));
    for (const k of ks) {
      used.add(k);
      const def = DEFAULTS[k], val = current[k];
      let el;
      if (k === 'text_direction') {
        el = h('select', { class: 'input' }, h('option', { value: 'ltr', text: 'Left to right (English)' }), h('option', { value: 'rtl', text: 'Right to left (Arabic)' }));
        el.value = val === 'rtl' ? 'rtl' : 'ltr';
      } else if (Array.isArray(def)) {
        el = textarea((Array.isArray(val) ? val : def).join('\n'), { rows: Math.max(3, def.length + 1), maxlength: 2000 });
      } else if (typeof def === 'boolean') el = checkbox(val);
      else if (typeof def === 'number') el = input({ type: 'number', step: 'any', value: val });
      else if (String(def).includes('\n') || String(def).length > 60) el = textarea(val ?? '', { rows: 3, maxlength: 2000 });
      else el = input({ value: val ?? '', maxlength: 300, placeholder: def });
      controls[k] = el;
      const hint = Array.isArray(def) ? 'One per line' : (String(def) && val !== def ? `Default: ${def}` : null);
      card.append(typeof def === 'boolean' ? h('label', { class: 'switch' }, h('span', { text: label(k) }), el) : field(label(k), el, hint));
    }
    form.append(card);
  }
  const save = h('button', { class: 'btn block', type: 'submit', text: 'Save all texts' });
  form.append(save);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = { ...stored };
    for (const [k, el] of Object.entries(controls)) {
      const def = DEFAULTS[k];
      let v = typeof def === 'boolean' ? el.checked : typeof def === 'number' ? Number(el.value) : el.value;
      if (Array.isArray(def)) {
        v = el.value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 20);
        if (!v.length || JSON.stringify(v) === JSON.stringify(def)) delete data[k]; else data[k] = v;
        continue;
      }
      if (typeof def === 'number' && !Number.isFinite(v)) v = def;
      if (typeof v === 'string') v = v.trim();
      if (v === def || v === '') delete data[k]; else data[k] = v;
    }
    if (logoPath) data.logo_path = logoPath; else delete data.logo_path;
    if (heroPath) data.hero_image_path = heroPath; else delete data.hero_image_path;
    busy(save, true);
    const { error } = await sb.from('settings').update({ data, updated_at: new Date().toISOString() }).eq('id', 1);
    busy(save, false);
    if (error) { toast(errMsg(error), 'bad'); return; }
    bustSettingsCache();
    toast('Saved — visible to everyone within a few minutes');
  });
  root.append(h('h1', { text: 'Texts & settings' }), h('p', { class: 'muted small', text: 'Leave a field empty to use the default.' }), form);
}
