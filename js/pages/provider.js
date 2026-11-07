import { sb, shell, S, h, $, clear, mediaUrl, pct, initialOf, param } from '../common.js';

const app = $('#app');
async function main() {
  const ctx = await shell('home');
  clear(app);
  const id = param('id') || '';
  const { data: p } = /^[0-9a-f-]{36}$/i.test(id)
    ? await sb.from('providers').select('id,name,image_path,discount_percent,notes').eq('id', id).eq('is_active', true).maybeSingle()
    : { data: null };
  if (!p) {
    app.append(h('div', { class: 'empty' }, h('p', { text: 'This partner is not available.' }), h('a', { class: 'btn ghost', href: 'index.html', text: S('nav_home') })));
    return;
  }
  document.title = `${p.name} · ${S('site_title')}`;
  const isMember = ctx.role === 'customer' && ctx.membership?.status === 'active';
  app.append(
    h('a', { class: 'muted small', href: 'index.html', text: `← ${S('nav_home')}` }),
    h('div', { class: 'hero', },
      h('div', { class: 'img' }, p.image_path ? h('img', { src: mediaUrl(p.image_path), alt: p.name }) : h('span', { class: 'initial', text: initialOf(p.name) })),
      h('div', { class: 'body stack' },
        h('h1', { text: p.name }),
        h('div', { class: 'offpill' }, `${pct(p.discount_percent)}%`, h('small', { text: S('off_suffix').replace('%', '').trim() })),
        p.notes ? h('div', {}, h('h2', { text: S('provider_notes_title') }), h('div', { class: 'notes', text: p.notes })) : null,
        isMember
          ? h('a', { class: 'btn block', href: 'membership.html', text: S('provider_cta_member') })
          : h('a', { class: 'btn block', href: 'membership.html', text: S('provider_cta_guest') }))));
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
