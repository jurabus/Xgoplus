// Switch website modules on/off remotely (settings.app_disabled_modules).
// Core modules can't be disabled.
import { sb, h, errMsg, busy, toast, bustSettingsCache } from '../common.js';

export const MODULES = [
  { id: 'providers', title: 'Partners list', core: true },
  { id: 'account', title: 'Account & login', core: true },
  { id: 'membership', title: 'Customer membership + QR', core: false },
  { id: 'scanner', title: 'Provider QR scanner', core: false },
  { id: 'provider-profile', title: 'Provider profile editing', core: false },
  { id: 'scan-history', title: 'Customer scan history', core: false },
  { id: 'complaints', title: 'Customer reports (complaints)', core: false },
  { id: 'referrals', title: 'Invite & earn (referral wallet + cash-outs)', core: false },
  { id: 'explore', title: 'Explore (targeted ads)', core: false, optIn: true },
  // stored as settings.autopay_enabled (the server reads it); off = screenshot + manual approval within 24 h
  { id: 'autopay', title: 'Automatic payments (Android SMS listener)', core: false, setting: 'autopay_enabled',
    hint: 'Off = members upload a screenshot and you approve within 24 h. Switch on after the listener app is installed and paired (Payments tab).' },
];

export async function render(root) {
  const { data: row, error } = await sb.from('settings').select('data').eq('id', 1).single();
  if (error) { root.append(h('p', { class: 'form-error', text: errMsg(error) })); return; }
  const disabled = new Set(Array.isArray(row.data?.app_disabled_modules) ? row.data.app_disabled_modules : []);
  const enabled = new Set(Array.isArray(row.data?.app_enabled_modules) ? row.data.app_enabled_modules : []);
  const boxes = {};
  const card = h('div', { class: 'card' });
  for (const m of MODULES) {
    const c = h('input', { type: 'checkbox', disabled: m.core });
    c.checked = m.setting ? row.data?.[m.setting] === true : m.core || (m.optIn ? enabled.has(m.id) && !disabled.has(m.id) : !disabled.has(m.id));
    boxes[m.id] = c;
    card.append(h('label', { class: 'switch' }, h('span', {}, h('b', { text: m.title }), h('br'), h('small', { class: 'muted', text: m.hint ? m.hint : m.core ? 'Core — always on' : m.optIn ? `${m.id} · off until you switch it on` : m.id })), c));
  }
  const save = h('button', { class: 'btn block', type: 'button', text: 'Save' });
  save.addEventListener('click', async () => {
    const off = MODULES.filter((m) => !m.core && !m.optIn && !m.setting && !boxes[m.id].checked).map((m) => m.id);
    const on = MODULES.filter((m) => m.optIn && boxes[m.id].checked).map((m) => m.id);
    const flags = Object.fromEntries(MODULES.filter((m) => m.setting).map((m) => [m.setting, boxes[m.id].checked]));
    const autopayNow = flags.autopay_enabled && row.data?.autopay_enabled !== true;
    busy(save, true);
    const data = { ...row.data, app_disabled_modules: off, app_enabled_modules: on, ...flags };
    const { error: e } = await sb.from('settings').update({ data }).eq('id', 1);
    if (!e && autopayNow) await sb.rpc('admin_autopay_reconcile');   // match payments already waiting
    busy(save, false);
    if (e) { toast(errMsg(e), 'bad'); return; }
    row.data = data; bustSettingsCache(); toast('Saved');
  });
  root.append(h('h1', { text: 'Modules' }), h('p', { class: 'muted small', text: 'Turned-off modules disappear from the website within a few minutes.' }), card, h('div', { class: 'stack' }, h('div'), save));
}
