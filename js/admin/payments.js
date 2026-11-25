// Payments: mode (free / active / inactive), price, rotation, InstaPay addresses + Vodafone Cash
// numbers, and membership requests with the transfer screenshot (private storage, signed link).
import { sb, h, clear, errMsg, busy, toast, confirmDialog, fmtDateTime, localPhone, bustSettingsCache } from '../common.js';
import { sheet, field, input, checkbox, textarea, pagedList } from './ui.js';

const LABEL = { instapay: 'InstaPay', vodafone: 'Mobile wallet', wallet: 'XGo+ wallet' };
const APK_URL = 'https://github.com/jurabus/xgoplus/releases/download/sms-listener/xgo-sms-listener.apk';
let root, status = 'pending', reqList, smsStatus = 'unmatched', smsList;
const ago = (t) => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - new Date(t)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : fmtDateTime(t);
};

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
      radio('active', 'Paid — requests open', 'Customers pay by InstaPay / mobile wallet. With automatic payments on, matching transfers activate instantly; the rest wait for you.'),
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
  const autoC = checkbox(a.auto_confirm === true);
  const err = h('div', { class: 'form-error' });
  const save = h('button', { class: 'btn block', type: 'submit', text: 'Save' });
  const del = isNew ? null : h('button', { class: 'btn block danger', type: 'button', text: 'Delete' });
  const form = h('form', { class: 'stack' },
    field(a.method === 'vodafone' ? 'Vodafone Cash number' : 'InstaPay address', value),
    a.method === 'instapay' ? field('InstaPay payment link (for the “Pay in InstaPay app” button)', link,
      'In the InstaPay app: open this account → Share / “IPA link” → copy. It looks like https://ipn.eg/S/name/instapay/AbC123') : null,
    field('Note (only you see it)', label),
    field('Order in rotation (lower first)', sort), h('label', { class: 'switch' }, h('span', { text: 'In rotation' }), active),
    h('label', { class: 'switch' }, h('span', {}, h('b', { text: 'Automatic confirmation' }), h('br'),
      h('small', { class: 'muted', text: 'This account’s “money received” SMS arrive on the paired listener phone. While automatic payments are on, customers are sent only to these accounts.' })), autoC),
    err, save, del);
  const s = sheet(`${isNew ? 'Add' : 'Edit'} ${LABEL[a.method]}`, form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    const row = { value: value.value.trim(), label: label.value.trim(), sort_order: Math.trunc(Number(sort.value) || 0), is_active: active.checked, auto_confirm: autoC.checked };
    if (a.method === 'instapay') {
      const l = link.value.trim();
      if (l && !/^https:\/\/ipn\.eg\/S\/[A-Za-z0-9._-]+\/instapay\/[A-Za-z0-9]+$/.test(l)) { err.textContent = errMsg('payment_accounts_pay_link_check'); return; }
      row.pay_link = l || null;
    }
    busy(save, true);
    let { error } = isNew ? await sb.from('payment_accounts').insert({ ...row, method: a.method }) : await sb.from('payment_accounts').update(row).eq('id', a.id);
    if (error && /auto_confirm/.test(error.message || '')) {   // update 014 not applied yet
      delete row.auto_confirm;
      ({ error } = isNew ? await sb.from('payment_accounts').insert({ ...row, method: a.method }) : await sb.from('payment_accounts').update(row).eq('id', a.id));
    }
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

async function accountsCard(ov, autoOn = false) {
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
      r.auto_confirm && autoOn ? h('span', { class: 'badge ok', text: 'Auto' }) : null,
      h('span', { class: `badge ${r.is_active ? 'ok' : 'bad'}`, text: r.is_active ? 'On' : 'Off' }))));
    card.append(h('div', { class: 'row' }, h('span', { class: `pm-tag ${m}`, text: LABEL[m] }), h('div', { class: 'grow' }),
      h('button', { class: 'btn sm', type: 'button', text: '+ Add', onclick: () => accountSheet(null, m, (rows.at(-1)?.sort_order || 0) + 10) })), list);
  }
  return card;
}

