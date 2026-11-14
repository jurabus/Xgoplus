// Explore: ads from non-partner businesses, picked by the member's interests
// (categories they scan most). Off until switched on in Admin → Modules.
import { sb, shell, S, h, $, clear, errMsg, mediaUrl, initialOf, icon, catIcon, moduleOn, bustSettingsCache } from '../common.js';

const app = $('#app');
const PAGE = 10;
const seen = new Set();

function track(id, kind) {
  sb.rpc('explore_track', { p_ad: id, p_kind: kind }).then(() => {}, () => {});
}

function adCard(ad, loggedIn) {
  const long = (ad.body || '').length > 220;
  const body = h('p', { class: `ad-body${long ? ' clamp' : ''}`, text: ad.body || '' });
  const more = long ? h('button', { class: 'ad-more', type: 'button', text: S('explore_see_more'),
    onclick: (e) => { body.classList.remove('clamp'); e.currentTarget.remove(); } }) : null;
  const go = () => { if (loggedIn) track(ad.id, 'click'); };
  const link = ad.link_url && /^https:\/\//.test(ad.link_url) ? ad.link_url : null;
  const img = h('img', { class: 'ad-img', src: mediaUrl(ad.image_path), alt: ad.advertiser, loading: 'lazy' });
  const card = h('article', { class: 'ad-card', 'data-id': ad.id },
    h('header', { class: 'ad-head' },
      ad.logo_path ? h('img', { class: 'ad-logo', src: mediaUrl(ad.logo_path), alt: '' }) : h('span', { class: 'ad-logo ph', text: initialOf(ad.advertiser) }),
      h('div', { class: 'grow' },
        h('b', { class: 'ad-name', text: ad.advertiser }),
        h('div', { class: 'ad-meta' }, h('span', { text: S('explore_sponsored') }),
          ad.category ? [h('span', { text: '·' }), h('span', { class: 'ad-cat' }, catIcon(ad.category_icon), ad.category)] : null))),
    ad.body ? h('div', { class: 'ad-text' }, body, more) : null,
    link ? h('a', { class: 'ad-imglink', href: link, target: '_blank', rel: 'noopener noreferrer', onclick: go }, img) : img,
    link ? h('div', { class: 'ad-foot' },
      h('span', { class: 'ad-host ellipsis', text: new URL(link).hostname.replace(/^www\./, '') }),
      h('a', { class: 'btn sm ad-cta', href: link, target: '_blank', rel: 'noopener noreferrer', onclick: go, text: ad.cta_label || S('explore_visit') })) : null);
  return card;
}

async function main() {
  const ctx = await shell('explore');
  clear(app);
  app.append(h('h1', { text: S('explore_title') }), h('p', { class: 'muted', text: S('explore_sub') }));
  const loggedIn = ctx.role === 'customer';
  if (ctx.role === 'guest' || ctx.role === 'none') {
    app.append(h('a', { class: 'card explore-hint', href: 'login.html?next=explore.html' }, icon('compass'), h('span', { text: S('explore_guest_hint') })));
  }
  const feed = h('div', { class: 'ad-feed' });
  const moreBtn = h('button', { class: 'btn ghost block', type: 'button', hidden: true, text: S('explore_more') });
  app.append(feed, moreBtn);

  const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const id = e.target.dataset.id;
      io.unobserve(e.target);
      if (!seen.has(id)) { seen.add(id); track(id, 'view'); }
    }
  }, { threshold: 0.5 }) : null;

  let offset = 0;
  async function load() {
    moreBtn.disabled = true;
    const { data, error } = await sb.rpc('explore_feed', { p_limit: PAGE, p_offset: offset });
    moreBtn.disabled = false;
    if (error) { feed.append(h('p', { class: 'form-error', text: errMsg(error) })); return; }
    if (Boolean(data?.enabled) !== moduleOn('explore')) bustSettingsCache();   // switched on/off since settings were cached
    if (!data?.enabled) { clear(feed).append(h('div', { class: 'card empty', text: S('explore_off') })); moreBtn.hidden = true; return; }
    const items = data.items || [];
    if (!offset && !items.length) feed.append(h('div', { class: 'card empty', text: S('explore_empty') }));
    for (const ad of items) {
      const c = adCard(ad, loggedIn);
      feed.append(c);
      if (loggedIn && io) io.observe(c);
    }
    offset += items.length;
    moreBtn.hidden = items.length < PAGE;
  }
  moreBtn.addEventListener('click', load);
  await load();
}

main().catch((e) => { if (e.message !== 'redirect') { console.error(e); app.textContent = errMsg(e); } });
