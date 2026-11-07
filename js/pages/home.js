import { sb, shell, S, h, $, clear, icon, mediaUrl, pct, initialOf, errMsg } from '../common.js';

const PAGE = 24;
const app = $('#app');

function providerCard(p) {
  return h('a', { class: 'pcard', href: `provider.html?id=${encodeURIComponent(p.id)}` },
    h('div', { class: 'logo-box' },
      p.image_path
        ? h('img', { src: mediaUrl(p.image_path), alt: '', loading: 'lazy', decoding: 'async', width: 300, height: 300 })
        : h('span', { class: 'initial', text: initialOf(p.name) })),
    h('div', { class: 'meta' },
      h('div', { class: 'name', text: p.name }),
      h('div', { class: 'off', text: `${pct(p.discount_percent)}${S('off_suffix')}` })));
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

async function main() {
  await shell('home');
  clear(app);
  const grid = h('div', { class: 'grid', id: 'grid' });
  const more = h('div', { class: 'more' });
  const search = h('input', { class: 'input', type: 'search', placeholder: S('home_search_placeholder'), 'aria-label': S('home_search_placeholder'), maxlength: 60 });
  app.append(
    h('div', { id: 'banners' }),
    h('h1', { text: S('home_heading') }),
    h('p', { class: 'muted', text: S('tagline') }),
    h('div', { class: 'searchbar' }, icon('search'), search),
    grid, more);
  banners().then((b) => b && $('#banners').append(b)).catch(() => {});

  let offset = 0, done = false, loading = false, q = '', seq = 0;
  const sentinel = h('div', { 'aria-hidden': 'true' });
  async function load(reset) {
    if (loading && !reset) return;
    if (reset) { offset = 0; done = false; clear(grid); }
    if (done) return;
    loading = true;
    const my = ++seq;
    clear(more).append(h('div', { class: 'spinner' }));
    let query = sb.from('providers').select('id,name,image_path,discount_percent')
      .eq('is_active', true).order('sort_order').order('name').order('id').range(offset, offset + PAGE - 1);
    if (q) query = query.ilike('name', `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`);
    const { data, error } = await query;
    if (my !== seq) return;
    loading = false;
    clear(more);
    if (error) { more.append(h('p', { class: 'muted', text: errMsg(error) })); return; }
    data.forEach((p) => grid.append(providerCard(p)));
    offset += data.length;
    if (data.length < PAGE) done = true;
    if (!grid.children.length) more.append(h('div', { class: 'empty', text: q ? `“${q}” — 0` : S('home_empty') }));
    if (!done) more.append(sentinel);
  }
  new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) load(false); }, { rootMargin: '600px' }).observe(sentinel);
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { q = search.value.trim(); load(true); }, 250); });
  await load(true);
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