async function requestSheet(r) {
  const img = h('div', {}, h('div', { class: 'spinner' }));
  const candidate = h('div');
  const note = textarea(r.admin_note || '', { rows: 2, maxlength: 500, placeholder: 'Message to the customer (shown if rejected)' });
  const approve = h('button', { class: 'btn grow', type: 'button', text: 'Approve & activate' });
  const reject = h('button', { class: 'btn danger grow', type: 'button', text: 'Reject' });
  const s = sheet('Membership request', h('div', { class: 'stack' },
    h('div', { class: 'card stack' },
      h('div', { class: 'row' }, h('b', { class: 'grow', text: r.member_name }), h('span', { class: `pm-tag ${r.method}`, text: LABEL[r.method] })),
      h('div', { class: 'small' }, 'Phone: ', h('a', { href: `tel:+${r.member_phone}`, text: localPhone(r.member_phone) }), ` · membership now: ${r.member_status}`),
      h('div', { class: 'small' }, `Amount: ${Number(r.amount_egp)} EGP · sent to: `, h('b', { text: r.account_value })),
      r.sender_info ? h('div', { class: 'small', text: `Sender: ${r.sender_info}` }) : null,
      r.pay_ref ? h('div', { class: 'small' }, 'Reference typed: ', h('b', { class: 'mono', text: r.pay_ref }),
        r.ocr_ref && r.ocr_ref !== r.pay_ref ? h('span', { class: 'badge bad', text: ` screenshot says ${r.ocr_ref}` }) : r.ocr_ref ? ' (matches screenshot ✓)' : ' (not read from screenshot)') : null,
      r.payer_phone ? h('div', { class: 'small' }, 'Paid from wallet: ', h('b', { class: 'mono', text: r.payer_phone })) : null,
      r.auto ? h('div', { class: 'small' }, 'Automatic: ', h('span', { class: `badge ${r.auto_state === 'matched' ? 'ok' : r.auto_state === 'manual_review' ? 'bad' : 'warn'}`,
        text: { awaiting_bank: 'waiting for bank SMS', manual_review: 'no match after 24 h — please check', matched: `matched bank SMS #${r.matched_sms}` }[r.auto_state] || r.auto_state || '—' })) : null,
      h('div', { class: 'small muted', text: `Submitted ${fmtDateTime(r.submitted_at)}${r.decided_at ? ` · decided ${fmtDateTime(r.decided_at)}` : ''}` })),
    img, candidate,
    r.status === 'pending' ? [field('Note', note), h('div', { class: 'row' }, reject, approve)]
      : h('div', { class: 'card small', text: `Status: ${r.status}${r.admin_note ? ` — ${r.admin_note}` : ''}` })));
  if (r.proof_path) {
    const { data, error } = await sb.storage.from('proofs').createSignedUrl(r.proof_path, 300);
    clear(img).append(error ? h('p', { class: 'form-error', text: errMsg(error) })
      : h('a', { href: data.signedUrl, target: '_blank', rel: 'noopener' }, h('img', { class: 'proof-img', src: data.signedUrl, alt: 'Transfer screenshot' })));
  } else clear(img);
  if (r.status === 'pending' && r.candidate_sms) {
    const { data: rows } = await sb.rpc('admin_list_bank_sms', { p_status: 'unmatched', p_limit: 200, p_offset: 0 });
    const sms = (rows || []).find((x) => x.id === r.candidate_sms);
    if (sms) {
      const use = h('button', { class: 'btn block', type: 'button', text: `Approve with this bank SMS (#${sms.id})` });
      use.addEventListener('click', async () => {
        busy(use, true);
        const { error } = await sb.rpc('admin_match_sms', { p_request: r.id, p_sms: sms.id });
        busy(use, false);
        if (error) { toast(errMsg(error), 'bad'); return; }
        s.close(); toast('Approved — membership is active'); reqList.load(); smsList?.load();
      });
      candidate.append(h('div', { class: 'card stack' }, h('b', { text: 'Matching bank SMS found' }),
        h('div', { class: 'small muted', text: `${sms.sender} · ${fmtDateTime(sms.sms_at || sms.received_at)}${sms.trusted ? '' : ' · sender not trusted'}` }),
        h('div', { class: 'small sms-body', text: sms.body }), use));
    }
  }
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
  const { data: setRow } = await sb.from('settings').select('data').eq('id', 1).single();
  const autoOn = setRow?.data?.autopay_enabled === true;
  root.append(h('h2', { text: 'Requests' }), seg, reqBox, h('h2', { text: 'Automatic payments' }), await autopayCard(),
    h('h2', { text: 'Settings' }), el, await accountsCard(ov, autoOn));
  if (autoOn) drawSmsLog(); else smsList = null;
  reqList = pagedList(reqBox, async (offset, limit) => {
    const { data, error } = await sb.rpc('admin_list_requests', { p_status: status, p_limit: limit, p_offset: offset });
    if (error) { toast(errMsg(error), 'bad'); return { rows: [], total: 0 }; }
    return { rows: data || [], total: data?.[0]?.total ?? (offset ? null : 0) };
  }, (r) => h('button', { class: 'item btn-reset', type: 'button', onclick: () => requestSheet(r) },
    h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, h('b', { text: r.member_name }), ` · ${Number(r.amount_egp)} EGP`),
      h('div', { class: 'small muted', text: `${LABEL[r.method]} → ${r.account_value} · ${fmtDateTime(r.submitted_at)}` })),
    r.status === 'pending' && r.auto_state === 'manual_review' ? h('span', { class: 'badge bad', text: 'check' }) : null,
    r.status === 'approved' && r.auto_state === 'matched' ? h('span', { class: 'badge brand', text: 'auto' }) : null,
    h('span', { class: `badge ${r.status === 'pending' ? 'warn' : r.status === 'approved' ? 'ok' : 'bad'}`, text: r.status === 'pending' && r.auto_state === 'awaiting_bank' ? 'waiting bank' : r.status })));
  reqList.load();
}

