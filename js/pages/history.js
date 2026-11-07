// Customer scan history: every time a partner scanned my QR.
import { sb, shell, S, h, $, clear, errMsg, mediaUrl, initialOf, pct, fmtDateTime, moduleOn } from '../common.js';

const app = $('#app');
const PAGE = 20;
const RESULT = {
  active: ['ok', () => S('history_saved')],
  expired: ['bad', () => S('membership_expired_label')],
  limit_reached: ['warn', () => S('scan_limit_reached')],
  not_today: ['warn', () => S('scan_not_today')],
};

async function main() {
  await shell('account', { requireRole: ['customer'] });
  clear(app);
  app.append(h('a', { class: 'muted small', href: 'account.html', text: `← ${S('nav_account')}` }), h('h1', { text: S('history_title') }));
  if (!moduleOn('scan-history')) { app.append(h('div', { class: 'card', text: 'History is not available right now.' })); return; }
  const list = h('div', { class: 'list' });
  const more = h('div', { class: 'more' });
  app.append(list, more);
  let offset = 0, loading = false, done = false;
  const sentinel = h('div');
  async function load() {
    if (loading || done) return;
    loading = true;
    clear(more).append(h('div', { class: 'spinner' }));
    const { data, error } = await sb.rpc('my_scan_history', { p_limit: PAGE, p_offset: offset });
    loading = false; clear(more);
    if (error) { more.append(h('p', { class: 'form-error', text: errMsg(error) })); return; }
    data.forEach((r) => {
      const [cls, label] = RESULT[r.result] || ['warn', () => r.result];
      list.append(h('a', { class: 'item', href: `provider.html?id=${encodeURIComponent(r.provider_id)}` },
        r.provider_image ? h('img', { class: 'thumb', src: mediaUrl(r.provider_image), alt: '', loading: 'lazy' }) : h('div', { class: 'thumb', text: initialOf(r.provider_name) }),
        h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, h('b', { text: r.provider_name })), h('div', { class: 'small muted', text: fmtDateTime(r.created_at) })),
        r.discount_percent ? h('b', { class: 'off-txt', text: `${pct(r.discount_percent)}%` }) : null,
        h('span', { class: `badge ${cls}`, text: label() })));
    });
    offset += data.length;
    if (data.length < PAGE) done = true;
    if (!offset) { list.replaceWith(h('div', { class: 'empty', text: S('history_empty') })); return; }
    if (!done) more.append(sentinel);
  }
  new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) load(); }, { rootMargin: '400px' }).observe(sentinel);
  load();
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
