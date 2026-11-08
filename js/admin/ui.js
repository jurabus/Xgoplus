// Small UI helpers shared by admin tabs.
import { h, clear } from '../common.js';

export { sheet } from '../common.js';
export const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { text: label }), input, hint ? h('small', { class: 'muted', text: hint }) : null);
export const input = (attrs = {}) => h('input', { class: 'input', ...attrs });
export function textarea(value = '', attrs = {}) { const t = h('textarea', { class: 'input', ...attrs }); t.value = value; return t; }
export function checkbox(checked) { const c = h('input', { type: 'checkbox' }); c.checked = !!checked; return c; }

// Paged list: loader(offset, limit) -> { rows, total }
export function pagedList(container, loader, renderRow, limit = 30) {
  let offset = 0;
  const list = h('div', { class: 'list' });
  const pager = h('div', { class: 'pager' });
  container.append(list, pager);
  async function load() {
    clear(list).append(h('div', { class: 'spinner' }));
    const { rows, total } = await loader(offset, limit);
    clear(list);
    if (!rows.length) list.append(h('div', { class: 'empty', text: 'Nothing here yet.' }));
    rows.forEach((r) => list.append(renderRow(r)));
    clear(pager);
    const prev = h('button', { class: 'btn sm light', type: 'button', text: '← Prev', disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - limit); load(); } });
    const hasNext = total != null ? offset + rows.length < total : rows.length === limit;
    const next = h('button', { class: 'btn sm light', type: 'button', text: 'Next →', disabled: !hasNext, onclick: () => { offset += limit; load(); } });
    pager.append(prev, h('span', { class: 'small muted', text: total != null ? `${total ? offset + 1 : 0}–${offset + rows.length} of ${total}` : `${offset + 1}–${offset + rows.length}` }), next);
  }
  return { load, reset() { offset = 0; return load(); } };
}
