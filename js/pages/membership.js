import { sb, shell, S, h, $, clear, errMsg, busy, fmtDate, toast, getContext, moduleOn } from '../common.js';
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

function priceBlock() {
  const price = Number(S('membership_price_egp')) || 0;
  const free = S('membership_free') !== false;
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
    drawQR(canvas, data.token);
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

async function main() {
  const ctx = await shell('membership');
  clear(app);
  app.append(h('h1', { text: S('membership_title') }));
  if (!moduleOn('membership')) { app.append(h('div', { class: 'card', text: 'Memberships are not available right now.' })); return; }

  if (ctx.role === 'guest' || ctx.role === 'none') {
    app.append(h('div', { class: 'mcard' }, priceBlock(), benefits(),
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
  const subBtn = h('button', { class: 'btn block light', type: 'button', text: m.status === 'none' ? S('membership_cta') : S('membership_renew_cta') });
  subBtn.addEventListener('click', async () => {
    busy(subBtn, true);
    const { error } = await sb.rpc('subscribe_membership');
    if (error) { busy(subBtn, false); toast(errMsg(error), 'bad'); return; }
    toast('✓');
    await getContext(true);
    location.reload();
  });

  if (m.status === 'none') {
    app.append(h('div', { class: 'mcard' }, priceBlock(), benefits(), subBtn));
    return;
  }
  const active = m.status === 'active';
  const box = h('div', { class: 'qrbox' }, h('div', { class: 'spinner' }));
  const bar = h('i');
  const note = h('p', { class: 'small center', text: S('qr_hint') });
  app.append(h('div', { class: 'mcard' },
    h('div', { class: 'mstatus' },
      h('div', {}, h('div', { class: 'who', text: `${p.first_name} ${p.last_name}` }), h('div', { class: 'small', text: S('membership_title') })),
      h('span', { class: `badge ${active ? 'ok' : 'bad'}`, text: active ? S('membership_active_label') : S('membership_expired_label') })),
    box, h('div', { class: 'qrbar' }, bar), note,
    h('p', { class: 'center' }, `${S('membership_valid_until')}: `, h('b', { text: fmtDate(m.expires_at) })),
    canRenew ? subBtn : null));
  startQR(box, bar, note);
}
main().catch((e) => { if (e?.message !== 'redirect') console.error(e); });
