import { sb, shell, S, h, $, clear, mediaUrl, pct, initialOf, param, rulesText, usageText, icon } from '../common.js';

const app = $('#app');
async function main() {
  const ctx = await shell('home');
  clear(app);
  const id = param('id') || '';
  const { data: p } = /^[0-9a-f-]{36}$/i.test(id)
    ? await sb.from('providers').select('id,name,image_path,discount_percent,notes,limit_count,limit_period,allowed_days')
      .eq('id', id).eq('is_active', true).maybeSingle()
    : { data: null };
  if (!p) {
    app.append(h('div', { class: 'empty' }, h('p', { text: 'This partner is not available.' }), h('a', { class: 'btn ghost', href: 'index.html', text: S('nav_home') })));
    return;
  }
  document.title = `${p.name} · ${S('site_title')}`;
  const isCustomer = ctx.role === 'customer';
  const isMember = isCustomer && ctx.membership?.status === 'active';
  const rules = rulesText(p);
  const usageBox = h('div');
  app.append(
    h('a', { class: 'muted small', href: 'index.html', text: `← ${S('nav_home')}` }),
    h('div', { class: 'hero' },
      h('div', { class: 'img' }, p.image_path ? h('img', { src: mediaUrl(p.image_path), alt: p.name }) : h('span', { class: 'initial', text: initialOf(p.name) })),
      h('div', { class: 'body stack' },
        h('h1', { text: p.name }),
        h('div', { class: 'offpill' }, `${pct(p.discount_percent)}%`, h('small', { text: S('off_suffix').replace('%', '').trim() })),
        rules.length ? h('div', { class: 'rules' }, h('div', { class: 'rules-title' }, icon('clock'), h('b', { text: S('rules_title') })),
          h('ul', {}, rules.map((r) => h('li', { text: r })))) : null,
        usageBox,
        p.notes ? h('div', {}, h('h2', { text: S('provider_notes_title') }), h('div', { class: 'notes', text: p.notes })) : null,
        h('a', { class: 'btn block', href: 'membership.html', text: isMember ? S('provider_cta_member') : S('provider_cta_guest') }),
        isCustomer ? h('a', { class: 'small center muted', href: `report.html?provider=${encodeURIComponent(p.id)}`, text: `${S('report_title')} →` }) : null)));
  if (isMember && (p.limit_count || p.allowed_days)) {
    const { data: u } = await sb.rpc('my_provider_usage', { p_provider: p.id });
    const t = usageText(u);
    if (t) usageBox.append(h('div', { class: `badge ${u.uses_left === 0 || u.valid_today === false ? 'bad' : 'ok'} usage`, text: t }));
  }
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
