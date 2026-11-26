// All offers: category chips, minimum discount, area (from header), infinite grid.
import {
  sb, shell, S, T, L, h, $, clear, param, moduleOn, langScope, langToggle, loadCategories, categoryChips, infiniteGrid, discountSelect, selectProviders, getArea, currentArea,
} from '../common.js';

const PAGE = 24;
const app = $('#app');
const setParam = (k, v) => { const u = new URL(location.href); if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); history.replaceState(null, '', u); };

// Referral call-to-action on top of all offers (EN <-> AR)
function cashBanner() {
  const el = h('section', { class: 'cash-banner' });
  const draw = () => clear(langScope(el)).append(
    langToggle(draw, 'on-dark'),
    h('div', { class: 'cash-coins', 'aria-hidden': 'true', text: '💸' }),
    h('h2', { class: 'cash-title', text: T('offers_earn_title') }),
    h('p', { class: 'cash-text', text: T('offers_earn_text') }),
    h('a', { class: 'btn cash-cta', href: 'earn.html' }, h('span', { text: T('offers_earn_cta') }), h('span', { 'aria-hidden': 'true', text: L(' →', ' ←') })));
  draw();
  return el;
}

async function main() {
  const ctx = await shell('offers');
  app.textContent = '';
  if (moduleOn('referrals') && ctx.role !== 'provider' && ctx.role !== 'admin') app.append(cashBanner());
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
    const { data, error } = await selectProviders((cols, withAreas, feat) => {
      let q = sb.from('providers').select(cols)
        .eq('is_active', true).order('sort_order').order('name').order('id').range(offset, offset + PAGE - 1);
      if (cat) q = q.eq('category_id', cat);
      if (minDisc) q = q.gte(feat.max ? 'max_percent' : 'discount_percent', minDisc);   // best offer counts
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
