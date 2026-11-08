// About + contact (all text editable in admin → Texts & settings).
import { shell, S, h, $, clear, icon, logoSVG, mediaUrl } from '../common.js';

const app = $('#app');
async function main() {
  await shell('about');
  clear(app);
  const phone = String(S('contact_phone') || '');
  const wa = String(S('contact_whatsapp') || '').replace(/[^\d]/g, '');
  const email = String(S('contact_email') || '');
  const addr = String(S('contact_address') || '');
  const links = [
    phone && h('a', { href: `tel:${phone.replace(/[^\d+]/g, '')}` }, icon('phone'), phone),
    wa && h('a', { href: `https://wa.me/${wa}`, rel: 'noopener', target: '_blank' }, icon('wa'), 'WhatsApp'),
    /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(email) && h('a', { href: `mailto:${email}` }, icon('mail'), email),
    addr && h('a', { href: `https://maps.google.com/?q=${encodeURIComponent(addr)}`, rel: 'noopener', target: '_blank' }, icon('pin'), addr),
  ].filter(Boolean);
  app.append(
    h('section', { class: 'about-hero stack' },
      S('logo_path') ? h('img', { src: mediaUrl(S('logo_path')), alt: S('site_title') }) : logoSVG(),
      h('h1', {}, S('hero_title_1'), ' ', S('hero_title_2'))),
    h('section', { id: 'about', class: 'card stack' }, h('h2', { text: S('about_title') }), h('div', { class: 'about-text', text: S('about_text') }),
      h('a', { class: 'btn pill', href: 'offers.html' }, S('hero_cta'), icon('arrow'))),
    h('section', { id: 'contact', class: 'stack' }, h('h2', { text: S('contact_title') }),
      links.length ? h('div', { class: 'list contact-list' }, links) : h('p', { class: 'muted', text: '—' })));
  if (location.hash === '#contact') document.getElementById('contact').scrollIntoView();
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
