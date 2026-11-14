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
  { id: 'explore', title: 'Explore (targeted ads)', core: false, optIn: true },
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
    c.checked = m.core || (m.optIn ? enabled.has(m.id) && !disabled.has(m.id) : !disabled.has(m.id));
    boxes[m.id] = c;
    card.append(h('label', { class: 'switch' }, h('span', {}, h('b', { text: m.title }), h('br'), h('small', { class: 'muted', text: m.core ? 'Core — always on' : m.optIn ? `${m.id} · off until you switch it on` : m.id })), c));
  }
  const save = h('button', { class: 'btn block', type: 'button', text: 'Save' });
  save.addEventListener('click', async () => {
    const off = MODULES.filter((m) => !m.core && !m.optIn && !boxes[m.id].checked).map((m) => m.id);
    const on = MODULES.filter((m) => m.optIn && boxes[m.id].checked).map((m) => m.id);
    busy(save, true);
    const { error: e } = await sb.from('settings').update({ data: { ...row.data, app_disabled_modules: off, app_enabled_modules: on } }).eq('id', 1);
    busy(save, false);
    if (e) { toast(errMsg(e), 'bad'); return; }
    row.data.app_disabled_modules = off; row.data.app_enabled_modules = on; bustSettingsCache(); toast('Saved');
  });
  root.append(h('h1', { text: 'Modules' }), h('p', { class: 'muted small', text: 'Turned-off modules disappear from the website within a few minutes.' }), card, h('div', { class: 'stack' }, h('div'), save));
}
