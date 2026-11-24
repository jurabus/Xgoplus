import { sb, shell, S, h, $, clear, errMsg, busy, fmtDate, fmtDateTime, toast, getContext, moduleOn, logoSVG, uploadProof, icon, sessionRevoked, platform } from '../common.js';
import { qrcode } from '../vendor/qrgen.js';

const app = $('#app');
let refreshTimer = null, tickTimer = null;

export function drawQR(canvas, text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), margin = 4, scale = 8, size = (n + margin * 2) * scale;
  canvas.width = size; canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);
  g.fillStyle = '#16132b';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
}

let PAY = { mode: 'free', price: 199, methods: [] };
function priceBlock() {
  const price = Number(PAY.price) || 0;
  const free = PAY.mode === 'free';
  return h('div', {},
    free ? h('span', { class: 'freebadge', text: S('membership_free_badge') }) : null,
    h('div', { class: 'price' }, free ? h('s', { text: `${price} EGP` }) : null, free ? '0 EGP' : `${price} EGP`),
    h('div', { class: 'period', text: S('membership_period') }));
}
function benefits() {
  return h('ul', {}, String(S('membership_benefits')).split('\n').filter(Boolean).map((b) => h('li', { text: b })));
}

async function startQR(box, bar, note) {
  const canvas = h('canvas', { width: 10, height: 10, 'aria-label': 'Membership QR code', role: 'img' });
  clear(box).append(canvas);
  let ttl = 180, left = 0;
  async function refresh() {
    const { data, error } = await sb.rpc('get_member_qr');
    if (error) {
      if (/session_revoked/.test(error.message || '')) { sessionRevoked(); return; }
      note.textContent = errMsg(error); return;
    }
    drawQR(canvas, `${location.origin}/v.html#${data.token}`);   // phone camera apps open this link
    ttl = Math.min(data.ttl_seconds || 180, 180);
    left = 60; // refresh well before expiry
    note.textContent = S('qr_hint');
  }
  await refresh();
  clearInterval(refreshTimer); clearInterval(tickTimer);
  refreshTimer = setInterval(() => { if (!document.hidden) refresh(); }, 60 * 1000);
  tickTimer = setInterval(() => { left = Math.max(0, left - 1); bar.style.width = `${(left / 60) * 100}%`; }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  try { await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
}

const tpl = (t, v) => String(t).replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
const METHOD_LABEL = () => ({ instapay: S('pay_instapay'), vodafone: S('pay_vodafone') });

// Paid flow: choose method -> see where to send -> upload screenshot -> request goes to admin.
async function payFlow(slot, ctx, lastReq) {
  clear(slot);
  if (lastReq?.status === 'rejected') {
    slot.append(h('div', { class: 'pay-note bad' }, h('b', { text: S('pay_rejected') }), lastReq.admin_note ? h('div', { text: lastReq.admin_note }) : null));
  }
  const methods = (PAY.methods || []).filter((m) => m === 'instapay' || m === 'vodafone');
  if (!methods.length) { slot.append(h('p', { class: 'small center', text: S('pay_unavailable') })); return; }
  slot.append(h('div', { class: 'small pay-step', text: S('pay_choose') }),
    h('div', { class: 'pay-methods' }, methods.map((m) => h('button', { class: `pay-method ${m}`, type: 'button', onclick: () => pick(m) },
      h('span', { class: 'pm-logo', text: m === 'instapay' ? 'InstaPay' : 'VF Cash' }), h('span', { text: METHOD_LABEL()[m] })))));

  async function pick(method) {
    clear(slot).append(h('div', { class: 'spinner' }));
    const { data, error } = await sb.rpc('start_membership_payment', { p_method: method });
    if (error) { clear(slot).append(h('p', { class: 'small center', text: errMsg(error) })); return; }
    const copyBtn = h('button', { class: 'btn sm light', type: 'button', text: S('pay_copy') });
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(data.account_value); copyBtn.textContent = S('pay_copied'); }
      catch { const r = document.createRange(); r.selectNodeContents(val); getSelection().removeAllRanges(); getSelection().addRange(r); }
    });
    const val = h('div', { class: 'pay-value', text: data.account_value });
    // InstaPay quick pay: the official payment link opens the InstaPay app on the transfer screen
    let quick = null;
    if (method === 'instapay' && /^https:\/\/ipn\.eg\/S\/[A-Za-z0-9._-]+\/instapay\/[A-Za-z0-9]+$/.test(data.pay_link || '')) {
      const fail = h('div', { class: 'quickpay-fail small', hidden: true, text: S('pay_quick_fail') });
      const a = h('a', { class: 'btn block quickpay', href: data.pay_link, target: '_blank', rel: 'noopener', 'data-platform': platform() }, icon('arrow'), S('pay_quick'));
      a.addEventListener('click', () => {
        let left = false;
        const onHide = () => { if (document.hidden) left = true; };
        document.addEventListener('visibilitychange', onHide);
        setTimeout(() => {                       // still here and nothing opened -> manual fallback
          document.removeEventListener('visibilitychange', onHide);
          if (!left) fail.hidden = false;
        }, 2500);
        setTimeout(() => { fail.hidden = false; }, 8000);   // always show the manual way afterwards
      });
      quick = h('div', { class: 'stack' }, a, fail);
    }
    const auto = data.auto === true;
    const isInsta = method === 'instapay';
    const file = h('input', { type: 'file', accept: 'image/*' });
    const prev = h('div', { class: 'pay-preview' });
    const ocrNote = h('div', { class: 'small ocr-note', role: 'status' });
    const ref = h('input', { class: 'input mono', inputmode: 'numeric', maxlength: 14, autocomplete: 'off', placeholder: S('pay_ref_placeholder') });
    const phone = h('input', { class: 'input', type: 'tel', inputmode: 'tel', maxlength: 16, autocomplete: 'tel', placeholder: '01XXXXXXXXX' });
    const sender = h('input', { class: 'input', maxlength: 120, autocomplete: 'off' });
    const err = h('div', { class: 'form-error', role: 'alert' });
    const send = h('button', { class: 'btn block light', type: 'submit', text: S('pay_submit') });
    let ocrRef = null, ocrBusy = false;
    const guide = auto && isInsta ? h('div', { class: 'pay-guide' },
      h('div', { class: 'small pay-step', text: S('pay_guide_title') }),
      h('div', { class: 'pay-guide-imgs' },
        h('a', { href: '/img/instapay-step1.webp', target: '_blank', rel: 'noopener' }, h('img', { src: '/img/instapay-step1.webp', alt: S('pay_guide_1'), width: 585, height: 1266 }), h('span', { text: S('pay_guide_1') })),
        h('a', { href: '/img/instapay-step2.webp', target: '_blank', rel: 'noopener' }, h('img', { src: '/img/instapay-step2.webp', alt: S('pay_guide_2'), width: 585, height: 1266 }), h('span', { text: S('pay_guide_2') })))) : null;
    file.addEventListener('change', async () => {
      clear(prev); err.textContent = ''; ocrNote.textContent = ''; ocrNote.className = 'small ocr-note'; ocrRef = null;
      const f = file.files[0];
      if (!f) return;
      prev.append(h('img', { src: URL.createObjectURL(f), alt: '' }));
      if (!(auto && isInsta)) return;
      ocrBusy = true; busy(send, true, S('pay_ocr_checking')); ocrNote.textContent = S('pay_ocr_checking');
      const { readReference } = await import('../ocr.js');
      const r = await readReference(f);
      ocrBusy = false; busy(send, false);
      if (r.ok) {
        ocrRef = r.reference; ref.value = r.reference;
        ocrNote.textContent = tpl(S('pay_ocr_found'), { ref: r.reference }); ocrNote.classList.add('ok');
      } else if (r.reason === 'no_reference') {
        file.value = ''; clear(prev);
        ocrNote.textContent = S('pay_ocr_missing'); ocrNote.classList.add('bad');
        guide?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        ocrNote.textContent = S('pay_ocr_unavailable');   // old phone / offline: type it
      }
    });
    const fields = [];
    if (isInsta) {
      fields.push(h('label', { class: 'field' }, h('span', { text: S(auto ? 'pay_upload_label_ref' : 'pay_upload_label') }), h('div', { class: 'pay-file' }, icon('share'), file), ocrNote, prev));
      if (auto) fields.push(h('label', { class: 'field' }, h('span', { text: S('pay_ref_label') }), ref, h('small', { class: 'muted-on-dark', text: S('pay_ref_hint') })));
    } else {
      if (auto) fields.push(h('label', { class: 'field' }, h('span', { text: S('pay_phone_label') }), phone, h('small', { class: 'muted-on-dark', text: S('pay_phone_hint') })));
      fields.push(h('label', { class: 'field' }, h('span', { text: S(auto ? 'pay_upload_optional' : 'pay_upload_label') }), h('div', { class: 'pay-file' }, icon('share'), file), prev));
    }
    if (!auto) fields.push(h('label', { class: 'field' }, h('span', { text: S('pay_sender_label') }), sender));
    const form = h('form', { class: 'pay-form stack', novalidate: true },
      h('div', { class: 'pay-box' },
        h('div', { class: 'small', text: tpl(S('pay_send'), { amount: Number(data.amount) }) }),
        h('div', { class: 'row' }, val, copyBtn),
        h('div', { class: 'small muted-on-dark', text: S(isInsta ? 'pay_hint_instapay' : 'pay_hint_vodafone') })),
      quick, guide, ...fields,
      auto ? h('p', { class: 'small muted-on-dark', text: S('pay_auto_note') }) : null,
      err, send,
      h('button', { class: 'linklike', type: 'button', text: S('pay_change'), onclick: () => payFlow(slot, ctx, null) }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      if (ocrBusy) return;
      const digits = (v) => v.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '');
      const refV = digits(ref.value);
      let phoneV = digits(phone.value);
      if (/^(20|0020)1\d{9}$/.test(phoneV)) phoneV = `0${phoneV.replace(/^(0020|20)/, '')}`;
      if ((isInsta || !auto) && !file.files[0]) { err.textContent = errMsg('proof_required'); return; }
      if (auto && isInsta && !/^\d{12}$/.test(refV)) { err.textContent = S('pay_ref_invalid'); ref.focus(); return; }
      if (auto && !isInsta && !/^01\d{9}$/.test(phoneV)) { err.textContent = S('pay_phone_invalid'); phone.focus(); return; }
      busy(send, true, '…');
      try {
        const path = file.files[0] ? await uploadProof(ctx.profile.id, data.request_id, file.files[0]) : null;
        let { data: res, error: e2 } = await sb.rpc('submit_payment', {
          p_request: data.request_id, p_proof_path: path, p_ref: isInsta ? refV || null : null,
          p_payer_phone: !isInsta && auto ? phoneV : null, p_ocr_ref: isInsta ? ocrRef : null, p_sender: sender.value.trim(),
        });
        if (e2 && /submit_payment|schema cache|PGRST202/i.test(`${e2.message} ${e2.code}`)) {   // update 014 not applied yet
          ({ data: res, error: e2 } = await sb.rpc('submit_membership_request', { p_request: data.request_id, p_proof_path: path, p_sender: sender.value.trim() }));
        }
        if (e2) throw e2;
        if (res?.status === 'approved') { toast(S('pay_auto_done')); await getContext(true); }
        location.reload();
      } catch (ex) { busy(send, false); err.textContent = errMsg(ex); }
    });
    clear(slot).append(form);
  }
}

