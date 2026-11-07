import { sb, shell, S, h, $, clear, mediaUrl, param, loadCategories, categoryChips, infiniteGrid, discountSelect } from '../common.js';

const PAGE = 24;
const app = $('#app');

async function banners() {
  const { data } = await sb.from('banners').select('id,image_path,title,subtitle,link_url')
    .eq('is_active', true).order('sort_order').order('created_at').limit(10);
  if (!data?.length) return null;
  return h('div', { class: 'banners' }, data.map((b) => {
    const inner = [
      b.image_path ? h('img', { src: mediaUrl(b.image_path), alt: '', decoding: 'async' }) : null,
      (b.title || b.subtitle) ? h('div', { class: 'txt' }, b.title ? h('b', { text: b.title }) : null, b.subtitle ? h('span', { text: b.subtitle }) : null) : null,
    ];
    return b.link_url ? h('a', { class: 'banner', href: b.link_url, rel: 'noopener' }, inner) : h('div', { class: 'banner' }, inner);
  }));
}

function setParam(k, v) {
  const u = new URL(location.href);
  if (v) u.searchParams.set(k, v); else u.searchParams.delete(k);
  history.replaceState(null, '', u);
}

async function main() {
  await shell('home');
  clear(app);
  let cat = param('cat') || '';
  let minDisc = Number(param('min')) || null;
  const grid = h('div', { class: 'grid', id: 'grid' });
  const more = h('div', { class: 'more' });
  const chipsSlot = h('div', { class: 'chips-slot' });
  app.append(
    h('div', { id: 'banners' }),
    h('h1', { text: S('home_heading') }),
    h('div', { class: 'row filters' }, h('p', { class: 'muted grow', text: S('tagline') }),
      discountSelect(minDisc, (v) => { minDisc = v; setParam('min', v); list.reset(); })),
    chipsSlot, grid, more);
  banners().then((b) => b && $('#banners').append(b)).catch(() => {});

  const list = infiniteGrid(grid, more, async (offset) => {
    let q = sb.from('providers').select('id,name,image_path,discount_percent')
      .eq('is_active', true).order('sort_order').order('name').order('id').range(offset, offset + PAGE - 1);
    if (cat) q = q.eq('category_id', cat);
    if (minDisc) q = q.gte('discount_percent', minDisc);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  }, PAGE, () => (cat || minDisc ? S('category_empty') : S('home_empty')));

  loadCategories().then((cats) => {
    if (!cats.length) return;
    if (cat && !cats.some((c) => c.id === cat)) { cat = ''; list.reset(); }
    chipsSlot.append(categoryChips(cats, cat, (id) => {
      cat = id;
      setParam('cat', id);
      list.reset();
    }));
  });
  await list.reset();
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
