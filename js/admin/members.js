import { sb, h, clear, errMsg, busy, toast, confirmDialog, fmtDate, fmtDateTime, localPhone, pct } from '../common.js';
import { sheet, field, input, textarea, pagedList } from './ui.js';

let list, q = '';
const BADGE = { active: ['ok', 'Active'], expired: ['bad', 'Expired'], none: ['brand', 'No membership'] };

function interestsBox(uid) {
  const box = h('div', { class: 'card stack' }, h('b', { text: 'Interests (from scans)' }), h('div', { class: 'small muted', text: 'Loading…' }));
  sb.rpc('admin_member_interests', { p_user: uid }).then(({ data, error }) => {
    box.lastChild.remove();
    if (error) { box.append(h('div', { class: 'small muted', text: 'Not available — run update 013.' })); return; }
    if (!data?.length) { box.append(h('div', { class: 'small muted', text: 'No scans yet.' })); return; }
    box.append(h('div', { class: 'small muted', text: `${data[0].total} lifetime scans` }));
    for (const r of data) {
      const i = h('i'); i.style.width = `${Math.min(100, Number(r.pct))}%`;
      box.append(h('div', { class: 'int-row' }, h('div', { class: 'row' }, h('span', { class: 'grow', text: r.name }), h('b', { text: `${pct(r.pct)}% · ${r.scans}` })), h('div', { class: 'bar' }, i)));
    }
  });
  return box;
}

function memberSheet(m) {
  const days = input({ type: 'number', min: 1, max: 3660, value: 365 });
  const grant = h('button', { class: 'btn', type: 'button', text: 'Add days' });
  const revoke = h('button', { class: 'btn block danger', type: 'button', text: 'End membership now' });
  const [cls, label] = BADGE[m.status];
  const s = sheet(`${m.first_name} ${m.last_name}`,
    h('div', { class: 'card stack' },
      h('div', {}, 'Phone: ', h('a', { href: `tel:+${m.phone}`, text: localPhone(m.phone) })),
      h('div', {}, 'Joined: ', fmtDate(m.created_at)),
      h('div', {}, 'Membership: ', h('span', { class: `badge ${cls}`, text: label }), m.expires_at ? ` until ${fmtDate(m.expires_at)}` : '')),
    interestsBox(m.id),
    h('h2', { text: 'Extend / grant membership' }),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Days to add', days)), grant),
    m.status === 'active' ? h('div', { class: 'stack' }, h('div'), revoke) : null,
    dangerZone(m, () => { s.close(); list.reset(); }));
  grant.addEventListener('click', async () => {
    busy(grant, true);
    const { error } = await sb.rpc('admin_grant_membership', { p_user_id: m.id, p_days: Math.trunc(Number(days.value)) });
    busy(grant, false);
    if (error) { toast(errMsg(error), 'bad'); return; }
    s.close(); toast('Membership updated'); list.load();
  });
  revoke.addEventListener('click', async () => {
    if (!(await confirmDialog('End this membership now? The member QR will show "expired".', 'End now', true))) return;
    const { error } = await sb.rpc('admin_revoke_membership', { p_user_id: m.id });
    if (error) { toast(errMsg(error), 'bad'); return; }
    s.close(); toast('Membership ended'); list.load();
  });
}

// ---------- delete / permanent ban ----------
async function removeProofs(uid) {
  // best effort: transfer screenshots live in storage under <uid>/
  try {
    const { data } = await sb.storage.from('proofs').list(uid, { limit: 1000 });
    if (data?.length) await sb.storage.from('proofs').remove(data.map((f) => `${uid}/${f.name}`));
  } catch { /* the account is still deleted */ }
}

function dangerZone(m, done) {
  const reason = textarea('', { maxlength: 300, rows: 2, placeholder: 'Reason (kept with the ban, e.g. fraud, abuse, fake payments)' });
  const del = h('button', { class: 'btn block ghost danger', type: 'button', text: 'Delete account' });
  const ban = h('button', { class: 'btn block danger', type: 'button', text: 'Delete & ban this phone number' });
  const run = async (isBan, btn) => {
    const { data: info, error: e1 } = await sb.rpc('admin_member_delete_info', { p_user: m.id });
    if (e1 || !info) { toast(errMsg(e1 || 'not_found'), 'bad'); return; }
    if (info.protected) { toast(errMsg('cannot_delete_staff'), 'bad'); return; }
    if (isBan && reason.value.trim().length < 3) { toast('Write the reason for the ban.', 'bad'); reason.focus(); return; }
    const warn = [
      info.active_until ? `active membership until ${fmtDate(info.active_until)}` : '',
      Number(info.wallet) > 0 ? `${Number(info.wallet)} EGP wallet balance` : '',
      info.pending_withdrawals ? `${info.pending_withdrawals} pending cash-out request` : '',
      info.payments ? `${info.payments} payment request(s)` : '',
    ].filter(Boolean);
    const msg = `Delete ${m.first_name} ${m.last_name} (${localPhone(m.phone)})?`
      + (warn.length ? `\n\nThis also deletes: ${warn.join(', ')}.` : '')
      + (isBan ? '\n\nThe number will be banned: it can never register again unless you lift the ban.' : '\n\nThe number can register again later.')
      + '\n\nThis can’t be undone.';
    if (!(await confirmDialog(msg, isBan ? 'Delete & ban' : 'Delete', true))) return;
    busy(btn, true);
    await removeProofs(m.id);
    const { error } = await sb.rpc('admin_delete_member', { p_user: m.id, p_ban: isBan, p_reason: reason.value.trim() });
    busy(btn, false);
    if (error) { toast(errMsg(error), 'bad'); return; }
    toast(isBan ? 'Account deleted and number banned' : 'Account deleted');
    done();
  };
  del.addEventListener('click', () => run(false, del));
  ban.addEventListener('click', () => run(true, ban));
  return h('div', { class: 'card stack danger-zone' }, h('b', { text: 'Delete or ban' }),
    h('small', { class: 'muted', text: 'Delete removes the account and its data; the number can sign up again. Ban also blocks the phone number from ever registering again.' }),
    field('Ban reason', reason), del, ban);
}

