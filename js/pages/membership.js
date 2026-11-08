import { sb, shell, S, h, $, clear, errMsg, busy, fmtDate, fmtDateTime, toast, getContext, moduleOn, logoSVG, uploadProof, icon } from '../common.js';
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
    if (error) { note.textContent = errMsg(error); return; }
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
    const file = h('input', { type: 'file', accept: 'image/*', required: true });
    const prev = h('div', { class: 'pay-preview' });
    file.addEventListener('change', () => {
      clear(prev);
      if (file.files[0]) prev.append(h('img', { src: URL.createObjectURL(file.files[0]), alt: '' }));
    });
    const sender = h('input', { class: 'input', maxlength: 120, autocomplete: 'off' });
    const err = h('div', { class: 'form-error', role: 'alert' });
    const send = h('button', { class: 'btn block light', type: 'submit', text: S('pay_submit') });
    const form = h('form', { class: 'pay-form stack', novalidate: true },
      h('div', { class: 'pay-box' },
        h('div', { class: 'small', text: tpl(S('pay_send'), { amount: Number(data.amount) }) }),
        h('div', { class: 'row' }, val, copyBtn),
        h('div', { class: 'small muted-on-dark', text: S(method === 'instapay' ? 'pay_hint_instapay' : 'pay_hint_vodafone') })),
      h('label', { class: 'field' }, h('span', { text: S('pay_upload_label') }), h('div', { class: 'pay-file' }, icon('share'), file), prev),
      h('label', { class: 'field' }, h('span', { text: S('pay_sender_label') }), sender),
      err, send,
      h('button', { class: 'linklike', type: 'button', text: S('pay_change'), onclick: () => payFlow(slot, ctx, null) }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      if (!file.files[0]) { err.textContent = errMsg('proof_required'); return; }
      busy(send, true, '…');
      try {
        const path = await uploadProof(ctx.profile.id, data.request_id, file.files[0]);
        const { error: e2 } = await sb.rpc('submit_membership_request', { p_request: data.request_id, p_proof_path: path, p_sender: sender.value.trim() });
        if (e2) throw e2;
        location.reload();
      } catch (ex) { busy(send, false); err.textContent = errMsg(ex); }
    });
    clear(slot).append(form);
  }
}

function pendingBox(req) {
  const cancel = h('button', { class: 'btn sm light', type: 'button', text: S('pay_cancel') });
  cancel.addEventListener('click', async () => {
    busy(cancel, true);
    const { error } = await sb.rpc('cancel_membership_request');
    if (error) { busy(cancel, false); toast(errMsg(error), 'bad'); return; }
    location.reload();
  });
  return h('div', { class: 'pay-box stack' },
    h('div', { class: 'row' }, icon('clock'), h('b', { class: 'grow', text: S('pay_pending_title') })),
    h('div', { class: 'small', text: S('pay_pending_text') }),
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

  if (m.status === 'none') {
    app.append(h('div', { class: 'mcard' }, h('div', { class: 'mlogo' }, logoSVG()), priceBlock(), benefits(), actionSlot));
    return;
  }
  const active = m.status === 'active';
  const box = h('div', { class: 'qrbox' }, h('div', { class: 'spinner' }));
  const bar = h('i');
  const note = h('p', { class: 'small center', text: S('qr_hint') });
  app.append(h('div', { class: 'mcard' }, h('div', { class: 'mlogo' }, logoSVG()),
    h('div', { class: 'mstatus' },
      h('div', {}, h('div', { class: 'who', text: `${p.first_name} ${p.last_name}` }), h('div', { class: 'small', text: S('membership_title') })),
      h('span', { class: `badge ${active ? 'ok' : 'bad'}`, text: active ? S('membership_active_label') : S('membership_expired_label') })),
    box, h('div', { class: 'qrbar' }, bar), note,
    h('p', { class: 'center' }, `${S('membership_valid_until')}: `, h('b', { text: fmtDate(m.expires_at) })),
    canRenew ? [PAY.mode === 'active' ? h('div', { class: 'small pay-step', text: S('pay_title') }) : null, actionSlot] : null));
  startQR(box, bar, note);
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
