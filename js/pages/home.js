// Home: hero, search + area, category strip, banners, Top Deals, membership promo.
import {
  sb, shell, S, h, $, clear, mediaUrl, icon, logoSVG, loadCategories, catIcon, svgPath, CAT_ICONS,
  providerCard, selectProviders, getArea, moduleOn,
} from '../common.js';
import { mountSearch } from '../search.js';

const app = $('#app');

function hero() {
  const heroImg = S('hero_image_path') ? mediaUrl(S('hero_image_path')) : '/img/hero.webp?v=2';
  const searchSlot = h('div', { class: 'hero-search' });
  const el = h('section', { class: 'hero-wrap' },
    h('div', { class: 'hero' },
      h('div', { class: 'hero-text' },
        h('div', { class: 'hero-logo' }, S('logo_path') ? h('img', { src: mediaUrl(S('logo_path')), alt: S('site_title') }) : logoSVG()),
        h('h1', { class: 'hero-title' }, S('hero_title_1'), ' ', h('em', { text: S('hero_title_2') })),
        h('p', { class: 'hero-sub', text: S('hero_text') }),
        h('a', { class: 'btn pill hero-cta', href: 'offers.html' }, S('hero_cta'), icon('arrow'))),
      h('div', { class: 'hero-art' }, h('img', { src: heroImg, alt: '', width: 645, height: 385, fetchpriority: 'high' })),
      h('div', { class: 'hero-tag', 'aria-hidden': 'true' }, 'Your', h('br'), 'Smart Choice', h('br'), 'for Great Deals!'),
      searchSlot));
  return { el, searchSlot };
}

// Desktop / tablet: the full designed banner, with a real button and a real search bar placed on it
function heroBanner() {
  const searchSlot = h('div', { class: 'hb-search' });
  const el = h('section', { class: 'hero-banner', 'aria-label': S('site_title') },
    h('img', { src: '/img/banner-1x.webp?v=1', srcset: '/img/banner-1x.webp?v=1 1536w, /img/banner-2x.webp?v=1 3072w', sizes: '100vw',
      alt: `${S('hero_title_1')} ${S('hero_title_2')}`, width: 1536, height: 372, fetchpriority: 'high' }),
    h('a', { class: 'btn pill hb-cta', href: 'offers.html' }, S('hero_cta'), icon('arrow')),
    searchSlot);
  return { el, searchSlot };
}

async function categoryStrip() {
  const cats = await loadCategories();
  if (!cats.length) return null;
  return h('nav', { class: 'catbar', 'aria-label': S('categories_heading') },
    cats.slice(0, 6).map((c) => h('a', { class: 'cat', href: `offers.html?cat=${encodeURIComponent(c.id)}` }, catIcon(c.icon), h('span', { text: c.name }))),
    h('a', { class: 'cat all', href: 'offers.html' }, svgPath(CAT_ICONS.pct, 'cat-ic', '1.8'), h('span', {}, S('all_categories'), ' ›')));
}

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

function dealsRow(items) {
  return h('div', { class: 'deals' }, items.map(providerCard));
}

// Top deals (10 best, spread across categories) + up to 5 category rows of 10 — one database call.
async function feed() {
  const area = getArea();
  const { data, error } = await sb.rpc('home_feed', { p_area: area || null, p_top: 10, p_rows: 5, p_per_row: 10 });
  if (!error && data) return data;
  // database update 010 not installed yet: simple top deals
  const r = await selectProviders((cols, withAreas, feat) => {
    let q = sb.from('providers').select(cols).eq('is_active', true)
      .order(feat.max ? 'max_percent' : 'discount_percent', { ascending: false }).order('sort_order').order('name').limit(10);
    if (area && withAreas) q = q.contains('area_ids', [area]);
    return q;
  });
  return { top: r.data || [], rows: [] };
}

async function dealSections() {
  const [f, cats] = await Promise.all([feed(), loadCategories()]);
  const words = String(S('top_deals_title')).split(' ');
  const out = [h('section', {},
    h('div', { class: 'sec-head' },
      h('h2', {}, icon('fire', 'fire'), words[0], words.length > 1 ? [' ', h('em', { text: words.slice(1).join(' ') })] : null),
      h('a', { href: 'offers.html' }, S('view_all_offers'), icon('arrow'))),
    f.top.length ? dealsRow(f.top) : h('div', { class: 'empty', text: S('home_empty') }))];
  const iconOf = new Map(cats.map((c) => [c.id, c.icon]));
  for (const row of f.rows || []) {
    if (!row.items?.length) continue;
    out.push(h('section', { class: 'cat-row' },
      h('div', { class: 'sec-head cat-row-head' },
        h('h2', {}, catIcon(row.icon || iconOf.get(row.id)), h('span', { text: row.name })),
        h('a', { href: `offers.html?cat=${encodeURIComponent(row.id)}` }, S('view_all'), icon('arrow'))),
      dealsRow(row.items)));
  }
  out.push(h('div', { class: 'view-all-wrap' }, h('a', { class: 'btn pill', href: 'offers.html' }, S('view_all_offers'), icon('arrow'))));
  return out;
}

function promo(ctx) {
  if (!moduleOn('membership') || (ctx.role === 'customer' && ctx.membership?.status === 'active') || ctx.role === 'provider') return null;
  return h('section', { class: 'promo' },
    h('div', { class: 'grow' }, h('h3', { text: S('membership_promo_title') }), h('p', { text: S('membership_promo_text') })),
    h('a', { class: 'btn pill', href: 'membership.html', text: S('membership_cta') }));
}

async function main() {
  const ctx = await shell('home', { searchBar: false });
  clear(app);
  const catSlot = h('div'), bannerSlot = h('div'), dealsSlot = h('div', {}, h('div', { class: 'spinner' }));
  const wide = window.matchMedia('(min-width: 900px)').matches;
  const top = wide ? heroBanner() : hero();
  app.append(top.el, catSlot, bannerSlot, dealsSlot, promo(ctx));
  mountSearch(top.searchSlot, '', { hero: true });
  const [cats, deals, bans] = await Promise.all([categoryStrip(), dealSections(), banners().catch(() => null)]);
  if (cats) catSlot.append(cats);
  clear(dealsSlot).append(...deals);
  if (bans) bannerSlot.append(bans);
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