function bannedSheet() {
  const phone = input({ type: 'tel', inputmode: 'tel', maxlength: 16, placeholder: '01XXXXXXXXX' });
  const reason = input({ maxlength: 300, placeholder: 'Reason' });
  const add = h('button', { class: 'btn', type: 'button', text: 'Ban number' });
  const q = input({ type: 'search', placeholder: 'Search banned numbers', maxlength: 40 });
  const box = h('div');
  let bl;
  const s = sheet('Banned phone numbers',
    h('div', { class: 'card stack' }, h('small', { class: 'muted', text: 'Ban a number before it registers. If a member already uses it, that account is deleted too.' }),
      field('Phone number', phone), field('Reason', reason), add),
    q, box);
  const load = () => {
    clear(box);
    bl = pagedList(box, async (offset, limit) => {
      const { data, error } = await sb.rpc('admin_list_banned', { p_search: q.value.trim(), p_limit: limit, p_offset: offset });
      if (error) { toast(errMsg(error), 'bad'); return { rows: [], total: 0 }; }
      return { rows: data || [], total: data?.[0]?.total ?? 0 };
    }, (b) => {
      const un = h('button', { class: 'btn sm ghost', type: 'button', text: 'Lift ban' });
      un.addEventListener('click', async () => {
        if (!(await confirmDialog(`Lift the ban on ${localPhone(b.phone)}? The number will be able to register again.`, 'Lift ban'))) return;
        const { error } = await sb.rpc('admin_unban_phone', { p_phone: b.phone });
        if (error) { toast(errMsg(error), 'bad'); return; }
        toast('Ban lifted'); load();
      });
      return h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('b', { text: localPhone(b.phone) }),
          h('div', { class: 'small muted', text: [b.name, b.reason, fmtDateTime(b.banned_at)].filter(Boolean).join(' · ') })), un);
    });
    bl.load();
  };
  let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 300); });
  add.addEventListener('click', async () => {
    if (!phone.value.trim()) { phone.focus(); return; }
    if (!(await confirmDialog(`Ban ${phone.value.trim()}? If an account uses this number it will be deleted.`, 'Ban', true))) return;
    busy(add, true);
    const { data, error } = await sb.rpc('admin_ban_phone', { p_phone: phone.value, p_reason: reason.value.trim() });
    busy(add, false);
    if (error) { toast(errMsg(error), 'bad'); return; }
    toast(data.deleted ? 'Number banned and its account deleted' : 'Number banned');
    phone.value = ''; reason.value = ''; load(); if (data.deleted) list.reset();
  });
  load();
  return s;
}

export async function render(root) {
  const search = input({ type: 'search', placeholder: 'Search phone or name', maxlength: 40 });
  let t; search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { q = search.value.trim(); list.reset(); }, 300); });
  root.append(h('div', { class: 'row' }, h('h1', { class: 'grow', text: 'Members' }),
    h('button', { class: 'btn sm ghost', type: 'button', text: '🚫 Banned numbers', onclick: bannedSheet })),
    h('div', { class: 'searchbar' }, search));
  list = pagedList(root, async (offset, limit) => {
    const { data, error } = await sb.rpc('admin_list_members', { p_search: q, p_limit: limit, p_offset: offset });
    if (error) { toast(errMsg(error), 'bad'); return { rows: [], total: 0 }; }
    return { rows: data, total: data[0]?.total ?? (offset ? null : 0) };
  }, (m) => {
    const [cls, label] = BADGE[m.status];
    return h('button', { class: 'item btn-reset', type: 'button', onclick: () => memberSheet(m) },
      h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, h('b', { text: `${m.first_name} ${m.last_name}` })),
        h('div', { class: 'small muted', text: `${localPhone(m.phone)}${m.expires_at ? ` · until ${fmtDate(m.expires_at)}` : ''}` })),
      h('span', { class: `badge ${cls}`, text: label }));
  });
  list.load();
}
