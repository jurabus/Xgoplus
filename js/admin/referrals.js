// Referrals: program settings, cash-out queue, top referrers, member wallets.
import { sb, h, clear, errMsg, busy, toast, confirmDialog, fmtDate, fmtDateTime, localPhone, bustSettingsCache, moduleOn } from '../common.js';
import { sheet, field, input, textarea, checkbox, pagedList } from './ui.js';

const egp = (n) => `${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} EGP`;
const due = (w) => {
  if (w.status !== 'pending') return '';
  const ms = new Date(w.due_at) - Date.now();
  if (ms < 0) return `OVERDUE by ${Math.ceil(-ms / 36e5)}h`;
  return `due in ${Math.floor(ms / 864e5)}d ${Math.floor((ms % 864e5) / 36e5)}h`;
};
let root;

async function settingsCard() {
  const { data: row, error } = await sb.from('settings').select('data').eq('id', 1).single();
  if (error) return h('p', { class: 'form-error', text: errMsg(error) });
  const d = row.data || {};
  const pct = input({ type: 'number', min: 0, max: 100, step: 1, value: d.referral_commission_pct ?? 50 });
  const min = input({ type: 'number', min: 1, max: 100000, step: 1, value: d.referral_min_withdrawal ?? 100 });
  const days = input({ type: 'number', min: 1, max: 30, step: 1, value: d.referral_payout_days ?? 3 });
  const renew = checkbox(!!d.referral_on_renewals);
  const price = Number(d.membership_price_egp ?? 199);
  const preview = h('small', { class: 'muted' });
  const upd = () => { preview.textContent = `A referred member paying ${price} EGP earns their referrer ${Math.round((price * Number(pct.value || 0)) / 100)} EGP.`; };
  pct.addEventListener('input', upd); upd();
  const save = h('button', { class: 'btn block', type: 'button', text: 'Save program settings' });
  save.addEventListener('click', async () => {
    const p = Number(pct.value), m = Number(min.value), dd = Number(days.value);
    if (!(p >= 0 && p <= 100) || !(m >= 1) || !(dd >= 1 && dd <= 30) || !Number.isInteger(m) || !Number.isInteger(dd)) { toast('Check the numbers.', 'bad'); return; }
    busy(save, true);
    const { data: cur } = await sb.from('settings').select('data').eq('id', 1).single();
    const { error: e } = await sb.from('settings').update({ data: { ...(cur?.data || d), referral_commission_pct: p, referral_min_withdrawal: m, referral_payout_days: dd, referral_on_renewals: renew.checked } }).eq('id', 1);
    busy(save, false);
    if (e) { toast(errMsg(e), 'bad'); return; }
    bustSettingsCache(); toast('Saved');
  });
  return h('div', { class: 'card stack' }, h('h2', { text: 'Program settings' }),
    moduleOn('referrals') ? null : h('p', { class: 'pay-note bad', text: 'The referral program is switched off in Modules. Members can’t see it or request cash-outs.' }),
    field('Commission (% of the yearly membership price)', pct, 'Rounded to the nearest pound.'), preview,
    field('Minimum cash-out (EGP)', min), field('Pay cash-outs within (days)', days, 'Shown to members as the deadline.'),
    h('label', { class: 'switch' }, h('span', {}, h('b', { text: 'Also pay on renewals' }), h('br'), h('small', { class: 'muted', text: 'Off: only the friend’s first paid year earns a commission.' })), renew),
    save);
}

function statsCard(o) {
  const st = (v, l, cls = '') => h('div', { class: `stat ${cls}` }, h('b', { text: v }), h('span', { text: l }));
  return h('div', { class: 'stats' },
    st(String(o.referred_members), 'Members who joined with a code'), st(String(o.paid_referrals), 'Paid referrals'),
    st(egp(o.commissions_total), 'Commissions earned'), st(egp(o.balances_total), 'Owed in wallets'),
    st(egp(o.paid_out), 'Paid out'), st(`${o.pending_count} · ${egp(o.pending_total)}`, 'Pending cash-outs', o.pending_count ? 'hl' : ''),
    st(String(o.overdue_count), 'Overdue', o.overdue_count ? 'hl' : ''));
}

