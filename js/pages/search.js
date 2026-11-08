// Search results: 20 per page, more load on scroll; optional category filter.
import { sb, shell, S, h, $, clear, param, loadCategories, categoryChips, infiniteGrid, discountSelect, getArea } from '../common.js';

const PAGE = 20;
const app = $('#app');

async function main() {
  const q = (param('q') || '').trim().slice(0, 60);
  let cat = param('cat') || '';
  let minDisc = Number(param('min')) || null;
  const setParam = (k, v) => { const u = new URL(location.href); if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); history.replaceState(null, '', u); };
  await shell('offers', { searchBar: q });
  clear(app);
  document.title = q ? `${q} · ${S('site_title')}` : `${S('search_results_title')} · ${S('site_title')}`;
  const grid = h('div', { class: 'grid' });
  const more = h('div', { class: 'more' });
  const chipsSlot = h('div');
  app.append(
    h('div', { class: 'row filters' },
      h('h1', { class: 'results-title grow' }, S('search_results_title'), q ? [' ', h('span', { class: 'muted', text: `“${q}”` })] : null),
      discountSelect(minDisc, (v) => { minDisc = v; setParam('min', v); if (q) list.reset(); })),
    chipsSlot, grid, more);
  if (!q) { more.append(h('div', { class: 'empty', text: S('search_placeholder') })); return; }

  const list = infiniteGrid(grid, more, async (offset) => {
    const { data, error } = await sb.rpc('search_providers', { p_q: q, p_category: cat || null, p_limit: PAGE, p_offset: offset, p_min_discount: minDisc, p_area: getArea() || null });
    if (error) throw error;
    return data;
  }, PAGE, () => `${S('search_no_results')} “${q}”`);

  loadCategories().then((cats) => {
    if (!cats.length) return;
    chipsSlot.append(categoryChips(cats, cat, (id) => {
      cat = id;
      setParam('cat', id);
      list.reset();
    }));
  });
  list.reset();
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
