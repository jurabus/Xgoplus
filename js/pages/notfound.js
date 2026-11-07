import { shell, S, h, $, clear } from '../common.js';

shell('').then(() => {
  clear($('#app')).append(h('div', { class: 'empty' }, h('h1', { text: 'Page not found' }), h('a', { class: 'btn ghost', href: 'index.html', text: S('nav_home') })));
}).catch(() => {});
