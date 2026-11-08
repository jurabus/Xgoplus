// Payments: mode (free / active / inactive), price, rotation, InstaPay addresses + Vodafone Cash
// numbers, and membership requests with the transfer screenshot (private storage, signed link).
import { sb, h, clear, errMsg, busy, toast, confirmDialog, fmtDateTime, localPhone, bustSettingsCache } from '../common.js';
import { sheet, field, input, checkbox, textarea, pagedList } from './ui.js';

const LABEL = { instapay: 'InstaPay', vodafone: 'Vodafone Cash' };
let root, status = 'pending', reqList;

async function settingsCard() {
  const [{ data: row }, { data: ov }] = await Promise.all([
    sb.from('settings').select('data').eq('id', 1).single(), sb.rpc('admin_payment_overview')]);
  const d = row?.data || {};
  const mode = ov?.mode || 'free';
  const name = `mode-${Date.now()}`;
  const radio = (v, title, sub) => {
    const r = h('input', { type: 'radio', name, value: v }); r.checked = mode === v;
    return h('label', { class: 'radio' }, r, h('span', {}, h('b', { text: title }), h('br'), h('small', { class: 'muted', text: sub })));
  };
  const price = input({ type: 'number', min: 0, step: 1, value: d.membership_price_egp ?? 199 });
  const every = input({ type: 'number', min: 1, max: 1000, step: 1, value: ov?.rotate_every ?? 5 });
  const trial = checkbox(d.trial_enabled !== false);
  const save = h('button', { class: 'btn', type: 'submit', text: 'Save' });
  const form = h('form', { class: 'card stack' }, h('b', { text: 'Membership sign-up' }),
    h('div', { class: 'radios' },
      radio('free', 'Free', 'Customers subscribe instantly for free (testing).'),
      radio('active', 'Paid — requests open', 'Customers pay by InstaPay / Vodafone Cash and send a screenshot; you approve.'),
      radio('inactive', 'Closed', 'Nobody can subscribe or send requests right now.')),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Price (EGP / year)', price)),
      h('div', { class: 'grow' }, field('Switch account every N requests', every))),
    h('label', { class: 'switch' }, h('span', {}, h('b', { text: 'Free trial' }), h('br'), h('small', { class: 'muted', text: 'Each new customer can get 1 free discounted scan.' })), trial),
    save);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const m = form.querySelector('input[type=radio]:checked')?.value || 'free';
    const data = { ...d, payment_mode: m, membership_price_egp: Math.max(0, Number(price.value) || 0),
      payment_rotate_every: Math.min(1000, Math.max(1, Math.trunc(Number(every.value) || 1))), membership_free: m === 'free',
      trial_enabled: trial.checked };
    busy(save, true);
    const { error } = await sb.from('settings').update({ data, updated_at: new Date().toISOString() }).eq('id', 1);
    busy(save, false);
    if (error) { toast(errMsg(error), 'bad'); return; }
    bustSettingsCache(); toast('Saved'); draw();
  });
  return { el: form, ov };
}

