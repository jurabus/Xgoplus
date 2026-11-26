// Invite & earn: referral code, sharing, wallet, cash-out requests.
import {
  sb, shell, h, $, clear, errMsg, busy, toast, icon, localPhone, confirmDialog,
  T, L, cur, lang, langScope, langToggle, fmtDateL as fmtDate,
  shareSheet, referralLink, moduleOn, getContext,
} from '../common.js';

const app = $('#app');
const tpl = (t, v) => String(t).replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
const egp = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const day = (d) => new Intl.DateTimeFormat(lang() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(d));

function steps(o) {
  return h('ol', { class: 'earn-steps' },
    [T('earn_step1'), T('earn_step2'), tpl(T('earn_step3'), { amount: egp(o.commission) }), T('earn_step4')]
      .map((t, i) => h('li', {}, h('span', { class: 'n', text: String(i + 1) }), h('span', { text: t }))));
}

function hero(o, rerender) {
  return h('section', { class: 'earn-hero' }, langToggle(rerender, 'on-dark'),
    h('div', { class: 'earn-amount' }, h('b', { text: egp(o.commission) }), h('span', { text: cur() })),
    h('h1', { text: T('earn_title') }),
    h('p', { text: tpl(T('earn_hero_text'), { amount: egp(o.commission), pct: egp(o.commission_pct) }) }));
}

function tips() {
  return h('div', { class: 'card stack' }, h('b', { text: T('earn_tips_title') }),
    h('ul', { class: 'earn-tips' }, [T('earn_tip1'), T('earn_tip2'), T('earn_tip3')].map((t) => h('li', { text: t }))));
}

function codeCard(sm) {
  const link = referralLink(sm.code);
  const text = tpl(T('earn_share_text'), { code: sm.code });
  const copy = h('button', { class: 'btn sm light', type: 'button' }, icon('copy'), h('span', { text: T('earn_copy_link') }));
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link); toast(T('earn_copied')); } catch { toast(link); }
  });
  return h('section', { class: 'earn-code card stack' },
    h('small', { class: 'muted', text: T('earn_your_code') }),
    h('div', { class: 'earn-code-row' }, h('b', { class: 'code', text: sm.code }), copy),
    h('div', { class: 'small muted ellipsis', text: link }),
    h('a', { class: 'btn block wa', href: `https://wa.me/?text=${encodeURIComponent(`${text}\n${link}`)}`, target: '_blank', rel: 'noopener' },
      icon('wa'), h('span', { text: T('earn_share_whatsapp') })),
    h('button', { class: 'btn block ghost', type: 'button', onclick: () => shareSheet({ url: link, text, title: T('earn_share_more') }) },
      icon('share'), h('span', { text: T('earn_share_more') })));
}

function stats(sm) {
  const st = (v, l, cls = '') => h('div', { class: `stat ${cls}` }, h('b', { text: v }), h('span', { text: l }));
  return h('div', { class: 'stats earn-stats' },
    st(`${egp(sm.balance)} ${cur()}`, T('earn_balance'), 'hl'), st(`${egp(sm.earned)} ${cur()}`, T('earn_earned')),
    st(String(sm.joined), T('earn_joined')), st(String(sm.paid), T('earn_paid')));
}

function walletUse(sm, reload) {
  if (sm.payment_mode !== 'active' || Number(sm.balance) < Number(sm.price)) return null;
  const btn = h('button', { class: 'btn block', type: 'button', text: tpl(T('earn_use_balance'), { price: egp(sm.price) }) });
  btn.addEventListener('click', async () => {
    if (!(await confirmDialog(tpl(T('earn_use_confirm'), { price: egp(sm.price) }), L('Pay', 'ادفع')))) return;
    busy(btn, true);
    const { error } = await sb.rpc('pay_membership_with_wallet');
    busy(btn, false);
    if (error) { toast(errMsg(error), 'bad'); return; }
    toast(T('earn_use_done')); await getContext(true); reload();
  });
  return btn;
}

