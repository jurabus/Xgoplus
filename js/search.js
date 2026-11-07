// Header search (Amazon-style): live top-5 suggestions with image + name,
// "View all" -> search.html?q=… . Typo tolerance is done by the database.
import { sb, S, h, clear, icon, mediaUrl, pct, initialOf } from './common.js';

export const SUGGEST_LIMIT = 5;

export function mountSearch(topbar, initial = '') {
  const input = h('input', {
    class: 'input', type: 'search', enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false',
    placeholder: S('search_placeholder'), 'aria-label': S('search_placeholder'), maxlength: 60,
    role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'search-pop', 'aria-autocomplete': 'list',
  });
  input.value = initial;
  const clearBtn = h('button', { class: 'search-clear', type: 'button', 'aria-label': 'Clear', hidden: !initial }, icon('x'));
  const go = h('button', { class: 'search-go', type: 'submit', 'aria-label': 'Search' }, icon('search'));
  const pop = h('div', { class: 'search-pop', id: 'search-pop', role: 'listbox', hidden: true });
  const form = h('form', { class: 'hsearch', role: 'search', action: 'search.html' }, input, clearBtn, go, pop);
  topbar.append(form);

  let seq = 0, timer = 0, active = -1, items = [];
  const open = (on) => { pop.hidden = !on; input.setAttribute('aria-expanded', String(on)); };
  const goAll = (q) => { location.href = `search.html?q=${encodeURIComponent(q.trim())}`; };
  const setActive = (i) => {
    active = i;
    items.forEach((el, k) => { el.classList.toggle('active', k === i); el.setAttribute('aria-selected', String(k === i)); });
    if (items[i]) items[i].scrollIntoView({ block: 'nearest' });
  };

  async function suggest() {
    const q = input.value.trim();
    clearBtn.hidden = !input.value;
    if (!q) { open(false); clear(pop); return; }
    const my = ++seq;
    if (!pop.childElementCount) pop.append(h('div', { class: 'spinner' }));
    open(true);
    const { data, error } = await sb.rpc('search_providers', { p_q: q, p_category: null, p_limit: SUGGEST_LIMIT, p_offset: 0 });
    if (my !== seq) return; // a newer keystroke won
    clear(pop); active = -1;
    if (error) { pop.append(h('div', { class: 'search-empty', text: 'Search is unavailable right now.' })); return; }
    items = data.map((p, i) => h('a', { class: 'sug', role: 'option', id: `sug-${i}`, href: `provider.html?id=${encodeURIComponent(p.id)}` },
      p.image_path ? h('img', { src: mediaUrl(p.image_path), alt: '', loading: 'lazy', width: 44, height: 44 }) : h('span', { class: 'thumb', text: initialOf(p.name) }),
      h('span', { class: 'sug-name' }, highlight(p.name, q)),
      h('span', { class: 'sug-off', text: `${pct(p.discount_percent)}%` })));
    if (!items.length) pop.append(h('div', { class: 'search-empty', text: `${S('search_no_results')} “${q}”` }));
    pop.append(...items);
    if (items.length) pop.append(h('button', { class: 'btn block ghost sug-all', type: 'button', text: S('search_view_all'), onclick: () => goAll(q) }));
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(suggest, 180); });
  input.addEventListener('focus', () => { if (input.value.trim()) suggest(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); setActive((active + 1) % items.length); }
    else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); setActive(active <= 0 ? items.length - 1 : active - 1); }
    else if (e.key === 'Escape') { open(false); input.blur(); }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (active >= 0 && items[active]) { location.href = items[active].getAttribute('href'); return; }
    if (input.value.trim()) goAll(input.value);
  });
  clearBtn.addEventListener('click', () => { input.value = ''; clearBtn.hidden = true; open(false); clear(pop); input.focus(); });
  document.addEventListener('pointerdown', (e) => { if (!form.contains(e.target)) open(false); });
  return input;
}

// Bold the part of the name that matches the query (text nodes only — no HTML injection).
function highlight(name, q) {
  const i = name.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0 || !q) return name;
  return [name.slice(0, i), h('b', { text: name.slice(i, i + q.length) }), name.slice(i + q.length)];
}