function accountSheet(a, method, nextSort) {
  const isNew = !a;
  a = a || { method, value: '', label: '', sort_order: nextSort, is_active: true };
  const value = input({ value: a.value, maxlength: 120, placeholder: a.method === 'vodafone' ? '01xxxxxxxxx' : 'name@instapay', inputmode: a.method === 'vodafone' ? 'tel' : 'text' });
  const label = input({ value: a.label, maxlength: 60, placeholder: 'Optional note (e.g. account owner)' });
  const link = input({ value: a.pay_link || '', maxlength: 200, placeholder: 'https://ipn.eg/S/name/instapay/XXXXXX', inputmode: 'url', autocapitalize: 'none' });
  const sort = input({ type: 'number', step: 1, value: a.sort_order });
  const active = checkbox(a.is_active);
  const err = h('div', { class: 'form-error' });
  const save = h('button', { class: 'btn block', type: 'submit', text: 'Save' });
  const del = isNew ? null : h('button', { class: 'btn block danger', type: 'button', text: 'Delete' });
  const form = h('form', { class: 'stack' },
    field(a.method === 'vodafone' ? 'Vodafone Cash number' : 'InstaPay address', value),
    a.method === 'instapay' ? field('InstaPay payment link (for the “Pay in InstaPay app” button)', link,
      'In the InstaPay app: open this account → Share / “IPA link” → copy. It looks like https://ipn.eg/S/name/instapay/AbC123') : null,
    field('Note (only you see it)', label),
    field('Order in rotation (lower first)', sort), h('label', { class: 'switch' }, h('span', { text: 'In rotation' }), active), err, save, del);
  const s = sheet(`${isNew ? 'Add' : 'Edit'} ${LABEL[a.method]}`, form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    const row = { value: value.value.trim(), label: label.value.trim(), sort_order: Math.trunc(Number(sort.value) || 0), is_active: active.checked };
    if (a.method === 'instapay') {
      const l = link.value.trim();
      if (l && !/^https:\/\/ipn\.eg\/S\/[A-Za-z0-9._-]+\/instapay\/[A-Za-z0-9]+$/.test(l)) { err.textContent = errMsg('payment_accounts_pay_link_check'); return; }
      row.pay_link = l || null;
    }
    busy(save, true);
    const { error } = isNew ? await sb.from('payment_accounts').insert({ ...row, method: a.method }) : await sb.from('payment_accounts').update(row).eq('id', a.id);
    busy(save, false);
    if (error) { err.textContent = errMsg(error); return; }
    s.close(); toast('Saved'); draw();
  });
  del?.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete this account? Past requests keep the number they used.', 'Delete', true))) return;
    const { error } = await sb.from('payment_accounts').delete().eq('id', a.id);
    if (error) { toast(errMsg(error), 'bad'); return; }
    s.close(); draw();
  });
}

async function accountsCard(ov) {
  const { data, error } = await sb.from('payment_accounts').select('*').order('sort_order').order('created_at').limit(200);
  const card = h('div', { class: 'card stack' }, h('b', { text: 'Where customers send money' }),
    h('p', { class: 'small muted', text: `Customers see one account at a time. After every ${ov?.rotate_every ?? 5} submitted requests the next active account in the list is used, so no single account hits its daily/monthly limit.` }));
  if (error) { card.append(h('p', { class: 'form-error', text: errMsg(error) })); return card; }
  for (const m of ['instapay', 'vodafone']) {
    const rows = data.filter((r) => r.method === m);
    const cur = ov?.current?.[m];
    const list = h('div', { class: 'list' });
    if (!rows.length) list.append(h('div', { class: 'empty', text: `No ${LABEL[m]} accounts yet.` }));
    rows.forEach((r) => list.append(h('button', { class: `item btn-reset${r.id === cur ? ' current-acc' : ''}`, type: 'button', onclick: () => accountSheet(r) },
      h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, h('b', { text: r.value })),
        h('div', { class: 'small muted', text: `${r.uses_count} requests${r.label ? ` · ${r.label}` : ''}${m === 'instapay' ? (r.pay_link ? ' · app link ✓' : ' · no app link') : ''}` })),
      r.id === cur ? h('span', { class: 'badge brand', text: 'Showing now' }) : null,
      h('span', { class: `badge ${r.is_active ? 'ok' : 'bad'}`, text: r.is_active ? 'On' : 'Off' }))));
    card.append(h('div', { class: 'row' }, h('span', { class: `pm-tag ${m}`, text: LABEL[m] }), h('div', { class: 'grow' }),
      h('button', { class: 'btn sm', type: 'button', text: '+ Add', onclick: () => accountSheet(null, m, (rows.at(-1)?.sort_order || 0) + 10) })), list);
  }
  return card;
}