// ---------------------------------------------------------------- automatic payments
function pairSheet() {
  const name = input({ maxlength: 60, placeholder: 'e.g. Shop Samsung A15' });
  const go = h('button', { class: 'btn block', type: 'submit', text: 'Create pairing code' });
  const out = h('div', { class: 'stack' });
  const form = h('form', { class: 'stack' },
    h('ol', { class: 'small steps' },
      h('li', {}, 'On the Android phone with the InstaPay / wallet SIM, download and install ', h('a', { href: APK_URL, text: 'XGo+ SMS Listener (APK)' }), '. If Android warns about unknown apps, allow installing from your browser.'),
      h('li', { text: 'Open the app and allow SMS access (if blocked: App info › ⋮ › Allow restricted settings).' }),
      h('li', { text: 'Create a code below and type it in the app within 15 minutes.' }),
      h('li', { text: 'In the app tap “Don’t restrict battery”. Keep the phone charged and online.' })),
    field('Phone name (only you see it)', name), go, out);
  sheet('Pair a phone', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    busy(go, true);
    const { data, error } = await sb.rpc('admin_sms_pair_code', { p_name: name.value.trim() });
    busy(go, false);
    if (error || !data) { toast(errMsg(error || 'forbidden'), 'bad'); return; }
    clear(out).append(h('div', { class: 'card center stack' }, h('small', { class: 'muted', text: 'Type this code in the app' }),
      h('div', { class: 'pair-code', text: data.code }), h('small', { class: 'muted', text: `Valid until ${fmtDateTime(data.expires_at)} · works once` })));
  });
}

