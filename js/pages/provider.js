import { sb, shell, S, h, $, clear, mediaUrl, pct, initialOf, param, rulesText, usageText, icon, catIcon, offBadge, loadOffers, offersList } from '../common.js';

const app = $('#app');
async function main() {
  const ctx = await shell('offers');
  clear(app);
  const id = param('id') || '';
  const { data: p } = /^[0-9a-f-]{36}$/i.test(id)
    ? await (async () => {
      const cols = 'id,name,image_path,discount_percent,notes,limit_count,limit_period,allowed_days,area:areas(name),category:categories(name,icon)';
      let full = await sb.from('providers').select(`${cols},max_percent`).eq('id', id).eq('is_active', true).maybeSingle();
      if (full.error && /max_percent/.test(full.error.message || '')) full = await sb.from('providers').select(cols).eq('id', id).eq('is_active', true).maybeSingle();
      if (!full.error) return full;
      console.warn('Partner page fallback:', full.error.message);   // an update (006/007) is missing in the database
      return sb.from('providers').select('id,name,image_path,discount_percent,notes').eq('id', id).eq('is_active', true).maybeSingle();
    })()
    : { data: null };
  if (!p) {
    app.append(h('div', { class: 'empty' }, h('p', { text: 'This partner is not available.' }), h('a', { class: 'btn ghost', href: 'offers.html', text: S('nav_offers') })));
    return;
  }
  document.title = `${p.name} · ${S('site_title')}`;
  const isCustomer = ctx.role === 'customer';
  const isMember = isCustomer && ctx.membership?.status === 'active';
  const rules = rulesText(p);
  const usageBox = h('div');
  const back = h('a', { class: 'back', href: history.length > 1 ? '#' : 'offers.html', 'aria-label': 'Back' }, icon('back'));
  back.addEventListener('click', (e) => { if (history.length > 1) { e.preventDefault(); history.back(); } });
  const offerPane = h('div', { class: 'stack' });
  const branchPane = h('div', { class: 'stack', hidden: true });
  const tabCount = h('span', { class: 'tab-n' });
  const tabBtn = (label, pane, extra) => h('button', { class: 'p-tab', type: 'button', role: 'tab', 'aria-selected': pane === offerPane ? 'true' : 'false',
    onclick: (e) => {
      for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-selected', String(b === e.currentTarget));
      offerPane.hidden = pane !== offerPane; branchPane.hidden = pane !== branchPane;
    } }, label, extra);
  const tabs = h('div', { class: 'p-tabs', role: 'tablist' }, tabBtn(S('tab_offer'), offerPane), tabBtn(S('tab_branches'), branchPane, tabCount));
  app.append(h('div', { class: 'p-wrap' },
    h('div', { class: 'p-hero' },
      p.image_path ? h('img', { src: mediaUrl(p.image_path), alt: p.name }) : h('div', { class: 'ph', text: initialOf(p.name) }), back),
    h('div', { class: 'p-body stack' },
      h('h1', { text: p.name }),
      h('div', { class: 'p-meta' },
        p.area?.name ? h('span', { class: 'p-area' }, icon('pin'), p.area.name) : null,
        p.category?.name ? h('span', { class: 'chip' }, catIcon(p.category.icon), p.category.name) : null),
      offBadge(p, 'offpill'),
      tabs, offerPane, branchPane)));
  const offersBox = h('div');
  offerPane.append(
      offersBox,
      rules.length ? h('div', { class: 'rules' }, h('div', { class: 'rules-title' }, icon('clock'), h('b', { text: S('rules_title') })),
        h('ul', {}, rules.map((r) => h('li', { text: r })))) : null,
      usageBox,
      p.notes ? h('div', {}, h('h2', { text: S('provider_notes_title') }), h('div', { class: 'notes', text: p.notes })) : null,
      h('a', { class: 'btn block pill', href: 'membership.html', text: isMember ? S('provider_cta_member') : S('provider_cta_guest') }),
      isCustomer ? h('a', { class: 'small center muted', href: `report.html?provider=${encodeURIComponent(p.id)}`, text: `${S('report_title')} →` }) : null);
  loadBranches(p, branchPane, tabCount);
  loadOffers(p.id).then((list) => {
    if (!list.length) return;   // only the standard discount: the pill above says it all
    offersBox.append(h('h2', { text: S('offers_heading') }), offersList(p, list));
  });
  if (isMember && (p.limit_count || p.allowed_days)) {
    const { data: u } = await sb.rpc('my_provider_usage', { p_provider: p.id });
    const t = usageText(u);
    if (t) usageBox.append(h('div', { class: `badge ${u.uses_left === 0 || u.valid_today === false ? 'bad' : 'ok'} usage`, text: t }));
  }
}
export function mapsHref(b) {
  if (b.maps_url && /^https:\/\//.test(b.maps_url)) return b.maps_url;
  const q = [b.name, b.address, b.area?.name].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

async function loadBranches(p, pane, countEl) {
  const { data, error } = await sb.from('branches').select('id,name,address,phone,maps_url,sort_order,area:areas(name,sort_order)')
    .eq('provider_id', p.id).eq('is_active', true).order('sort_order').order('name').limit(200);
  if (error) console.warn('Branches unavailable:', error.message);   // update 011 not applied yet
  const rows = data || [];
  countEl.textContent = rows.length ? ` (${rows.length})` : '';
  if (!rows.length) { pane.append(h('p', { class: 'muted center', text: S('branches_empty') })); return; }
  // group under area headers, in the admin's area order
  const groups = new Map();
  for (const b of rows) {
    const key = b.area?.name || '';
    if (!groups.has(key)) groups.set(key, { order: b.area?.sort_order ?? 1e9, items: [] });
    groups.get(key).items.push(b);
  }
  const sorted = [...groups.entries()].sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
  for (const [areaName, g] of sorted) {
    pane.append(h('div', { class: 'br-group' },
      areaName ? h('div', { class: 'br-area' }, icon('pin'), h('span', { text: areaName }), h('small', { text: String(g.items.length) })) : null,
      h('div', { class: 'br-list' }, g.items.map((b) => h('div', { class: 'br-row' },
        h('div', { class: 'grow br-text' },
          h('b', { text: b.name || areaName || p.name }),
          b.address ? h('div', { class: 'br-addr', text: b.address }) : null),
        b.phone ? h('a', { class: 'br-btn call', href: `tel:${b.phone}`, 'aria-label': `${S('branch_call')} ${b.phone}`, title: b.phone }, icon('phone')) : null,
        h('a', { class: 'br-btn map', href: mapsHref(b), target: '_blank', rel: 'noopener', 'aria-label': S('branch_map') }, icon('pin')))))));
  }
}

main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
