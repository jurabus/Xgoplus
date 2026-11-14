// Member interests: what members use XGo+ for, worked out from their scans.
// Interest % = scans in a category / all of the member's lifetime scans.
import { sb, h, clear, errMsg, busy, toast, localPhone, catIcon, pct } from '../common.js';
import { sheet, field, input } from './ui.js';

let root;

function bar(v) { return h('div', { class: 'bar' }, h('i', { 'data-w': v })); }
function fill(el) { el.querySelectorAll('.bar > i').forEach((i) => { i.style.width = `${Math.min(100, Number(i.dataset.w) || 0)}%`; }); }

async function rankingSheet(cat, minPct) {
  const min = input({ type: 'number', min: 0, max: 100, step: 1, value: minPct });
  const go = h('button', { class: 'btn', type: 'button', text: 'Show' });
  const listEl = h('div', { class: 'list' });
  sheet(`${cat.name} · most interested members`, h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Minimum interest %', min)), go), listEl);
  async function load() {
    busy(go, true);
    const { data, error } = await sb.rpc('admin_interest_members', { p_category: cat.id, p_min_pct: Number(min.value) || 0, p_limit: 200 });
    busy(go, false);
    clear(listEl);
    if (error) { listEl.append(h('p', { class: 'form-error', text: errMsg(error) })); return; }
    if (!data?.length) { listEl.append(h('div', { class: 'empty', text: 'No members at this level yet.' })); return; }
    for (const m of data) {
      listEl.append(h('div', { class: 'item' },
        h('div', { class: 'grow int-row' },
          h('div', { class: 'row' }, h('b', { class: 'grow', text: `${m.first_name} ${m.last_name}` }), h('b', { text: `${pct(m.pct)}%` })),
          bar(m.pct),
          h('div', { class: 'small muted' }, h('a', { href: `tel:+${m.phone}`, text: localPhone(m.phone) }), ` · ${m.scans} of ${m.total} scans`))));
    }
    fill(listEl);
  }
  go.addEventListener('click', load);
  load();
}

async function draw() {
  clear(root).append(h('h1', { text: 'Member interests' }),
    h('p', { class: 'muted small', text: 'Worked out from scans: each counted scan adds to the partner\'s category. A member\'s interest in a category = its share of all their lifetime scans. Explore ads use this to reach the right members.' }));
  const { data, error } = await sb.rpc('admin_interest_summary');
  if (error || !data) { root.append(h('p', { class: 'form-error', text: error ? `${errMsg(error)} — run update 013.` : 'Not allowed.' })); return; }
  root.append(h('div', { class: 'stats' },
    h('div', { class: 'stat' }, h('b', { text: String(data.members_with_scans) }), h('span', { text: 'Members with scans' })),
    h('div', { class: 'stat' }, h('b', { text: String(data.total_scans) }), h('span', { text: 'Counted scans' })),
    h('div', { class: 'stat' }, h('b', { text: `${pct(data.min_pct)}%` }), h('span', { text: 'Interested from' }))),
    h('p', { class: 'small muted', text: `"Interested" = at least ${pct(data.min_pct)}% of their scans in that category and ${data.min_scans}+ lifetime scans (change in Explore ads → Targeting).` }));
  const list = h('div', { class: 'list' });
  for (const c of data.categories) {
    list.append(h('button', { class: 'item btn-reset', type: 'button', onclick: () => rankingSheet(c, data.min_pct) },
      h('span', { class: 'thumb' }, catIcon(c.icon)),
      h('div', { class: 'grow int-row' },
        h('div', { class: 'row' }, h('b', { class: 'grow ellipsis', text: `${c.name}${c.is_active ? '' : ' (hidden)'}` }), h('b', { text: `${pct(c.share)}%` })),
        bar(c.share),
        h('div', { class: 'small muted', text: `${c.scans} scans · ${c.members} members · ${c.interested} interested${c.avg_pct != null ? ` · avg ${pct(c.avg_pct)}%` : ''}` }))));
  }
  if (!data.categories.length) list.append(h('div', { class: 'empty', text: 'No categories yet.' }));
  root.append(h('h2', { text: 'Share of scans by category' }), list);
  fill(root);
}

export async function render(r) { root = r; try { await draw(); } catch (e) { toast(errMsg(e), 'bad'); } }