async function autopayCard() {
  const [{ data: ov, error }, { data: row }] = await Promise.all([sb.rpc('admin_autopay_overview'), sb.from('settings').select('data').eq('id', 1).single()]);
  const card = h('div', { class: 'card stack' });
  if (error || !ov) { card.append(h('p', { class: 'form-error', text: `Not available — run update 014. ${error ? errMsg(error) : ''}` })); return card; }
  const d = row?.data || {};
  const on = checkbox(ov.enabled);
  const senders = input({ value: Array.isArray(d.autopay_senders) ? d.autopay_senders.join(', ') : '', placeholder: 'empty = any bank/wallet name or short code' });
  const save = h('button', { class: 'btn block', type: 'button', text: 'Save' });
  const recheck = h('button', { class: 'btn block ghost', type: 'button', text: 'Re-check open payments now' });
  const online = ov.devices.filter((x) => x.paired && x.last_seen_at && Date.now() - new Date(x.last_seen_at) < 40 * 60000).length;
  save.addEventListener('click', async () => {
    const list = senders.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 30);
    const data = { ...d, autopay_enabled: on.checked, autopay_senders: list };
    busy(save, true);
    const { error: e1 } = await sb.from('settings').update({ data, updated_at: new Date().toISOString() }).eq('id', 1);
    if (!e1 && on.checked) await sb.rpc('admin_autopay_reconcile');
    busy(save, false);
    if (e1) { toast(errMsg(e1), 'bad'); return; }
    bustSettingsCache(); toast(on.checked ? 'Automatic payments are on' : 'Automatic payments are off'); draw();
  });
  recheck.addEventListener('click', async () => {
    busy(recheck, true);
    const { data: n, error: e2 } = await sb.rpc('admin_autopay_reconcile');
    busy(recheck, false);
    if (e2) { toast(errMsg(e2), 'bad'); return; }
    toast(n ? `${n} payment(s) approved` : 'No new matches'); reqList.load(); smsList?.load();
  });
  const devList = h('div', { class: 'list' });
  if (!ov.devices.length) devList.append(h('div', { class: 'empty', text: 'No phone paired yet.' }));
  for (const x of ov.devices) {
    const fresh = x.last_seen_at && Date.now() - new Date(x.last_seen_at) < 40 * 60000;
    const rev = h('button', { class: 'btn sm danger', type: 'button', text: x.paired ? 'Disconnect' : 'Cancel code' });
    rev.addEventListener('click', async () => {
      if (!(await confirmDialog('Disconnect this phone? It will stop sending SMS until paired again.', 'Disconnect', true))) return;
      const { error: e3 } = await sb.rpc('admin_sms_revoke', { p_device: x.id });
      if (e3) { toast(errMsg(e3), 'bad'); return; }
      draw();
    });
    devList.append(h('div', { class: 'item' },
      h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, h('b', { text: x.name || 'Phone' })),
        h('div', { class: 'small muted', text: x.paired ? `Last check-in ${ago(x.last_seen_at)} · ${x.sms_count} SMS${x.last_info ? ` · ${x.last_info}` : ''}` : `Waiting for code until ${fmtDateTime(x.pair_expires_at)}` })),
      h('span', { class: `badge ${x.paired ? (fresh ? 'ok' : 'bad') : 'warn'}`, text: x.paired ? (fresh ? 'Online' : 'Offline') : 'Pairing' }), rev));
  }
  if (!ov.enabled) {
    const turnOn = h('button', { class: 'btn block', type: 'button', text: 'Switch automatic payments on' });
    turnOn.addEventListener('click', async () => {
      if (!online && !(await confirmDialog('No listener phone is online yet. Payments will wait for its SMS (or go to your manual check after 24 h). Switch on anyway?', 'Switch on'))) return;
      busy(turnOn, true);
      const { error: e1 } = await sb.from('settings').update({ data: { ...d, autopay_enabled: true }, updated_at: new Date().toISOString() }).eq('id', 1);
      if (!e1) await sb.rpc('admin_autopay_reconcile');
      busy(turnOn, false);
      if (e1) { toast(errMsg(e1), 'bad'); return; }
      bustSettingsCache(); toast('Automatic payments are on'); draw();
    });
    card.append(
      h('div', { class: 'row' }, h('b', { class: 'grow', text: 'Off — manual approval' }), h('span', { class: 'badge', text: 'off' })),
      h('p', { class: 'small muted', text: 'Members send the money, upload the transfer screenshot and wait up to 24 h while you approve it here. No reference/phone fields, guides or “instant” texts are shown to them.' }),
      h('ol', { class: 'small steps' },
        h('li', {}, 'Install the ', h('a', { href: APK_URL, text: 'Android listener app (APK)' }), ' on the phone that receives the InstaPay / wallet SMS.'),
        h('li', { text: 'Pair it below and check it shows “Online”.' }),
        h('li', { text: 'Switch automatic payments on (here or in Admin → Modules).' })),
      h('div', { class: 'row' }, h('b', { class: 'grow', text: 'Listener phones' }), h('button', { class: 'btn sm', type: 'button', text: '+ Pair a phone', onclick: pairSheet })),
      devList, turnOn);
    return card;
  }
  card.append(
    h('label', { class: 'switch' }, h('span', {}, h('b', { text: 'Confirm payments automatically' }), h('br'),
      h('small', { class: 'muted', text: 'Matches each request with the bank / wallet SMS received on the listener phone and activates the membership at once. Off = you approve every request by hand, as before.' })), on),
    ov.enabled && !ov.active ? h('p', { class: 'small form-error', text: 'Membership sign-up must be “Paid — requests open” for this to work.' }) : null,
    ov.enabled && !online ? h('p', { class: 'small form-error', text: 'No listener phone is online — payments wait (nothing is lost) until it checks in.' }) : null,
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', { text: String(ov.waiting) }), h('span', { text: 'Waiting for bank' })),
      h('div', { class: 'stat' }, h('b', { text: String(ov.review) }), h('span', { text: 'Need your check (24 h+)' })),
      h('div', { class: 'stat' }, h('b', { text: String(ov.auto_approved_7d) }), h('span', { text: 'Auto-approved (7 days)' })),
      h('div', { class: 'stat' }, h('b', { text: String(ov.unmatched) }), h('span', { text: 'Unmatched bank SMS' }))),
    h('div', { class: 'row' }, h('b', { class: 'grow', text: 'Listener phones' }), h('button', { class: 'btn sm', type: 'button', text: '+ Pair a phone', onclick: pairSheet })),
    devList,
    field('Trusted SMS senders (optional)', senders, `Leave empty to accept any sender with a name (NBE, VF-Cash…) or a short code — never a person’s number. Seen so far: ${ov.senders.join(', ') || '—'}`),
    save, recheck,
    h('a', { class: 'small', href: APK_URL, text: '⬇ Download the Android listener app (APK)' }));
  return card;
}