function decide(w, reload) {
  const ref = input({ maxlength: 60, placeholder: 'InstaPay / wallet transfer reference' });
  const note = textarea('', { maxlength: 200, rows: 2, placeholder: 'Note to the member (required to reject)' });
  const paid = h('button', { class: 'btn block', type: 'button', text: `Mark ${egp(w.amount)} as paid` });
  const rej = h('button', { class: 'btn block ghost danger', type: 'button', text: 'Reject & return money to wallet' });
  const s = sheet(`Cash-out · ${w.member_name}`,
    h('div', { class: 'card-sub stack' },
      h('div', {}, h('b', { text: egp(w.amount) }), ` via ${w.method === 'instapay' ? 'InstaPay' : 'mobile wallet'}`),
      h('div', { class: 'pay-value', text: localPhone(w.phone) }),
      h('small', { class: 'muted', text: `Requested ${fmtDateTime(w.created_at)} · ${due(w)} · member ${localPhone(w.member_phone)} · ${w.referrals_paid} paid referrals · balance left ${egp(w.balance)}` })),
    h('p', { class: 'small', text: `Send ${egp(w.amount)} to ${localPhone(w.phone)} first, then mark it paid.` }),
    field('Transfer reference', ref), field('Note', note), paid, rej);
  const go = async (isPaid, btn) => {
    if (!isPaid && note.value.trim().length < 3) { toast('Write why you reject it.', 'bad'); note.focus(); return; }
    if (isPaid && !(await confirmDialog(`Confirm you sent ${egp(w.amount)} to ${localPhone(w.phone)}?`, 'Yes, paid'))) return;
    busy(btn, true);
    const { error } = await sb.rpc('admin_decide_withdrawal', { p_id: w.id, p_paid: isPaid, p_transfer_ref: ref.value.trim(), p_note: note.value.trim() });
    busy(btn, false);
    if (error) { toast(errMsg(error), 'bad'); return; }
    s.close(); toast(isPaid ? 'Marked paid' : 'Rejected — money returned'); reload();
  };
  paid.addEventListener('click', () => go(true, paid));
  rej.addEventListener('click', () => go(false, rej));
}