function withdrawCard(sm, ctx, reload) {
  const pending = sm.withdrawals.find((w) => w.status === 'pending');
  const card = h('section', { class: 'card stack' }, h('h2', { text: T('earn_withdraw_title') }),
    h('p', { class: 'small muted', text: tpl(T('earn_withdraw_text'), { min: egp(sm.min_withdrawal), days: egp(sm.payout_days) }) }));
  if (pending) {
    card.append(h('div', { class: 'badge usage warn', text: `${egp(pending.amount)} ${cur()} · ${pending.overdue ? T('earn_wd_overdue') : tpl(T('earn_wd_pending'), { date: day(pending.due_at) })}` }));
    return card;
  }
  const bal = Number(sm.balance), min = Number(sm.min_withdrawal);
  if (bal < min) {
    card.append(h('div', { class: 'earn-progress' }, h('i', { 'data-w': Math.min(100, (100 * bal) / (min || 1)) })),
      h('p', { class: 'small', text: tpl(T('earn_withdraw_need'), { min: egp(min), left: egp(min - bal) }) }));
    queueMicrotask(() => card.querySelectorAll('.earn-progress > i').forEach((i) => { i.style.width = `${i.dataset.w}%`; }));
    return card;
  }
  const amount = h('input', { class: 'input', type: 'number', inputmode: 'numeric', min, max: Math.floor(bal), step: 1, value: Math.floor(bal) });
  const method = h('div', { class: 'seg' });
  let m = 'instapay';
  const drawSeg = () => clear(method).append(...[['instapay', T('earn_withdraw_instapay')], ['wallet', T('earn_withdraw_wallet')]].map(([v, l]) =>
    h('button', { type: 'button', class: v === m ? 'active' : '', text: l, onclick: () => { m = v; drawSeg(); } })));
  drawSeg();
  const phone = h('input', { class: 'input', type: 'tel', inputmode: 'tel', maxlength: 16, value: localPhone(ctx.profile.phone), autocomplete: 'tel' });
  const err = h('div', { class: 'form-error' });
  const go = h('button', { class: 'btn block', type: 'submit', text: T('earn_withdraw_submit') });
  const form = h('form', { class: 'stack', novalidate: true },
    h('label', { class: 'field' }, h('span', { text: T('earn_withdraw_amount') }), amount),
    h('div', { class: 'field' }, h('span', { text: T('earn_withdraw_method') }), method),
    h('label', { class: 'field' }, h('span', { text: T('earn_withdraw_phone') }), phone, h('small', { class: 'muted', text: T('earn_withdraw_phone_hint') })),
    err, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    const a = Number(amount.value);
    if (!Number.isInteger(a) || a < min || a > bal) { err.textContent = tpl(T('earn_withdraw_text'), { min: egp(min), days: egp(sm.payout_days) }); return; }
    let ph = phone.value.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '');
    if (/^(20|0020)1\d{9}$/.test(ph)) ph = `0${ph.replace(/^(0020|20)/, '')}`;
    if (!/^01\d{9}$/.test(ph)) { err.textContent = errMsg('payout_phone_required'); phone.focus(); return; }
    busy(go, true);
    const { data, error } = await sb.rpc('request_withdrawal', { p_amount: a, p_method: m, p_phone: ph });
    busy(go, false);
    if (error) { err.textContent = errMsg(error); return; }
    toast(tpl(T('earn_withdraw_done'), { date: day(data.due_at) })); reload();
  });
  card.append(form);
  return card;
}

function wdRow(w, reload) {
  const st = w.status === 'pending' ? (w.overdue ? T('earn_wd_overdue') : tpl(T('earn_wd_pending'), { date: day(w.due_at) }))
    : w.status === 'paid' ? tpl(T('earn_wd_paid'), { date: fmtDate(w.decided_at) })
      : w.status === 'rejected' ? T('earn_wd_rejected') : T('earn_wd_cancelled');
  const cls = { pending: 'warn', paid: 'ok', rejected: 'bad', cancelled: '' }[w.status];
  const cancel = w.status === 'pending' ? h('button', { class: 'linklike small', type: 'button', text: T('earn_wd_cancel') }) : null;
  cancel?.addEventListener('click', async () => {
    if (!(await confirmDialog(T('earn_wd_cancel'), T('earn_wd_cancel'), true))) return;
    const { error } = await sb.rpc('cancel_withdrawal', { p_id: w.id });
    if (error) { toast(errMsg(error), 'bad'); return; }
    reload();
  });
  return h('div', { class: 'item wd-item' },
    h('div', { class: 'grow' },
      h('b', { text: `${egp(w.amount)} ${cur()} ${L('→', '←')} ${w.method === 'instapay' ? T('earn_withdraw_instapay') : T('earn_withdraw_wallet')} ${w.phone}` }),
      h('div', { class: 'small muted', text: `${fmtDate(w.created_at)} · ${st}${w.transfer_ref ? ` · ${L('ref', 'مرجع')} ${w.transfer_ref}` : ''}` }),
      w.note && w.status !== 'paid' ? h('div', { class: 'small', text: w.note }) : null, cancel),
    h('span', { class: `badge ${cls}`, text: lang() === 'ar' ? { pending: 'قيد التنفيذ', paid: 'اتبعت', rejected: 'مرفوض', cancelled: 'ملغي' }[w.status] : w.status }));
}