function smsSheet(x) {
  const toggle = x.status === 'matched' ? null
    : h('button', { class: 'btn block light', type: 'button', text: x.status === 'ignored' ? 'Un-ignore (try to match again)' : 'Ignore this SMS' });
  toggle?.addEventListener('click', async () => {
    busy(toggle, true);
    const { error } = await sb.rpc('admin_set_sms_status', { p_sms: x.id, p_status: x.status === 'ignored' ? 'unmatched' : 'ignored' });
    busy(toggle, false);
    if (error) { toast(errMsg(error), 'bad'); return; }
    s.close(); smsList.load(); reqList.load();
  });
  const s = sheet(`Bank SMS #${x.id}`, h('div', { class: 'stack' },
    h('div', { class: 'card stack' },
      h('div', { class: 'small muted', text: `${x.sender} · ${fmtDateTime(x.sms_at || x.received_at)} · via ${x.device_name || 'phone'}${x.trusted ? '' : ' · sender NOT trusted'}` }),
      h('div', { class: 'sms-body', text: x.body })),
    h('div', { class: 'card small stack' },
      h('div', { text: `Type: ${x.kind === 'instapay' ? 'InstaPay' : x.kind === 'wallet' ? 'Mobile wallet' : 'Not a payment'}` }),
      x.amount != null ? h('div', { text: `Amount: ${Number(x.amount)} EGP` }) : null,
      x.reference ? h('div', {}, 'Reference: ', h('b', { class: 'mono', text: x.reference })) : null,
      x.from_phone ? h('div', {}, 'From wallet: ', h('b', { class: 'mono', text: x.from_phone })) : null,
      x.from_name ? h('div', { text: `Sender name: ${x.from_name}` }) : null,
      h('div', { text: x.status === 'matched' ? `Used for: ${x.member_name || 'a membership'}` : `Status: ${x.status}` })),
    h('p', { class: 'small muted', text: 'To use an unmatched SMS for a request, open the request: when the reference / wallet number fits, an “Approve with this bank SMS” button appears.' }),
    toggle));
}

function drawSmsLog() {
  const seg = h('div', { class: 'seg' });
  const box = h('div');
  const drawSeg = () => clear(seg).append(...[['unmatched', 'Unmatched'], ['matched', 'Matched'], ['ignored', 'Ignored'], ['', 'All']].map(([v, l]) =>
    h('a', { href: '#payments', class: v === smsStatus ? 'active' : '', text: l, onclick: (e) => { e.preventDefault(); smsStatus = v; drawSeg(); smsList.reset(); } })));
  drawSeg();
  root.append(h('h2', { text: 'Bank SMS received' }), seg, box);
  smsList = pagedList(box, async (offset, limit) => {
    const { data, error } = await sb.rpc('admin_list_bank_sms', { p_status: smsStatus, p_limit: limit, p_offset: offset });
    if (error) return { rows: [], total: 0 };
    return { rows: data || [], total: data?.[0]?.total ?? (offset ? null : 0) };
  }, (x) => h('button', { class: 'item btn-reset', type: 'button', onclick: () => smsSheet(x) },
    h('div', { class: 'grow' },
      h('div', { class: 'ellipsis' }, h('b', { text: x.amount != null ? `${Number(x.amount)} EGP` : x.sender }),
        ` · ${x.kind === 'instapay' ? `ref ${x.reference}` : x.kind === 'wallet' ? `from ${x.from_phone}` : 'not a payment'}`),
      h('div', { class: 'small muted ellipsis', text: `${x.sender} · ${fmtDateTime(x.sms_at || x.received_at)}${x.member_name ? ` · ${x.member_name}` : ''}` })),
    !x.trusted && x.kind !== 'other' ? h('span', { class: 'badge bad', text: 'untrusted' }) : null,
    h('span', { class: `badge ${x.status === 'matched' ? 'ok' : x.status === 'ignored' ? '' : 'warn'}`, text: x.status })));
  smsList.load();
}

export async function render(r) { root = r; await draw(); }
