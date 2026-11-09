// All offers: category chips, minimum discount, area (from header), infinite grid.
import {
  sb, shell, S, h, $, param, loadCategories, categoryChips, infiniteGrid, discountSelect, selectProviders, getArea, currentArea,
} from '../common.js';

const PAGE = 24;
const app = $('#app');
const setParam = (k, v) => { const u = new URL(location.href); if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); history.replaceState(null, '', u); };

async function main() {
  await shell('offers');
  app.textContent = '';
  let cat = param('cat') || '';
  let minDisc = Number(param('min')) || null;
  const area = getArea();
  const grid = h('div', { class: 'grid' });
  const more = h('div', { class: 'more' });
  const chipsSlot = h('div');
  const sub = h('p', { class: 'muted', text: S('tagline') });
  app.append(
    h('div', { class: 'filters' }, h('h1', { class: 'grow', text: S('offers_title') }),
      discountSelect(minDisc, (v) => { minDisc = v; setParam('min', v); list.reset(); })),
    sub, chipsSlot, grid, more);
  currentArea().then((a) => { if (a) sub.textContent = `${S('tagline')} · ${a.name}`; });

  const list = infiniteGrid(grid, more, async (offset) => {
    const { data, error } = await selectProviders((cols, withAreas) => {
      let q = sb.from('providers').select(cols)
        .eq('is_active', true).order('sort_order').order('name').order('id').range(offset, offset + PAGE - 1);
      if (cat) q = q.eq('category_id', cat);
      if (minDisc) q = q.gte('discount_percent', minDisc);
      if (area && withAreas) q = q.contains('area_ids', [area]);   // main area or any branch
      return q;
    });
    if (!error && area && data) { const a = await currentArea(); if (a) data.forEach((p) => { p.area = { name: a.name }; }); }
    if (error) throw error;
    return data;
  }, PAGE, () => (cat || minDisc || area ? S('category_empty') : S('home_empty')));

  loadCategories().then((cats) => {
    if (!cats.length) return;
    if (cat && !cats.some((c) => c.id === cat)) { cat = ''; list.reset(); }
    chipsSlot.append(categoryChips(cats, cat, (id) => { cat = id; setParam('cat', id); list.reset(); }));
  });
  await list.reset();
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