function inviteCode(sm, reload) {
  if (sm.referred_by) return h('p', { class: 'small muted center', text: tpl(T('earn_invited_by'), { name: sm.referred_by }) });
  if (!sm.can_set_referrer || !sm.enabled) return null;
  const code = h('input', { class: 'input code-input', maxlength: 12, autocomplete: 'off', placeholder: 'ABC123' });
  const go = h('button', { class: 'btn sm', type: 'submit', text: L('Add', 'إضافة') });
  const form = h('form', { class: 'card stack' }, h('b', { text: T('earn_invited_q') }), h('small', { class: 'muted', text: T('earn_invited_text') }),
    h('div', { class: 'row' }, code, go));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    busy(go, true);
    const { data, error } = await sb.rpc('set_referrer', { p_code: code.value });
    busy(go, false);
    if (error) { toast(errMsg(error), 'bad'); return; }
    toast(tpl(T('earn_invited_by'), { name: data.name })); reload();
  });
  return form;
}

async function member(ctx) {
  const { data: sm, error } = await sb.rpc('my_referral_summary');
  clear(langScope(app));
  if (error || !sm) { app.append(h('p', { class: 'form-error', text: errMsg(error || 'forbidden') })); return; }
  const reload = () => member(ctx);
  app.append(hero(sm, reload));
  if (!sm.enabled) app.append(h('p', { class: 'pay-note', text: T('earn_paused') }));
  else app.append(codeCard(sm));
  app.append(stats(sm));
  const use = walletUse(sm, reload);
  if (use) app.append(use);
  app.append(withdrawCard(sm, ctx, reload));
  if (sm.withdrawals.length) {
    app.append(h('h2', { text: T('earn_withdrawals') }), h('div', { class: 'list' }, sm.withdrawals.map((w) => wdRow(w, reload))));
  }
  app.append(h('h2', { text: T('earn_friends') }));
  if (!sm.friends.length) app.append(h('p', { class: 'small muted', text: T('earn_no_friends') }));
  else {
    app.append(h('div', { class: 'list' }, sm.friends.map((f) => h('div', { class: 'item' },
      h('span', { class: 'thumb', text: f.name.slice(0, 1) }),
      h('div', { class: 'grow' }, h('b', { text: f.name }), h('div', { class: 'small muted', text: fmtDate(f.joined_at) })),
      Number(f.earned) > 0 ? h('span', { class: 'badge ok', text: tpl(T('earn_friend_paid'), { amount: egp(f.earned) }) })
        : h('span', { class: 'small muted', text: T('earn_friend_waiting') })))));
  }
  app.append(steps(sm), tips());
  if (sm.entries.length) {
    app.append(h('h2', { text: T('earn_activity') }), h('div', { class: 'list' }, sm.entries.map((e) => h('div', { class: 'item' },
      h('div', { class: 'grow' }, h('div', { text: e.note || e.kind }), h('div', { class: 'small muted', text: fmtDate(e.at) })),
      h('b', { class: Number(e.amount) > 0 ? 'plus' : 'minus', text: `${Number(e.amount) > 0 ? '+' : ''}${egp(e.amount)}` })))));
  }
  const inv = inviteCode(sm, reload);
  if (inv) app.append(inv);
}

async function main() {
  const ctx = await shell('earn');
  if (ctx.role === 'customer') { await member(ctx); return; }
  const { data: o } = await sb.rpc('referral_offer');
  const offer = o || { commission: 100, commission_pct: 50, enabled: moduleOn('referrals') };
  const guest = () => {
    clear(langScope(app)).append(hero(offer, guest), steps(offer),
    offer.enabled ? h('a', { class: 'btn block', href: 'signup.html?next=earn.html', text: T('earn_guest_cta') }) : h('p', { class: 'pay-note', text: T('earn_paused') }),
    tips(), ctx.role === 'guest' || ctx.role === 'none' ? h('p', { class: 'center' }, L('Already a member? ', 'عندك حساب؟ '), h('a', { href: 'login.html?next=earn.html', text: L(T('login_button'), 'سجّل دخول') })) : null);
  };
  guest();
}

main().catch((e) => { if (e?.message !== 'redirect') { console.error(e); app.textContent = errMsg(e); } });