function queue(reloadAll) {
  const wrap = h('div', { class: 'stack' }, h('h2', { text: 'Cash-out requests' }));
  const seg = h('div', { class: 'seg' });
  let status = 'pending';
  const body = h('div');
  const draw = () => {
    clear(seg).append(...[['pending', 'Pending'], ['paid', 'Paid'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled'], ['', 'All']].map(([v, l]) =>
      h('button', { type: 'button', class: v === status ? 'active' : '', text: l, onclick: () => { status = v; draw(); } })));
    clear(body);
    pagedList(body, async (offset, limit) => {
      const { data, error } = await sb.rpc('admin_list_withdrawals', { p_status: status, p_limit: limit, p_offset: offset });
      if (error) { toast(errMsg(error), 'bad'); return { rows: [], total: 0 }; }
      return { rows: data || [], total: data?.[0]?.total ?? 0 };
    }, (w) => {
      const late = w.status === 'pending' && new Date(w.due_at) < Date.now();
      const row = h(w.status === 'pending' ? 'button' : 'div', { class: 'item', type: w.status === 'pending' ? 'button' : null },
        h('div', { class: 'grow' },
          h('b', { text: `${egp(w.amount)} → ${w.method === 'instapay' ? 'InstaPay' : 'Wallet'} ${localPhone(w.phone)}` }),
          h('div', { class: 'small muted', text: `${w.member_name} · ${fmtDateTime(w.created_at)}${w.status === 'pending' ? ` · ${due(w)}` : w.decided_at ? ` · decided ${fmtDate(w.decided_at)}` : ''}${w.transfer_ref ? ` · ref ${w.transfer_ref}` : ''}` }),
          w.admin_note ? h('div', { class: 'small', text: w.admin_note }) : null),
        h('span', { class: `badge ${late ? 'bad' : { pending: 'warn', paid: 'ok', rejected: 'bad' }[w.status] || ''}`, text: late ? 'overdue' : w.status }));
      if (w.status === 'pending') row.addEventListener('click', () => decide(w, () => { draw(); reloadAll(); }));
      return row;
    }).load();
  };
  draw();
  wrap.append(seg, body);
  return wrap;
}

async function walletSheet(uid, name) {
  const { data: w, error } = await sb.rpc('admin_member_wallet', { p_user: uid });
  if (error || !w) { toast(errMsg(error || 'not_found'), 'bad'); return; }
  const amt = input({ type: 'number', step: 1, placeholder: 'e.g. 50 or -50' });
  const note = input({ maxlength: 200, placeholder: 'Reason (required, kept in the log)' });
  const go = h('button', { class: 'btn block', type: 'button', text: 'Apply adjustment' });
  const s = sheet(`Wallet · ${name}`,
    h('div', { class: 'stats' }, h('div', { class: 'stat hl' }, h('b', { text: egp(w.balance) }), h('span', { text: 'Balance' })),
      h('div', { class: 'stat' }, h('b', { text: w.code || '—' }), h('span', { text: 'Referral code' }))),
    w.referred_by ? h('p', { class: 'small muted', text: `Invited by ${w.referred_by}` }) : null,
    h('h3', { text: `Friends (${w.friends.length})` }),
    h('div', { class: 'list' }, w.friends.length ? w.friends.map((f) => h('div', { class: 'item' },
      h('div', { class: 'grow' }, h('b', { text: f.name }), h('div', { class: 'small muted', text: `${localPhone(f.phone)} · ${fmtDate(f.joined_at)}` })),
      h('span', { class: `badge ${f.paid ? 'ok' : ''}`, text: f.paid ? 'paid' : 'not yet' }))) : h('div', { class: 'empty', text: 'No friends yet.' })),
    h('h3', { text: 'Activity' }),
    h('div', { class: 'list' }, w.entries.length ? w.entries.map((e) => h('div', { class: 'item' },
      h('div', { class: 'grow' }, h('div', { text: e.note || e.kind }), h('div', { class: 'small muted', text: `${e.kind} · ${fmtDateTime(e.at)}` })),
      h('b', { class: Number(e.amount) > 0 ? 'plus' : 'minus', text: `${Number(e.amount) > 0 ? '+' : ''}${Number(e.amount)}` }))) : h('div', { class: 'empty', text: 'No activity.' })),
    h('div', { class: 'card-sub stack' }, h('b', { text: 'Manual adjustment' }), field('Amount (EGP, negative to deduct)', amt), field('Reason', note), go));
  go.addEventListener('click', async () => {
    busy(go, true);
    const { error: e } = await sb.rpc('admin_wallet_adjust', { p_user: uid, p_amount: Number(amt.value), p_note: note.value });
    busy(go, false);
    if (e) { toast(errMsg(e), 'bad'); return; }
    toast('Adjusted'); s.close(); walletSheet(uid, name);
  });
}

function topCard(o) {
  const q = input({ type: 'search', placeholder: 'Find a member wallet by name or phone' });
  const res = h('div', { class: 'list' });
  let t;
  q.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      clear(res);
      if (q.value.trim().length < 2) return;
      const { data } = await sb.rpc('admin_list_members', { p_search: q.value.trim(), p_limit: 8, p_offset: 0 });
      (data || []).forEach((m) => {
        const name = `${m.first_name} ${m.last_name}`;
        res.append(h('button', { class: 'item', type: 'button', onclick: () => walletSheet(m.id, name) },
          h('b', { class: 'grow', text: name }), h('span', { class: 'small muted', text: localPhone(m.phone) })));
      });
    }, 300);
  });
  return h('div', { class: 'stack' }, h('h2', { text: 'Top referrers' }), q, res,
    h('div', { class: 'list' }, o.top.length ? o.top.map((r) => h('button', { class: 'item', type: 'button', onclick: () => walletSheet(r.id, r.name) },
      h('div', { class: 'grow' }, h('b', { text: r.name }), h('div', { class: 'small muted', text: `${r.code} · ${localPhone(r.phone)} · ${r.joined} joined · ${r.paid} paid` })),
      h('div', { class: 'center' }, h('b', { text: egp(r.earned) }), h('div', { class: 'small muted', text: `bal ${egp(r.balance)}` })))) : h('div', { class: 'empty', text: 'No referrals yet.' })));
}

export async function render(el) {
  root = el;
  const load = async () => {
    const { data: o, error } = await sb.rpc('admin_referral_overview');
    if (error || !o) { clear(root).append(h('p', { class: 'form-error', text: errMsg(error || 'forbidden') })); return; }
    const statsSlot = h('div');
    clear(root).append(statsSlot);
    statsSlot.append(statsCard(o));
    root.append(queue(async () => {
      const { data } = await sb.rpc('admin_referral_overview');
      if (data) clear(statsSlot).append(statsCard(data));
    }), topCard(o), await settingsCard());
  };
  await load();
}
