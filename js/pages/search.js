// Search results: 20 per page, more load on scroll; optional category filter.
import { sb, shell, S, h, $, clear, param, loadCategories, categoryChips, infiniteGrid } from '../common.js';

const PAGE = 20;
const app = $('#app');

async function main() {
  const q = (param('q') || '').trim().slice(0, 60);
  let cat = param('cat') || '';
  await shell('home', { searchBar: q });
  clear(app);
  document.title = q ? `${q} · ${S('site_title')}` : `${S('search_results_title')} · ${S('site_title')}`;
  const grid = h('div', { class: 'grid' });
  const more = h('div', { class: 'more' });
  const chipsSlot = h('div');
  app.append(
    h('h1', { class: 'results-title' }, S('search_results_title'), q ? [' ', h('span', { class: 'muted', text: `“${q}”` })] : null),
    chipsSlot, grid, more);
  if (!q) { more.append(h('div', { class: 'empty', text: S('search_placeholder') })); return; }

  const list = infiniteGrid(grid, more, async (offset) => {
    const { data, error } = await sb.rpc('search_providers', { p_q: q, p_category: cat || null, p_limit: PAGE, p_offset: offset });
    if (error) throw error;
    return data;
  }, PAGE, () => `${S('search_no_results')} “${q}”`);

  loadCategories().then((cats) => {
    if (!cats.length) return;
    chipsSlot.append(categoryChips(cats, cat, (id) => {
      cat = id;
      const u = new URL(location.href);
      if (id) u.searchParams.set('cat', id); else u.searchParams.delete('cat');
      history.replaceState(null, '', u);
      list.reset();
    }));
  });
  list.reset();
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
