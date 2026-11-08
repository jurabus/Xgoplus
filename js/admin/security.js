// Security: banned IPs (unban / manual ban), recent suspicious events, admin sign-ins.
import { sb, h, clear, errMsg, busy, toast, confirmDialog, fmtDateTime } from '../common.js';
import { field, input } from './ui.js';

const KIND = {
  admin_bad_password: 'Wrong admin password', admin_bad_2fa: 'Wrong 2FA code', non_admin_login: 'Non-admin account tried admin',
  admin_rpc_denied: 'Admin function called without permission', admin_probe: 'Admin probe', admin_session: 'Admin signed in',
};
let root;

async function draw() {
  clear(root).append(h('h1', { text: 'Security' }), h('div', { class: 'spinner' }));
  const { data, error } = await sb.rpc('admin_security_overview');
  root.lastChild.remove();
  if (error || !data) { root.append(h('p', { class: 'form-error', text: errMsg(error || 'forbidden') })); return; }
  root.append(h('div', { class: 'card stack small' },
    h('div', {}, 'Admin access needs your password + a code from your authenticator app. Repeated wrong passwords, wrong codes, other accounts trying to open admin, or calls to admin functions without permission ban that IP from admin for 24 hours (30 days for repeat offenders).'),
    h('div', {}, 'Your current IP: ', h('b', { text: data.my_ip }))));

  const ip = input({ placeholder: 'IP address', maxlength: 64, inputmode: 'decimal' });
  const days = input({ type: 'number', min: 1, max: 3650, value: 30 });
  const ban = h('button', { class: 'btn danger', type: 'button', text: 'Ban IP' });
  ban.addEventListener('click', async () => {
    busy(ban, true);
    const { error: e } = await sb.rpc('admin_ban_ip', { p_ip: ip.value.trim(), p_days: Math.trunc(Number(days.value) || 1), p_reason: 'manual' });
    busy(ban, false);
    if (e) { toast(errMsg(e), 'bad'); return; }
    toast('Banned'); draw();
  });
  const bans = h('div', { class: 'list' });
  if (!data.bans.length) bans.append(h('div', { class: 'empty', text: 'No banned IPs.' }));
  data.bans.forEach((b) => {
    const un = h('button', { class: 'btn sm light', type: 'button', text: 'Unban' });
    un.addEventListener('click', async () => {
      if (!(await confirmDialog(`Unban ${b.ip}?`, 'Unban'))) return;
      const { error: e } = await sb.rpc('admin_unban_ip', { p_ip: b.ip });
      if (e) { toast(errMsg(e), 'bad'); return; }
      toast('Unbanned'); draw();
    });
    bans.append(h('div', { class: 'item' }, h('div', { class: 'grow' }, h('b', { text: b.ip }),
      h('div', { class: 'small muted', text: `${KIND[b.reason] || b.reason} · until ${fmtDateTime(b.expires_at)}` })), un));
  });
  const ev = h('div', { class: 'list' });
  if (!data.events.length) ev.append(h('div', { class: 'empty', text: 'Nothing suspicious yet.' }));
  data.events.forEach((e) => ev.append(h('div', { class: 'item' },
    h('div', { class: 'grow' }, h('div', {}, h('b', { text: KIND[e.kind] || e.kind })),
      h('div', { class: 'small muted', text: `${e.ip} · ${fmtDateTime(e.created_at)}${e.email ? ` · ${e.email}` : ''}${e.detail && e.detail !== 'ok' ? ` · ${e.detail}` : ''}` })),
    e.weight > 0 ? h('span', { class: 'badge warn', text: `+${e.weight}` }) : h('span', { class: 'badge ok', text: 'ok' }))));
  root.append(h('h2', { text: 'Banned IPs' }), bans,
    h('div', { class: 'card stack' }, h('b', { text: 'Ban an IP manually' }), h('div', { class: 'row' }, h('div', { class: 'grow' }, field('IP', ip)), field('Days', days)), ban),
    h('h2', { text: 'Recent activity (last 100)' }), ev);
}
export async function render(r) { root = r; await draw(); }