// While the bank SMS hasn't arrived yet, check every few seconds and open the membership the moment it's confirmed
function watchRequest(id) {
  let n = 0;
  const t = setInterval(async () => {
    if (document.hidden) return;
    if (++n > 150) { clearInterval(t); return; }                   // ~20 minutes
    const { data } = await sb.rpc('my_membership_request');
    if (!data || data.id !== id) { clearInterval(t); return; }
    if (data.status === 'approved') { clearInterval(t); toast(S('pay_auto_done')); await getContext(true); location.reload(); }
    else if (data.status !== 'pending' || data.auto_state !== 'awaiting_bank') { clearInterval(t); location.reload(); }
  }, 8000);
}

function pendingBox(req) {
  const cancel = h('button', { class: 'btn sm light', type: 'button', text: S('pay_cancel') });
  cancel.addEventListener('click', async () => {
    busy(cancel, true);
    const { error } = await sb.rpc('cancel_membership_request');
    if (error) { busy(cancel, false); toast(errMsg(error), 'bad'); return; }
    location.reload();
  });
  const waiting = req.auto && req.auto_state === 'awaiting_bank';
  if (waiting) watchRequest(req.id);
  return h('div', { class: 'pay-box stack' },
    h('div', { class: 'row' }, waiting ? h('span', { class: 'spinner sm' }) : icon('clock'),
      h('b', { class: 'grow', text: S(waiting ? 'pay_waiting_title' : 'pay_pending_title') })),
    h('div', { class: 'small', text: S(waiting ? 'pay_waiting_text' : 'pay_pending_text') }),
    req.pay_ref ? h('div', { class: 'small mono' }, `${S('pay_ref_label')}: ${req.pay_ref}`) : null,
    req.payer_phone ? h('div', { class: 'small mono' }, `${S('pay_phone_label')}: ${req.payer_phone}`) : null,
    h('div', { class: 'small' }, `${METHOD_LABEL()[req.method] || req.method} · ${Number(req.amount_egp)} EGP · ${fmtDateTime(req.submitted_at)}`),
    cancel);
}

