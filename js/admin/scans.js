import { sb, h, errMsg, toast, fmtDateTime, pct, localPhone } from '../common.js';
import { pagedList } from './ui.js';

const CLS = { active: 'ok', expired: 'bad', invalid: 'warn', stale: 'warn' };
export async function render(root) {
  root.append(h('h1', { text: 'Scans' }), h('p', { class: 'muted small', text: 'Every QR check made by providers.' }));
  pagedList(root, async (offset, limit) => {
    const { data, error } = await sb.rpc('admin_list_scans', { p_provider: null, p_limit: limit, p_offset: offset });
    if (error) { toast(errMsg(error), 'bad'); return { rows: [] }; }
    return { rows: data, total: null };
  }, (s) => h('div', { class: 'item' },
    h('div', { class: 'grow' },
      h('div', { class: 'ellipsis' }, h('b', { text: s.provider_name }), ' → ', s.member_label || '—'),
      h('div', { class: 'small muted', text: `${fmtDateTime(s.created_at)}${s.member_phone ? ` · ${localPhone(s.member_phone)}` : ''}` })),
    s.discount_percent ? h('b', { text: `${pct(s.discount_percent)}%` }) : null,
    h('span', { class: `badge ${CLS[s.result] || 'warn'}`, text: s.result }))).load();
}
