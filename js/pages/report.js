// Report a partner: search + pick partner -> pick a predefined reason -> send.
// Second tab lists my reports and their status.
import {
  sb, shell, S, h, $, clear, icon, errMsg, busy, toast, mediaUrl, initialOf, fmtDate, param, moduleOn,
} from '../common.js';
import { sheet } from '../admin/ui.js';

const app = $('#app');
const PAGE = 20;
const STATUS_CLS = { open: 'warn', in_review: 'brand', resolved: 'ok', dismissed: 'bad' };

function reasons() {
  const r = S('complaint_reasons');
  return Array.isArray(r) && r.length ? r : [];
}

function reportSheet(p) {
  const name = `reason-${Math.random().toString(36).slice(2)}`;
  const radios = reasons().map((r, i) => {
    const inp = h('input', { type: 'radio', name, value: r });
    if (i === 0) inp.checked = true;
    return h('label', { class: 'radio' }, inp, h('span', { text: r }));
  });
  const details = h('textarea', { class: 'input', maxlength: 1000, rows: 3 });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const send = h('button', { class: 'btn block', type: 'submit', text: S('report_submit') });
  const form = h('form', { class: 'stack' },
    h('div', { class: 'row' },
      p.image_path ? h('img', { class: 'thumb', src: mediaUrl(p.image_path), alt: '' }) : h('div', { class: 'thumb', text: initialOf(p.name) }),
      h('b', { text: p.name })),
    h('div', { class: 'field' }, h('span', { class: 'lbl', text: S('report_reason_label') }), h('div', { class: 'radios' }, radios)),
    h('label', { class: 'field' }, h('span', { text: S('report_details_label') }), details),
    err, send);
  const s = sheet(S('report_title'), form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    const reason = form.querySelector('input[type=radio]:checked')?.value;
    if (!reason) { err.textContent = S('report_reason_label'); return; }
    busy(send, true);
    const { error } = await sb.rpc('file_complaint', { p_provider: p.id, p_reason: reason, p_details: details.value.trim() });
    busy(send, false);
    if (error) { err.textContent = errMsg(error); return; }
    s.close();
    toast(S('report_sent'));
    location.hash = 'mine';
  });
}

function pickView(root) {
  const input = h('input', { class: 'input', type: 'search', placeholder: S('report_search_placeholder'), 'aria-label': S('report_search_placeholder'), maxlength: 60, autocomplete: 'off' });
  const list = h('div', { class: 'list' });
  const more = h('div', { class: 'more' });
  root.append(h('p', { class: 'muted', text: S('report_subtitle') }),
    h('div', { class: 'searchbar' }, icon('search'), input), list, more);
  let q = '', offset = 0, done = false, loading = false, seq = 0;
  const sentinel = h('div');
  async function load(reset) {
    if (reset) { offset = 0; done = false; loading = false; clear(list); }
    if (loading || done) return;
    loading = true;
    const my = ++seq;
    clear(more).append(h('div', { class: 'spinner' }));
    const { data, error } = q
      ? await sb.rpc('search_providers', { p_q: q, p_category: null, p_limit: PAGE, p_offset: offset, p_min_discount: null })
      : await sb.from('providers').select('id,name,image_path').eq('is_active', true).order('name').order('id').range(offset, offset + PAGE - 1);
    if (my !== seq) return;
    loading = false; clear(more);
    if (error) { more.append(h('p', { class: 'form-error', text: errMsg(error) })); return; }
    data.forEach((p) => list.append(h('button', { class: 'item btn-reset', type: 'button', onclick: () => reportSheet(p) },
      p.image_path ? h('img', { class: 'thumb', src: mediaUrl(p.image_path), alt: '', loading: 'lazy' }) : h('div', { class: 'thumb', text: initialOf(p.name) }),
      h('div', { class: 'grow ellipsis' }, h('b', { text: p.name })), h('span', { class: 'muted', text: '›' }))));
    offset += data.length;
    if (data.length < PAGE) done = true;
    if (!offset) more.append(h('div', { class: 'empty', text: `${S('search_no_results')} “${q}”` }));
    if (!done) more.append(sentinel);
  }
  new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) load(false); }, { rootMargin: '400px' }).observe(sentinel);
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { q = input.value.trim(); load(true); }, 200); });
  load(true);
  const pre = param('provider');
  if (pre && /^[0-9a-f-]{36}$/i.test(pre)) {
    sb.from('providers').select('id,name,image_path').eq('id', pre).maybeSingle().then(({ data }) => data && reportSheet(data));
  }
}

async function mineView(root) {
  root.append(h('div', { class: 'spinner' }));
  const { data, error } = await sb.rpc('my_complaints', { p_limit: 50, p_offset: 0 });
  clear(root);
  if (error) { root.append(h('p', { class: 'form-error', text: errMsg(error) })); return; }
  if (!data.length) { root.append(h('div', { class: 'empty', text: '—' })); return; }
  root.append(h('div', { class: 'stack' }, data.map((c) => h('div', { class: 'card stack' },
    h('div', { class: 'row' }, h('b', { class: 'grow', text: c.provider_name }), h('span', { class: `badge ${STATUS_CLS[c.status]}`, text: S(`status_${c.status}`) })),
    h('div', { text: c.reason }),
    c.details ? h('div', { class: 'small muted', text: c.details }) : null,
    c.admin_note ? h('div', { class: 'notes small', text: c.admin_note }) : null,
    h('div', { class: 'small muted', text: fmtDate(c.created_at) })))));
}

async function main() {
  await shell('report', { requireRole: ['customer'] });
  clear(app);
  app.append(h('h1', { text: S('report_title') }));
  if (!moduleOn('complaints')) { app.append(h('div', { class: 'card', text: 'Reports are not available right now.' })); return; }
  const tabs = h('div', { class: 'seg' });
  const body = h('div');
  app.append(tabs, body);
  const views = [['new', S('report_new_tab'), pickView], ['mine', S('my_reports_title'), mineView]];
  function route() {
    const cur = location.hash === '#mine' ? 'mine' : 'new';
    clear(tabs).append(...views.map(([id, label]) => h('a', { href: `#${id}`, class: id === cur ? 'active' : '', text: label })));
    clear(body);
    views.find((v) => v[0] === cur)[2](body);
  }
  addEventListener('hashchange', route);
  route();
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