async function main() {
  const ctx = await shell('membership');
  clear(app);
  app.append(h('h1', { text: S('membership_title') }));
  if (!moduleOn('membership')) { app.append(h('div', { class: 'card', text: 'Memberships are not available right now.' })); return; }
  const { data: opts } = await sb.rpc('payment_options');
  if (opts) PAY = opts; else PAY = { mode: S('membership_free') !== false ? 'free' : 'inactive', price: S('membership_price_egp'), methods: [] };

  if (ctx.role === 'guest' || ctx.role === 'none') {
    app.append(h('div', { class: 'mcard' }, h('div', { class: 'mlogo' }, logoSVG()), priceBlock(), benefits(),
      PAY.mode === 'inactive' ? h('p', { class: 'small center', text: S('pay_unavailable') }) : null,
      h('a', { class: 'btn block light', href: 'signup.html?next=membership.html', text: S('membership_cta') }),
      h('p', { class: 'small center', text: S('membership_login_needed') }),
      h('p', { class: 'center' }, h('a', { class: 'btn sm ghost', href: 'login.html?next=membership.html', text: S('login_button') }))));
    return;
  }
  if (ctx.role !== 'customer') {
    app.append(h('div', { class: 'card', text: 'Memberships are for customer accounts.' }));
    return;
  }

  const m = ctx.membership || { status: 'none' };
  const p = ctx.profile;
  const renewDays = Number(S('membership_renew_window_days')) || 30;
  const canRenew = m.status !== 'active' || (new Date(m.expires_at) - Date.now()) < renewDays * 86400000;

  // What the "get / renew membership" area shows depends on the payment mode
  const actionSlot = h('div', { class: 'stack' });
  if (canRenew) {
    if (PAY.mode === 'free') {
      const subBtn = h('button', { class: 'btn block light', type: 'button', text: m.status === 'none' ? S('membership_cta') : S('membership_renew_cta') });
      subBtn.addEventListener('click', async () => {
        busy(subBtn, true);
        const { error } = await sb.rpc('subscribe_membership');
        if (error) { busy(subBtn, false); toast(errMsg(error), 'bad'); return; }
        toast('✓');
        await getContext(true);
        location.reload();
      });
      actionSlot.append(subBtn);
    } else if (PAY.mode === 'inactive') {
      actionSlot.append(h('p', { class: 'small center', text: S('pay_unavailable') }));
    } else {
      const { data: req } = await sb.rpc('my_membership_request');
      if (req?.status === 'pending') actionSlot.append(pendingBox(req));
      else await payFlow(actionSlot, ctx, req);
    }
  }

  const trial = ctx.trial || 'disabled';
  if (m.status === 'none' && trial !== 'active') {
    let trialBox = null;
    if (trial === 'available') {
      const go = h('button', { class: 'btn block', type: 'button', text: S('trial_cta') });
      go.addEventListener('click', async () => {
        busy(go, true);
        const { error } = await sb.rpc('start_trial');
        if (error) { busy(go, false); toast(errMsg(error), 'bad'); return; }
        await getContext(true); location.reload();
      });
      trialBox = h('div', { class: 'card stack trial-card' }, h('span', { class: 'trial-badge', text: S('trial_badge') }),
        h('h2', { text: S('trial_title') }), h('p', { class: 'muted', text: S('trial_text') }), go);
    }
    if (trialBox) app.append(trialBox);
    app.append(h('div', { class: 'mcard' }, h('div', { class: 'mlogo' }, logoSVG()), priceBlock(), benefits(),
      trial === 'used' ? h('p', { class: 'pay-note bad small', text: S('trial_used') }) : null, actionSlot));
    return;
  }
  const isTrial = m.status === 'none' && trial === 'active';
  const active = m.status === 'active' || isTrial;
  const box = h('div', { class: 'qrbox' }, h('div', { class: 'spinner' }));
  const bar = h('i');
  const note = h('p', { class: 'small center', text: S('qr_hint') });
  app.append(h('div', { class: 'mcard' }, h('div', { class: 'mlogo' }, logoSVG()),
    h('div', { class: 'mstatus' },
      h('div', {}, h('div', { class: 'who', text: `${p.first_name} ${p.last_name}` }), h('div', { class: 'small', text: S('membership_title') })),
      isTrial ? h('span', { class: 'trial-badge', text: S('trial_badge') })
        : h('span', { class: `badge ${active ? 'ok' : 'bad'}`, text: active ? S('membership_active_label') : S('membership_expired_label') })),
    box, h('div', { class: 'qrbar' }, bar), note,
    isTrial ? h('p', { class: 'center small', text: S('trial_text') }) : h('p', { class: 'center' }, `${S('membership_valid_until')}: `, h('b', { text: fmtDate(m.expires_at) })),
    canRenew ? [PAY.mode === 'active' ? h('div', { class: 'small pay-step', text: S('pay_title') }) : null, actionSlot] : null));
  startQR(box, bar, note);
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