async function requestSheet(r) {
  const img = h('div', {}, h('div', { class: 'spinner' }));
  const note = textarea(r.admin_note || '', { rows: 2, maxlength: 500, placeholder: 'Message to the customer (shown if rejected)' });
  const approve = h('button', { class: 'btn grow', type: 'button', text: 'Approve & activate' });
  const reject = h('button', { class: 'btn danger grow', type: 'button', text: 'Reject' });
  const s = sheet('Membership request', h('div', { class: 'stack' },
    h('div', { class: 'card stack' },
      h('div', { class: 'row' }, h('b', { class: 'grow', text: r.member_name }), h('span', { class: `pm-tag ${r.method}`, text: LABEL[r.method] })),
      h('div', { class: 'small' }, 'Phone: ', h('a', { href: `tel:+${r.member_phone}`, text: localPhone(r.member_phone) }), ` · membership now: ${r.member_status}`),
      h('div', { class: 'small' }, `Amount: ${Number(r.amount_egp)} EGP · sent to: `, h('b', { text: r.account_value })),
      r.sender_info ? h('div', { class: 'small', text: `Sender: ${r.sender_info}` }) : null,
      h('div', { class: 'small muted', text: `Submitted ${fmtDateTime(r.submitted_at)}${r.decided_at ? ` · decided ${fmtDateTime(r.decided_at)}` : ''}` })),
    img,
    r.status === 'pending' ? [field('Note', note), h('div', { class: 'row' }, reject, approve)]
      : h('div', { class: 'card small', text: `Status: ${r.status}${r.admin_note ? ` — ${r.admin_note}` : ''}` })));
  if (r.proof_path) {
    const { data, error } = await sb.storage.from('proofs').createSignedUrl(r.proof_path, 300);
    clear(img).append(error ? h('p', { class: 'form-error', text: errMsg(error) })
      : h('a', { href: data.signedUrl, target: '_blank', rel: 'noopener' }, h('img', { class: 'proof-img', src: data.signedUrl, alt: 'Transfer screenshot' })));
  } else clear(img);
  const decide = async (ok, btn) => {
    if (!ok && !note.value.trim() && !(await confirmDialog('Reject without a note to the customer?', 'Reject', true))) return;
    busy(btn, true);
    const { error } = await sb.rpc('admin_decide_request', { p_id: r.id, p_approve: ok, p_note: note.value.trim() });
    busy(btn, false);
    if (error) { toast(errMsg(error), 'bad'); return; }
    s.close(); toast(ok ? 'Approved — membership is active' : 'Rejected'); reqList.load();
  };
  approve.addEventListener('click', () => decide(true, approve));
  reject.addEventListener('click', () => decide(false, reject));
}

async function draw() {
  clear(root).append(h('h1', { text: 'Payments' }));
  const { el, ov } = await settingsCard();
  const seg = h('div', { class: 'seg' });
  const drawSeg = () => clear(seg).append(...[['pending', 'Waiting'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['', 'All']].map(([v, l]) =>
    h('a', { href: '#payments', class: v === status ? 'active' : '', text: v === 'pending' && ov?.pending ? `${l} (${ov.pending})` : l, onclick: (e) => { e.preventDefault(); status = v; drawSeg(); reqList.reset(); } })));
  drawSeg();
  const reqBox = h('div');
  root.append(h('h2', { text: 'Requests' }), seg, reqBox, h('h2', { text: 'Settings' }), el, await accountsCard(ov));
  reqList = pagedList(reqBox, async (offset, limit) => {
    const { data, error } = await sb.rpc('admin_list_requests', { p_status: status, p_limit: limit, p_offset: offset });
    if (error) { toast(errMsg(error), 'bad'); return { rows: [], total: 0 }; }
    return { rows: data || [], total: data?.[0]?.total ?? (offset ? null : 0) };
  }, (r) => h('button', { class: 'item btn-reset', type: 'button', onclick: () => requestSheet(r) },
    h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, h('b', { text: r.member_name }), ` · ${Number(r.amount_egp)} EGP`),
      h('div', { class: 'small muted', text: `${LABEL[r.method]} → ${r.account_value} · ${fmtDateTime(r.submitted_at)}` })),
    h('span', { class: `badge ${r.status === 'pending' ? 'warn' : r.status === 'approved' ? 'ok' : 'bad'}`, text: r.status })));
  reqList.load();
}

export async function render(r) { root = r; await draw(); }
