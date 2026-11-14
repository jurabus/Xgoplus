"""Role-by-role database tests for XGo Plus.

Runs every migration against a fresh local Postgres that has Supabase-like
stubs (auth.users, auth.uid(), storage), then checks what guest / customer /
provider / admin can and cannot do, abuse cases, and performance at ~20k rows.

usage: python3 -I tests/db/test_rls.py   (needs Postgres on /tmp:5433)
"""
import json
import os
import subprocess
import sys
import time
import uuid

import psycopg

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DSN_ADMIN = "host=/tmp port=5433 user=postgres dbname=postgres"
DB = "xg_test"
DSN = f"host=/tmp port=5433 user=postgres dbname={DB}"

passed = 0
failed = []


def check(name, cond, detail=""):
    global passed
    if cond:
        passed += 1
    else:
        failed.append(f"{name} {detail}")
        print("FAIL:", name, detail)


def setup_db():
    with psycopg.connect(DSN_ADMIN, autocommit=True) as c:
        c.execute(f"drop database if exists {DB}")
        c.execute(f"create database {DB}")
    files = ["tests/db/supabase_stub.sql", "supabase/schema.sql"] + sorted(
        "supabase/migrations/" + f for f in os.listdir(os.path.join(ROOT, "supabase/migrations")) if f.endswith(".sql"))
    for _ in range(2):  # twice: proves idempotency
        for f in files[1:] if _ else files:
            r = subprocess.run(["psql", "-h", "/tmp", "-p", "5433", "-U", "postgres", "-d", DB, "-q",
                                "-v", "ON_ERROR_STOP=1", "-f", os.path.join(ROOT, f)],
                               capture_output=True, text=True)
            if r.returncode != 0:
                print(r.stderr)
                sys.exit(f"migration failed: {f}")


conn = None


AAL2 = set()          # users whose session passed 2FA
SESS = {}             # who -> current session id (JWT session_id claim)
IP_OVERRIDE = {}      # who -> ip


def ip_for(who):
    if who in IP_OVERRIDE:
        return IP_OVERRIDE[who]
    if who in AAL2:
        return "10.0.0.1"
    h = abs(hash(str(who))) % 250 + 2
    return f"10.9.{h}.{h}"


def run(who, sql, params=None, fetch=True):
    """Execute as a given identity. who = None (superuser), 'anon', or a user uuid.
    Returns (rows, error_message)."""
    try:
        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute("select set_config('request.headers', %s, true)", (json.dumps({"x-forwarded-for": f"{ip_for(who)}, 172.16.0.1"}),))
                if who == "anon":
                    cur.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"role": "anon"}),))
                    cur.execute("set local role anon")
                elif who is not None:
                    cur.execute("select set_config('request.jwt.claims', %s, true)",
                                (json.dumps({"sub": str(who), "role": "authenticated", "session_id": SESS.setdefault(who, str(uuid.uuid4())), **({"aal": "aal2"} if who in AAL2 else {"aal": "aal1"})}),))
                    cur.execute("set local role authenticated")
                cur.execute(sql, params)
                rows = cur.fetchall() if (fetch and cur.description) else []
                return rows, None
    except psycopg.Error as e:
        return None, (e.diag.message_primary or str(e))


def ok(who, sql, params=None):
    rows, err = run(who, sql, params)
    if err:
        raise AssertionError(f"unexpected error for {who}: {err}\n  {sql}")
    return rows


def denied(name, who, sql, params=None, contains=None):
    rows, err = run(who, sql, params)
    good = err is not None and (contains is None or contains in err)
    # admin RPCs don't raise for outsiders (so the attempt can be logged): they return nothing
    if err is None and contains is None and "admin_" in sql and rows in ([], [(None,)], [("",)]):
        good = True
    check(name, good, f"expected error{' ~'+contains if contains else ''}, got rows={rows} err={err}")


def signup(phone, first, last, email=None, meta_phone=None):
    """What Supabase Auth does on signUp (runs as the auth admin)."""
    uid = uuid.uuid4()
    email = email or f"u{phone}@xgoplus.online"
    meta = {"phone": meta_phone if meta_phone is not None else phone, "first_name": first, "last_name": last}
    _, err = run(None, """insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data) values (%s,'authenticated','authenticated',%s,
        extensions.crypt('secret123', extensions.gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}', %s)""", (uid, email, json.dumps(meta)))
    return (uid, err)


def main():
    global conn
    setup_db()
    conn = psycopg.connect(DSN, autocommit=True)

    # ------------------------------------------------------------ actors
    admin = uuid.uuid4()
    ok(None, "insert into auth.users (id, email, aud, role) values (%s, 'owner@gmail.com', 'authenticated', 'authenticated')", (admin,))
    ok(None, "insert into public.admins (user_id) values (%s)", (admin,))
    AAL2.add(admin)
    IP_OVERRIDE[admin] = "10.0.0.1"
    c1, e = signup("201001112222", "Ahmed", "Mostafa"); assert not e, e
    c2, e = signup("201203334444", "Mona", "Samir"); assert not e, e
    stranger = uuid.uuid4()  # authenticated but no role (e.g. random API sign-up)
    ok(None, "insert into auth.users (id, email) values (%s, 'random@evil.test')", (stranger,))

    p1 = ok(admin, "select public.admin_create_provider('cafe_one', 'Passw0rd!', 'Cafe One', 15, 'Fridays only')")[0][0]
    p2 = ok(admin, "select public.admin_create_provider('gym2', 'Passw0rd!', 'Gym Two', 25.5, '')")[0][0]
    p1u = ok(None, "select user_id from public.providers where id=%s", (p1,))[0][0]
    p2u = ok(None, "select user_id from public.providers where id=%s", (p2,))[0][0]

    # provider auth rows look like real GoTrue rows (login would work)
    r = ok(None, """select u.email, u.encrypted_password = extensions.crypt('Passw0rd!', u.encrypted_password),
                    u.confirmation_token, u.email_confirmed_at is not null, i.provider, i.email
                    from auth.users u join auth.identities i on i.user_id=u.id where u.id=%s""", (p1u,))[0]
    check("provider auth row", r == ("cafe_one@p.xgoplus.online", True, "", True, "email", "cafe_one@p.xgoplus.online"), str(r))
    check("provider has no customer profile", ok(None, "select count(*) from public.profiles where id=%s", (p1u,))[0][0] == 0)

    # ------------------------------------------------------------ sign-up abuse
    _, e = signup("201005556666", "X", "Y", meta_phone="201009999999")
    check("signup phone/email mismatch rejected", e is not None and "invalid_signup" in e, str(e))
    _, e = signup("201005556666", "", "Y")
    check("signup empty name rejected", e is not None, str(e))
    _, e = signup("201005556666", "A" * 41, "Y")
    check("signup long name rejected", e is not None, str(e))
    _, e = signup("201005556666", "A", "B", email="evil@p.xgoplus.online")
    check("signup provider-domain email rejected", e is not None, str(e))
    _, e = signup("201005556666", "A", "B", email="admin@xgoplus.online")
    check("signup other domain email rejected", e is not None, str(e))
    _, e = signup("201001112222", "Dup", "Dup", email="u201001112222@xgoplus.online")
    check("duplicate phone rejected", e is not None, str(e))
    c3, e = signup("201117778888", "<script>Ali", "Ha\x07ssan>")
    check("html/control chars stripped from names",
          ok(None, "select first_name, last_name from public.profiles where id=%s", (c3,))[0] == ("scriptAli", "Hassan"))

    _, e = run(None, "update auth.users set email='gym2@p.xgoplus.online' where id=%s", (c3,))
    check("email change to provider address blocked", e is not None and "email_change_not_allowed" in e, str(e))
    _, e = run(None, "update auth.users set email='me@gmail.com' where id=%s", (c3,))
    check("email change away from phone address blocked", e is not None, str(e))
    ok(None, "update auth.users set last_sign_in_at=now() where id=%s", (c3,))

    # ------------------------------------------------------------ guest
    G = "anon"
    rows = ok(G, "select id, name, image_path, discount_percent, notes from public.providers order by name")
    check("guest sees active providers", [x[1] for x in rows] == ["Cafe One", "Gym Two"], str(rows))
    denied("guest cannot read provider usernames", G, "select username from public.providers")
    denied("guest cannot read provider user_id", G, "select user_id from public.providers")
    for t in ["profiles", "memberships", "scans", "admins"]:
        denied(f"guest cannot read {t}", G, f"select * from public.{t}")
    denied("guest cannot read private.rate_limits", G, "select * from private.rate_limits")
    denied("guest cannot read private.app_secrets", G, "select * from private.app_secrets")
    check("guest reads settings", ok(G, "select id from public.settings") == [(1,)])
    denied("guest cannot update settings", G, "update public.settings set data='{\"x\":1}'")
    denied("guest cannot insert banner", G, "insert into public.banners (title) values ('x')")
    check("guest context", ok(G, "select public.get_my_context()")[0][0] == {"role": "guest"})
    for fn in ["public.admin_stats()", "public.admin_list_members()", "public.admin_list_providers()",
               "public.subscribe_membership()", "public.get_member_qr()", "public.verify_member_qr('x')",
               "public.admin_create_provider('zz_z','Passw0rd!','Z',10,'')"]:
        denied(f"guest cannot call {fn}", G, f"select {fn}")
    denied("guest cannot upload", G, "insert into storage.objects (bucket_id, name) values ('media', 'banners/x.jpg')")
    denied("guest cannot update provider", G, "update public.providers set name='hacked'")

    # ------------------------------------------------------------ customer
    ctx = ok(c1, "select public.get_my_context()")[0][0]
    check("customer context", ctx["role"] == "customer" and ctx["profile"]["phone"] == "201001112222"
          and ctx["membership"]["status"] == "none" and ctx["provider"] is None, str(ctx))
    rows = ok(c1, "select id from public.profiles")
    check("customer sees only own profile", rows == [(c1,)], str(rows))
    ok(c1, "update public.profiles set first_name='Ahmad' where id=%s", (c1,))
    check("customer updates own name", ok(None, "select first_name from public.profiles where id=%s", (c1,))[0][0] == "Ahmad")
    ok(c1, "update public.profiles set first_name='Pwned' where id=%s", (c2,))
    check("customer cannot update other profile", ok(None, "select first_name from public.profiles where id=%s", (c2,))[0][0] == "Mona")
    denied("customer cannot change phone", c1, "update public.profiles set phone='201000000000' where id=%s", (c1,))
    denied("customer cannot insert profile", c1, "insert into public.profiles (id, phone, first_name, last_name) values (gen_random_uuid(),'201000000001','a','b')")
    denied("customer QR before subscribing", c1, "select public.get_member_qr()", contains="no_membership")
    denied("customer cannot insert membership", c1,
           "insert into public.memberships (user_id, starts_at, expires_at, source) values (%s, now(), now()+interval '10 years', 'free')", (c1,))
    st = ok(c1, "select public.subscribe_membership()")[0][0]
    check("subscribe -> active", st["status"] == "active", str(st))
    days = ok(None, "select extract(day from max(expires_at)-now()) from public.memberships where user_id=%s", (c1,))[0][0]
    check("membership is ~1 year", 363 <= days <= 366, str(days))
    price = ok(None, "select list_price_egp, paid_egp, source from public.memberships where user_id=%s", (c1,))[0]
    check("price recorded server-side (199 list, 0 paid)", price == (199, 0, "free"), str(price))
    denied("double subscribe rejected", c1, "select public.subscribe_membership()", contains="already_active")
    denied("customer cannot extend membership", c1, "update public.memberships set expires_at = now()+interval '9 years'")
    denied("customer cannot delete membership", c1, "delete from public.memberships")
    check("customer sees own membership", len(ok(c1, "select id from public.memberships")) == 1)
    check("other customer sees none", ok(c2, "select id from public.memberships") == [])
    qr = ok(c1, "select public.get_member_qr()")[0][0]
    check("QR token format", qr["token"].startswith("XG1.") and len(qr["token"].split(".")) == 4, str(qr))
    check("QR token has no phone/name", "201001112222" not in qr["token"] and "Ahm" not in qr["token"])
    for fn in ["public.admin_stats()", "public.admin_list_members()", "public.admin_grant_membership('%s', 3650)" % c1,
               "public.admin_update_provider('%s', '{\"discount_percent\": 99}')" % p1, "public.verify_member_qr('x')"]:
        denied(f"customer cannot call {fn.split('(')[0]}", c1, f"select {fn}")
    ok(c1, "update public.providers set name='hacked'")
    check("customer cannot update providers", ok(None, "select count(*) from public.providers where name='hacked'")[0][0] == 0)
    denied("customer cannot upload to provider folder", c1,
           "insert into storage.objects (bucket_id, name) values ('media', %s)", (f"providers/{p1}/x.jpg",))
    denied("customer cannot upload banner", c1, "insert into storage.objects (bucket_id, name) values ('media', 'banners/x.jpg')")
    ok(c1, "update public.settings set data='{\"site_title\":\"pwned\"}'")
    check("customer cannot change settings", ok(None, "select data from public.settings")[0][0] == {})
    denied("customer cannot read scans member ids", c1, "select member_id from public.scans")
    check("customer sees no scans", ok(c1, "select id from public.scans") == [])
    check("stranger has role none", ok(stranger, "select public.get_my_context()->>'role'")[0][0] == "none")
    denied("stranger cannot subscribe", stranger, "select public.subscribe_membership()")

    # ------------------------------------------------------------ provider
    ctx = ok(p1u, "select public.get_my_context()")[0][0]
    check("provider context", ctx["role"] == "provider" and ctx["provider"]["id"] == str(p1)
          and ctx["provider"]["username"] == "cafe_one", str(ctx))
    ok(p1u, "update public.providers set name='Cafe 1', notes='Valid Fri\nonly' where id=%s", (p1,))
    denied("009: provider cannot change own discount", p1u, "update public.providers set discount_percent=20 where id=%s", (p1,))
    ok(admin, "select public.admin_update_provider(%s, '{\"discount_percent\": 20}')", (p1,))
    r = ok(None, "select name, discount_percent, notes from public.providers where id=%s", (p1,))[0]
    check("provider edits own profile", r == ("Cafe 1", 20, "Valid Fri\nonly"), str(r))
    denied("provider discount 0 rejected", p1u, "update public.providers set discount_percent=0 where id=%s", (p1,))
    denied("provider discount 150 rejected", p1u, "update public.providers set discount_percent=150 where id=%s", (p1,))
    denied("provider cannot change is_active", p1u, "update public.providers set is_active=true where id=%s", (p1,))
    denied("provider cannot change username", p1u, "update public.providers set username='x_x' where id=%s", (p1,))
    denied("provider cannot change sort_order", p1u, "update public.providers set sort_order=-99 where id=%s", (p1,))
    ok(p1u, "update public.providers set name='pwned' where id=%s", (p2,))
    check("provider cannot edit other provider", ok(None, "select name from public.providers where id=%s", (p2,))[0][0] == "Gym Two")
    denied("provider image path into other folder", p1u, "update public.providers set image_path=%s where id=%s",
           (f"providers/{p2}/a.jpg", p1), contains="invalid_image_path")
    denied("provider image path traversal", p1u, "update public.providers set image_path=%s where id=%s",
           (f"providers/{p1}/../{p2}/a.jpg", p1))
    ok(p1u, "update public.providers set image_path=%s where id=%s", (f"providers/{p1}/logo.jpg", p1))
    ok(p1u, "insert into storage.objects (bucket_id, name) values ('media', %s)", (f"providers/{p1}/logo.jpg",))
    check("provider uploads to own folder", True)
    denied("provider cannot upload to other folder", p1u, "insert into storage.objects (bucket_id, name) values ('media', %s)", (f"providers/{p2}/logo.jpg",))
    denied("provider cannot upload nested", p1u, "insert into storage.objects (bucket_id, name) values ('media', %s)", (f"providers/{p1}/a/b.jpg",))
    denied("provider cannot upload banner", p1u, "insert into storage.objects (bucket_id, name) values ('media', 'banners/b.jpg')")
    denied("provider cannot upload to other bucket", p1u, "insert into storage.objects (bucket_id, name) values ('private', %s)", (f"providers/{p1}/x.jpg",))
    check("provider sees no customer profiles", ok(p1u, "select id from public.profiles") == [])
    check("provider sees no memberships", ok(p1u, "select id from public.memberships") == [])
    denied("provider cannot subscribe", p1u, "select public.subscribe_membership()")
    denied("provider cannot call admin rpc", p1u, "select public.admin_list_members()")

    res = ok(p1u, "select public.verify_member_qr(%s)", (qr["token"],))[0][0]
    check("scan active member", res["status"] == "active" and float(res["discount_percent"]) == 20
          and res["member_name"] == "Ahmad M." and res["notes"] == "Valid Fri\nonly", str(res))
    check("scan result has no phone", "201001112222" not in json.dumps(res))
    parts = qr["token"].split(".")
    tampered = ".".join([parts[0], parts[1], str(int(parts[2]) + 1), parts[3]])
    check("tampered timestamp -> invalid", ok(p1u, "select public.verify_member_qr(%s)", (tampered,))[0][0] == {"status": "invalid"})
    forged = ".".join([parts[0], c2.hex, parts[2], parts[3]])
    check("forged member id -> invalid", ok(p1u, "select public.verify_member_qr(%s)", (forged,))[0][0] == {"status": "invalid"})
    check("garbage -> invalid", ok(p1u, "select public.verify_member_qr('hello')")[0][0] == {"status": "invalid"})
    check("sql-ish -> invalid", ok(p1u, "select public.verify_member_qr(%s)", ("XG1.'; drop table scans;--",))[0][0] == {"status": "invalid"})
    old_payload = f"XG1.{c1.hex}.{int(time.time()) - 600}"
    old_sig = ok(None, "select private.sign_qr(%s || '|' || private.active_sid(%s))", (old_payload, c1))[0][0]
    check("old (valid sig) token -> stale",
          ok(p1u, "select public.verify_member_qr(%s)", (old_payload + "." + old_sig,))[0][0] == {"status": "stale"})
    # expired member
    ok(admin, "select public.admin_grant_membership(%s, 30)", (c2,))
    qr2 = ok(c2, "select public.get_member_qr()")[0][0]
    ok(admin, "select public.admin_revoke_membership(%s)", (c2,))
    check("revoked shows expired in context", ok(c2, "select public.get_my_context()->'membership'->>'status'")[0][0] == "expired")
    res = ok(p1u, "select public.verify_member_qr(%s)", (qr2["token"],))[0][0]
    check("scan expired member", res["status"] == "expired" and res["discount_percent"] is None, str(res))
    qr2b = ok(c2, "select public.get_member_qr()")[0][0]
    check("expired member can still show QR", qr2b["status"] == "expired")
    # scans visibility
    rows = ok(p1u, "select provider_id from public.scans")
    check("provider sees own scans", len(rows) >= 6 and all(r[0] == p1 for r in rows), str(len(rows)))
    check("provider 2 sees none of provider 1 scans", ok(p2u, "select id from public.scans") == [])
    denied("provider cannot read scan member_id", p1u, "select member_id from public.scans")
    denied("provider cannot insert fake scan", p1u, "insert into public.scans (provider_id, result) values (%s,'active')", (p1,))
    # rate limit (30/min per provider; some already used above)
    hits = [ok(p2u, "select public.verify_member_qr('x')") for _ in range(30)]
    denied("scan rate limit", p2u, "select public.verify_member_qr('x')", contains="rate_limited")

    # ------------------------------------------------------------ admin
    A = admin
    check("admin context", ok(A, "select public.get_my_context()->>'role'")[0][0] == "admin")
    denied("admin dup username", A, "select public.admin_create_provider('gym2','Passw0rd!','X',10,'')", contains="username_taken")
    denied("admin weak password", A, "select public.admin_create_provider('newp','short','X',10,'')", contains="weak_password")
    denied("admin bad username", A, "select public.admin_create_provider('Bad Name!','Passw0rd!','X',10,'')", contains="invalid_username")
    denied("admin bad discount", A, "select public.admin_create_provider('newp2','Passw0rd!','X',-1,'')")
    rows = ok(A, "select username, total from public.admin_list_providers('gym', 10, 0)")
    check("admin lists providers with search", rows == [("gym2", 1)], str(rows))
    ok(A, "select public.admin_update_provider(%s, '{\"is_active\": false, \"sort_order\": 3, \"discount_percent\": 30}')", (p2,))
    check("deactivated provider hidden from guest", [x[0] for x in ok(G, "select name from public.providers")] == ["Cafe 1"])
    check("deactivated provider role none", ok(p2u, "select public.get_my_context()->>'role'")[0][0] == "none")
    denied("deactivated provider cannot scan", p2u, "select public.verify_member_qr(%s)", (qr["token"],))
    ok(p2u, "update public.providers set name='still here' where id=%s", (p2,))
    check("deactivated provider cannot edit", ok(None, "select name from public.providers where id=%s", (p2,))[0][0] == "Gym Two")
    ok(A, "select public.admin_set_provider_password(%s, 'N3wPassword')", (p1,))
    check("admin reset password", ok(None, "select encrypted_password = extensions.crypt('N3wPassword', encrypted_password) from auth.users where id=%s", (p1u,))[0][0])
    rows = ok(A, "select first_name, status from public.admin_list_members('010011', 10, 0)")
    check("admin member search by local phone", rows == [("Ahmad", "active")], str(rows))
    rows = ok(A, "select first_name from public.admin_list_members('mona', 10, 0)")
    check("admin member search by name", rows == [("Mona",)], str(rows))
    check("admin sees all profiles", len(ok(A, "select id from public.profiles")) == 3)
    ok(A, "update public.settings set data='{\"site_title\":\"XGo\", \"membership_price_egp\": 249}'")
    check("admin edits settings", ok(G, "select data->>'site_title' from public.settings")[0][0] == "XGo")
    ok(A, "insert into public.banners (title, image_path, link_url) values ('Hi', 'banners/a.jpg', 'https://x.com')")
    denied("banner javascript: link rejected", A, "insert into public.banners (title, link_url) values ('x', 'javascript:alert(1)')")
    denied("banner protocol-relative link rejected", A, "insert into public.banners (title, link_url) values ('x', '//evil.com')")
    denied("banner image outside banners/ rejected", A, "insert into public.banners (title, image_path) values ('x', 'providers/a.jpg')")
    ok(A, "insert into public.banners (title, is_active) values ('Hidden', false)")
    check("guest sees only active banners", [x[0] for x in ok(G, "select title from public.banners")] == ["Hi"])
    ok(A, "insert into storage.objects (bucket_id, name) values ('media', 'banners/a.jpg')")
    ok(A, "insert into storage.objects (bucket_id, name) values ('media', %s)", (f"providers/{p2}/x.jpg",))
    check("admin uploads anywhere in media", True)
    s = ok(A, "select public.admin_stats()")[0][0]
    check("admin stats", s["providers"] == 2 and s["members"] == 3 and s["members_active"] == 1, str(s))
    rows = ok(A, "select member_phone, provider_name from public.admin_list_scans(%s, 200, 0) where result='active'", (p1,))
    check("admin sees scan log with phone", rows and rows[0] == ("201001112222", "Cafe 1"), str(rows))
    c4, _ = signup("201550001111", "New", "Member")
    st = ok(c4, "select public.subscribe_membership()")[0][0]
    check("new price from settings recorded", ok(None, "select list_price_egp from public.memberships where user_id=%s", (c4,))[0][0] == 249)
    ok(A, "update public.settings set data = data || '{\"membership_free\": false}'")
    c5, _ = signup("201550002222", "Pay", "Later")
    denied("paid mode blocks free subscribe", c5, "select public.subscribe_membership()", contains="payment_required")
    ok(A, "update public.settings set data = data - 'membership_free'")
    ok(A, "select public.admin_delete_provider(%s)", (p2,))
    check("delete provider removes auth user", ok(None, "select count(*) from auth.users where id=%s", (p2u,))[0][0] == 0)
    check("admin table hidden from admin via API too", run(A, "select * from public.admins")[1] is not None)

    # ------------------------------------------------------------ categories + search (005)
    cats = ok(G, "select name from public.categories order by sort_order")
    check("starter categories seeded", [c[0] for c in cats][:3] == ["Cafés", "Restaurants", "Gyms"], str(cats))
    denied("guest cannot add category", G, "insert into public.categories (name) values ('x')")
    denied("customer cannot add category", c1, "insert into public.categories (name) values ('x')")
    denied("provider cannot add category", p1u, "insert into public.categories (name) values ('x')")
    ok(p1u, "update public.categories set name='hacked'")
    check("provider cannot rename category", ok(None, "select count(*) from public.categories where name='hacked'")[0][0] == 0)
    cafe_cat = ok(A, "insert into public.categories (name, icon, sort_order) values ('Coffee <b>Shops</b>', '☕', 0) returning id, name")[0]
    check("category name sanitized", cafe_cat[1] == "Coffee bShops/b", str(cafe_cat))
    denied("category image outside categories/", A, "insert into public.categories (name, image_path) values ('y', 'providers/x.jpg')")
    hidden = ok(A, "insert into public.categories (name, is_active) values ('Hidden cat', false) returning id")[0][0]
    check("guest doesn't see hidden category", "Hidden cat" not in [c[0] for c in ok(G, "select name from public.categories")])
    gyms = ok(None, "select id from public.categories where name='Gyms'")[0][0]
    ok(A, "select public.admin_update_provider(%s, %s)", (p1, json.dumps({"category_id": str(cafe_cat[0])})))
    denied("provider cannot change own category", p1u, "update public.providers set category_id=%s where id=%s", (gyms, p1))
    check("guest sees provider category", ok(G, "select category_id from public.providers where id=%s", (p1,))[0][0] == cafe_cat[0])
    denied("guest cannot read search_name", G, "select search_name from public.providers")
    for name in ["Power Gym", "Gold's Gym", "Café Aroma", "مطعم أبو السيد", "Dr. Ahmed Dental Clinic", "Zara Store"]:
        ok(A, "select public.admin_create_provider(%s, 'Passw0rd!', %s, 10, '')", ("u" + uuid.uuid4().hex[:10], name))
    ok(A, "select public.admin_update_provider(id, %s) from public.providers where name='Power Gym'", (json.dumps({"category_id": str(gyms)}),))
    def S(q, cat=None, lim=5, off=0):
        return [r[0] for r in ok(G, "select name from public.search_providers(%s, %s, %s, %s)", (q, cat, lim, off))]
    check("search exact", S("aroma")[:1] == ["Café Aroma"], str(S("aroma")))
    check("search accent-insensitive", "Café Aroma" in S("cafe"), str(S("cafe")))
    check("search typo 'aroam'", "Café Aroma" in S("aroam"), str(S("aroam")))
    check("search typo 'powr gym'", S("powr gym")[:1] == ["Power Gym"], str(S("powr gym")))
    check("search typo 'dentel'", "Dr. Ahmed Dental Clinic" in S("dentel"), str(S("dentel")))
    check("search typo 'zarra'", "Zara Store" in S("zarra"), str(S("zarra")))
    check("search case-insensitive", "Zara Store" in S("ZARA"))
    check("search prefix ranks first", S("gym")[0] in ("Gym Two", "Gold's Gym", "Power Gym"), str(S("gym")))
    check("search arabic hamza variants", "مطعم أبو السيد" in S("ابو السيد"), str(S("ابو السيد")))
    check("search by category name", "Power Gym" in S("gyms"), str(S("gyms")))
    check("search category filter", S("gym", gyms) == ["Power Gym"], str(S("gym", gyms)))
    check("search no garbage matches", S("xqzv") == [], str(S("xqzv")))
    check("search empty query", S("   ") == [] and S("%%%") == [])
    check("search hides inactive", "Gym Two" not in S("gym two"), str(S("gym two")))
    check("search wildcard injection", S("%") == [] and S("_") == [])
    check("search limit capped at 20", len(ok(G, "select * from public.search_providers('a', null, 500, 0)")) <= 20)
    rows = ok(A, "select name, category_name from public.admin_list_providers('aroma', 10, 0)")
    check("admin list shows category", rows == [("Café Aroma", None)] or rows[0][0] == "Café Aroma", str(rows))
    check("admin category counts", any(r[0] == gyms for r in ok(A, "select * from public.admin_category_counts()")))
    denied("guest cannot call admin_category_counts", G, "select public.admin_category_counts()")
    ok(A, "delete from public.categories where id=%s", (cafe_cat[0],))
    check("deleting category un-assigns providers", ok(None, "select category_id from public.providers where id=%s", (p1,))[0][0] is None)

    # ------------------------------------------------------------ 006: limits, history, complaints
    p3 = ok(A, "select public.admin_create_provider('limit_cafe', 'Passw0rd!', 'Limit Cafe', 30, 'Dine in')")[0][0]
    p3u = ok(None, "select user_id from public.providers where id=%s", (p3,))[0][0]
    check("guest sees limit columns", ok(G, "select limit_count, limit_period, allowed_days from public.providers where id=%s", (p3,))[0] == (None, None, None))
    denied("009: provider cannot set own limits", p3u, "update public.providers set limit_count=1, limit_period='month' where id=%s", (p3,))
    denied("009: provider cannot set own days", p3u, "update public.providers set allowed_days='{5}' where id=%s", (p3,))
    denied("limit count without period rejected", None, "update public.providers set limit_count=1 where id=%s", (p3,))
    denied("limit bad period rejected", None, "update public.providers set limit_count=1, limit_period='hour' where id=%s", (p3,))
    denied("limit count 0 rejected", None, "update public.providers set limit_count=0, limit_period='month' where id=%s", (p3,))
    denied("bad weekday rejected", None, "update public.providers set allowed_days='{7}' where id=%s", (p3,))
    ok(A, "select public.admin_update_provider(%s, '{\"allowed_days\": [0,1,2,3,4,5,6,6]}')", (p3,))
    check("all 7 days normalizes to no restriction", ok(None, "select allowed_days from public.providers where id=%s", (p3,))[0][0] is None)
    denied("customer cannot set limits (no grant)", c1, "update public.providers set limit_count=50, limit_period='day' where id=%s", (p3,))
    check("customer cannot set limits", ok(None, "select limit_count from public.providers where id=%s", (p3,))[0][0] is None)
    ok(A, "select public.admin_update_provider(%s, '{\"limit_count\": 1, \"limit_period\": \"month\"}')", (p3,))
    today = ok(None, "select extract(dow from now() at time zone 'Africa/Cairo')::int")[0][0]
    def scan3(uid):
        tok = ok(uid, "select public.get_member_qr()->>'token'")[0][0]
        return ok(p3u, "select public.verify_member_qr(%s)", (tok,))[0][0]
    r = scan3(c4)
    check("first scan active + counted", r["status"] == "active" and not r["repeat"] and r["usage"]["uses_left"] == 0, str(r))
    r = scan3(c4)
    check("re-scan within 15 min = same checkout, not counted", r["status"] == "active" and r["repeat"], str(r))
    check("only one counted use", ok(None, "select count(*) from public.scans where provider_id=%s and counted", (p3,))[0][0] == 1)
    ok(None, "update public.scans set created_at = now() - interval '20 minutes' where provider_id=%s", (p3,))
    r = scan3(c4)
    check("limit reached after 1/month", r["status"] == "limit_reached" and r["discount_percent"] is None and r["usage"]["resets_at"], str(r))
    u = ok(c4, "select public.my_provider_usage(%s)", (p3,))[0][0]
    check("customer sees own usage", u["used"] == 1 and u["uses_left"] == 0 and u["limit_period"] == "month", str(u))
    denied("guest cannot read usage", G, "select public.my_provider_usage(%s)", (p3,))
    ok(None, "update public.scans set created_at = now() - interval '40 days' where provider_id=%s", (p3,))
    r = scan3(c4)
    check("new month -> active again", r["status"] == "active" and not r["repeat"], str(r))
    ok(A, "select public.admin_update_provider(%s, %s)", (p3, json.dumps({"allowed_days": [(today + 1) % 7], "limit_count": None, "limit_period": ""})))
    row = ok(None, "select allowed_days, limit_count, limit_period from public.providers where id=%s", (p3,))[0]
    check("admin sets days + clears limit", row == ([(today + 1) % 7], None, None), str(row))
    ok(None, "update public.scans set created_at = now() - interval '20 minutes' where provider_id=%s", (p3,))
    r = scan3(c4)
    check("wrong weekday -> not_today", r["status"] == "not_today" and r["discount_percent"] is None and r["usage"]["allowed_days"] == [(today + 1) % 7], str(r))
    ok(A, "select public.admin_update_provider(%s, %s)", (p3, json.dumps({"allowed_days": [today, (today + 3) % 7]})))
    r = scan3(c4)
    check("allowed weekday -> active", r["status"] == "active", str(r))
    ok(A, "select public.admin_update_provider(%s, '{\"allowed_days\": null}')", (p3,))
    check("admin clears days", ok(None, "select allowed_days from public.providers where id=%s", (p3,))[0][0] is None)
    r = scan3(c2)  # revoked earlier -> expired, never counted
    check("expired scan not counted", r["status"] == "expired" and ok(None, "select counted from public.scans where member_id=%s and provider_id=%s order by id desc limit 1", (c2, p3))[0][0] is False, str(r))
    # parallel scans of the same QR must not double-count
    import threading
    ok(A, "select public.admin_update_provider(%s, '{\"limit_count\": 1, \"limit_period\": \"year\"}')", (p3,))
    c6, _ = signup("201550003333", "Par", "Allel")
    ok(c6, "select public.subscribe_membership()")
    tok6 = ok(c6, "select public.get_member_qr()->>'token'")[0][0]
    outs = []
    def par():
        with psycopg.connect(DSN, autocommit=True) as cc, cc.transaction():
            cc.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": str(p3u), "role": "authenticated"}),))
            cc.execute("set local role authenticated")
            outs.append(cc.execute("select public.verify_member_qr(%s)", (tok6,)).fetchone()[0])
    ths = [threading.Thread(target=par) for _ in range(6)]
    [t.start() for t in ths]; [t.join() for t in ths]
    check("parallel scans count once", ok(None, "select count(*) from public.scans where member_id=%s and counted", (c6,))[0][0] == 1
          and sum(1 for o in outs if o["status"] == "active" and not o["repeat"]) == 1, str([o["status"] for o in outs]))
    # history
    h1 = ok(c4, "select provider_name, result from public.my_scan_history(50, 0)")
    check("customer history shows own scans with names", len(h1) >= 5 and all(x[0] == "Limit Cafe" for x in h1) and h1[0][1] == "active", str(h1[:3]))
    check("history is private", all(x[0] != "Limit Cafe" or False for x in []) and "Limit Cafe" not in [x[0] for x in ok(c1, "select provider_name from public.my_scan_history(50,0)")])
    check("provider history via customer rpc is empty", ok(p3u, "select * from public.my_scan_history(5,0)") == [])
    denied("guest cannot read history", G, "select * from public.my_scan_history(5,0)")
    # complaints
    reasons = ["Refused to apply the discount", "Applied a lower discount than shown on the website"]
    cid = ok(c1, "select public.file_complaint(%s, %s, %s)", (p3, reasons[0], "Cashier said <b>no</b>\x07"))[0][0]
    check("complaint filed + sanitized", ok(None, "select details, status from public.complaints where id=%s", (cid,))[0] == ("Cashier said bno/b", "open"))
    denied("complaint invalid reason", c1, "select public.file_complaint(%s, 'I just hate them', '')", (p3,), contains="invalid_reason")
    denied("complaint unknown provider", c1, "select public.file_complaint(gen_random_uuid(), %s, '')", (reasons[0],), contains="not_found")
    ok(c1, "select public.file_complaint(%s, %s, '')", (p3, reasons[1]))
    denied("max 2 reports per partner per week", c1, "select public.file_complaint(%s, %s, '')", (p3, reasons[0]), contains="too_many_reports")
    denied("guest cannot complain", G, "select public.file_complaint(%s, %s, '')", (p3, reasons[0]))
    denied("provider cannot complain", p3u, "select public.file_complaint(%s, %s, '')", (p1, reasons[0]))
    for t in [c1, p3u, A]:
        denied("complaints table not directly readable", t, "select * from public.complaints")
    check("customer sees own complaints", len(ok(c1, "select * from public.my_complaints()")) == 2)
    check("other customer sees none", ok(c2, "select * from public.my_complaints()") == [])
    check("provider sees no complaints", ok(p3u, "select * from public.my_complaints()") == [])
    denied("customer cannot list all complaints", c1, "select * from public.admin_list_complaints()")
    denied("provider cannot update complaint", p3u, "select public.admin_update_complaint(%s, 'dismissed', '')", (cid,))
    rows = ok(A, "select provider_name, member_phone, status, member_scans_here from public.admin_list_complaints('open', 10, 0)")
    check("admin lists complaints", len(rows) == 2 and rows[0][0] == "Limit Cafe" and rows[0][1] == "201001112222", str(rows))
    check("admin stats open complaints", ok(A, "select public.admin_stats()->>'complaints_open'")[0][0] == "2")
    denied("admin invalid status", A, "select public.admin_update_complaint(%s, 'deleted', '')", (cid,), contains="invalid_status")
    ok(A, "select public.admin_update_complaint(%s, 'resolved', 'Partner warned')", (cid,))
    mine = {r[0]: r for r in ok(c1, "select id, status, admin_note from public.my_complaints()")}
    check("customer sees resolution", mine[cid][1:] == ("resolved", "Partner warned"), str(mine.get(cid)))
    ok(A, "update public.settings set data = data || '{\"complaint_reasons\": [\"Rude staff\", \"Other\"]}'")
    ok(c2, "select public.file_complaint(%s, 'Rude staff', '')", (p3,))
    denied("removed default reason rejected", c2, "select public.file_complaint(%s, %s, '')", (p3, reasons[1]), contains="invalid_reason")
    hits = [run(c3, "select public.file_complaint(%s, 'Other', '')", (pid,)) for (pid,) in ok(None, "select id from public.providers limit 6")]
    check("complaint daily rate limit", hits[-1][1] is not None and "rate_limited" in hits[-1][1], str(hits[-1]))
    # discount filter in search
    res = [r[0] for r in ok(G, "select discount_percent from public.search_providers('a', null, 20, 0, 20)")]
    check("search min discount", res and min(res) >= 20, str(res))

    # ------------------------------------------------------------ 007: areas + Sunday weeks
    areas = [r[0] for r in ok(G, "select name from public.areas order by sort_order")]
    check("starter areas", areas == ["6th of October", "Sheikh Zayed"], str(areas))
    for who in (G, c1, p1u):
        denied("non-admin cannot add area", who, "insert into public.areas (name) values ('x')")
    ok(p1u, "update public.areas set name='hacked'")
    check("provider cannot rename area", ok(None, "select count(*) from public.areas where name='hacked'")[0][0] == 0)
    zayed = ok(None, "select id from public.areas where name='Sheikh Zayed'")[0][0]
    octo = ok(None, "select id from public.areas where name='6th of October'")[0][0]
    new_area = ok(A, "insert into public.areas (name, sort_order) values ('New <i>Cairo</i>', 30) returning id, name")[0]
    check("area name sanitized", new_area[1] == "New iCairo/i", str(new_area))
    denied("provider cannot set own area", p3u, "update public.providers set area_id=%s where id=%s", (zayed, p3))
    ok(A, "select public.admin_update_provider(%s, %s)", (p3, json.dumps({"area_id": str(zayed)})))
    ok(A, "select public.admin_update_provider(id, %s) from public.providers where name='Power Gym'", (json.dumps({"area_id": str(octo)}),))
    check("guest sees area id", ok(G, "select area_id from public.providers where id=%s", (p3,))[0][0] == zayed)
    r = ok(G, "select name, area_name from public.search_providers('cafe', null, 20, 0, null, %s)", (zayed,))
    check("search filtered by area with area name", r == [("Limit Cafe", "Sheikh Zayed")], str(r))
    r = [x[0] for x in ok(G, "select name from public.search_providers('gym', null, 20, 0, null, %s)", (zayed,))]
    check("search area excludes other areas", "Power Gym" not in r, str(r))
    check("provider context has area", ok(p3u, "select public.get_my_context()->'provider'->>'area_name'")[0][0] == "Sheikh Zayed")
    ok(A, "update public.areas set is_active=false where id=%s", (new_area[0],))
    check("hidden area not public", "New iCairo/i" not in [r[0] for r in ok(G, "select name from public.areas")])
    check("admin area counts", any(r[0] == zayed for r in ok(A, "select * from public.admin_area_counts()")))
    ok(A, "delete from public.areas where id=%s", (zayed,))
    check("deleting area un-assigns", ok(None, "select area_id from public.providers where id=%s", (p3,))[0][0] is None)
    wk = ok(None, "select private.period_start('week', '2026-11-11 10:00'::timestamp)::date::text, private.period_start('week', '2026-11-08 23:00'::timestamp)::date::text, private.period_start('week', '2026-11-14 23:59'::timestamp)::date::text")[0]
    check("weeks start on Sunday", wk == ("2026-11-08", "2026-11-08", "2026-11-08"), str(wk))
    ok(A, "select public.admin_update_provider(%s, '{\"limit_count\": 2, \"limit_period\": \"week\"}')", (p3,))
    u = ok(c4, "select public.my_provider_usage(%s)", (p3,))[0][0]
    rs = ok(None, "select extract(dow from (%s::timestamptz at time zone 'Africa/Cairo'))::int, (%s::timestamptz at time zone 'Africa/Cairo')::time::text", (u["resets_at"], u["resets_at"]))[0]
    check("weekly reset is Sunday 00:00 Cairo", rs == (0, "00:00:00"), str(rs))

    # ------------------------------------------------------------ 008: admin security
    check("schema status", ok(G, "select public.schema_status()")[0][0]["m008"] is True)
    AAL2.discard(A)
    check("admin without 2FA is not admin", ok(A, "select public.is_admin()")[0][0] is False
          and ok(A, "select public.get_my_context()->>'role'")[0][0] == "none")
    g = ok(A, "select public.admin_gate()")[0][0]
    check("gate: listed admin at aal1", g == {"banned": False, "listed": True, "aal": "aal1"}, str(g))
    AAL2.add(A)
    check("admin with 2FA is admin", ok(A, "select public.is_admin()")[0][0] is True)
    # anonymous probing of admin RPCs -> ban
    IP_OVERRIDE["anon"] = "203.0.113.7"
    for _ in range(5):
        run(G, "select public.admin_stats()")
    check("anon probes get banned", ok(G, "select public.admin_gate()")[0][0] == {"banned": True})
    # brute-force reports
    IP_OVERRIDE["anon"] = "203.0.113.8"
    for _ in range(9):
        ok(G, "select public.report_admin_failure('password', 'owner@gmail.com')")
    check("9 bad passwords not yet banned", ok(G, "select public.admin_gate()->>'banned'")[0][0] == "false")
    ok(G, "select public.report_admin_failure('password', 'owner@gmail.com')")
    check("10 bad passwords -> banned", ok(G, "select public.admin_gate()->>'banned'")[0][0] == "true")
    # non-admin account logging into admin page
    IP_OVERRIDE[c3] = "203.0.113.9"
    for _ in range(3):
        ok(c3, "select public.admin_gate()")
    check("non-admin on admin page -> banned", ok(c3, "select public.admin_gate()->>'banned'")[0][0] == "true")
    # admin from banned IP loses admin
    IP_OVERRIDE[A] = "203.0.113.9"
    check("admin from banned IP is not admin", ok(A, "select public.is_admin()")[0][0] is False)
    check("admin from banned IP gets no data", ok(A, "select public.admin_stats()")[0][0] is None)
    IP_OVERRIDE[A] = "10.0.0.1"
    sec = ok(A, "select public.admin_security_overview()")[0][0]
    bans = {b["ip"] for b in sec["bans"]}
    check("admin sees bans + events", {"203.0.113.7", "203.0.113.8", "203.0.113.9"} <= bans and len(sec["events"]) > 10 and sec["my_ip"] == "10.0.0.1", str(bans))
    check("events show the account email", any(e.get("email") for e in sec["events"]))
    denied("admin cannot ban own IP", A, "select public.admin_ban_ip('10.0.0.1', 1, 'x')", contains="cannot_ban_self")
    ok(A, "select public.admin_unban_ip('203.0.113.8')")
    IP_OVERRIDE["anon"] = "203.0.113.8"
    check("unbanned", ok(G, "select public.admin_gate()->>'banned'")[0][0] == "false")
    ok(G, "select public.report_admin_failure('password', 'x')")
    check("unban resets score", ok(G, "select public.admin_gate()->>'banned'")[0][0] == "false")
    ok(A, "select public.admin_ban_ip('198.51.100.4', 7, 'manual test')")
    check("manual ban", ok(None, "select private.ip_banned('198.51.100.4')")[0][0] is True)
    rep = ok(None, "select expires_at > now() + interval '6 days' from private.ip_bans where ip='198.51.100.4'")[0][0]
    check("manual ban length", rep is True)
    IP_OVERRIDE["anon"] = "unknown-ip"  # header missing -> 'unknown' never banned
    ok(None, "select 1")
    for t in ("security_events", "ip_bans", "payment_counters"):
        denied(f"private.{t} not readable", c1, f"select * from private.{t}")
    # repeat offender: second ban within 30 days lasts 30 days
    IP_OVERRIDE["anon"] = "203.0.113.20"
    for _ in range(10): ok(G, "select public.report_admin_failure('password', 'x')")
    ok(None, "update private.ip_bans set expires_at = now() - interval '1 minute' where ip='203.0.113.20'")
    ok(None, "delete from private.security_events where ip='203.0.113.20'")
    for _ in range(10): ok(G, "select public.report_admin_failure('password', 'x')")
    check("repeat offender banned 30 days", ok(None, "select expires_at > now() + interval '29 days' from private.ip_bans where ip='203.0.113.20'")[0][0] is True)
    IP_OVERRIDE.pop("anon", None)

    # ------------------------------------------------------------ 008: payments
    ok(A, "update public.settings set data = data || '{\"payment_mode\": \"inactive\"}'")
    check("payment options inactive", ok(G, "select public.payment_options()->>'mode'")[0][0] == "inactive")
    c7, _ = signup("201550007777", "Pay", "One"); c8, _ = signup("201550008888", "Pay", "Two"); c9, _ = signup("201550009999", "Pay", "Three")
    denied("inactive: no free subscribe", c7, "select public.subscribe_membership()", contains="payment_required")
    denied("inactive: no payment start", c7, "select public.start_membership_payment('instapay')", contains="payments_unavailable")
    ok(A, "update public.settings set data = data || '{\"payment_mode\": \"active\", \"payment_rotate_every\": 2, \"membership_price_egp\": 199}'")
    denied("active: free subscribe blocked", c7, "select public.subscribe_membership()", contains="payment_required")
    denied("no accounts yet", c7, "select public.start_membership_payment('instapay')", contains="method_unavailable")
    denied("bad method", c7, "select public.start_membership_payment('cash')", contains="method_unavailable")
    denied("customer cannot add account", c7, "insert into public.payment_accounts (method, value) values ('instapay', 'me@instapay')")
    acc = {}
    for m, v, so in (("instapay", "xgo.one@instapay", 1), ("instapay", "xgo.two@instapay", 2), ("vodafone", "0100 123 4567", 1)):
        acc[v] = ok(A, "insert into public.payment_accounts (method, value, sort_order) values (%s, %s, %s) returning id, value", (m, v, so))[0]
    check("vodafone number normalized", acc["0100 123 4567"][1] == "01001234567")
    denied("invalid wallet number", A, "insert into public.payment_accounts (method, value) values ('vodafone', '12345')", contains="invalid_wallet_number")
    check("customer cannot list accounts", ok(c7, "select * from public.payment_accounts") == [])
    denied("guest cannot list accounts", G, "select * from public.payment_accounts")
    opts = ok(G, "select public.payment_options()")[0][0]
    check("options: methods but no numbers", sorted(opts["methods"]) == ["instapay", "vodafone"] and "xgo" not in json.dumps(opts), str(opts))
    def start(uid, m):
        return ok(uid, "select public.start_membership_payment(%s)", (m,))[0][0]
    def proof(uid, req, ext="webp", tag="abcd"):
        path = f"{uid}/{req}-{tag}.{ext}"
        ok(uid, "insert into storage.objects (bucket_id, name, owner) values ('proofs', %s, %s)", (path, uid))
        return path
    r7 = start(c7, "instapay")
    check("first request -> first account + server price", r7["account_value"] == "xgo.one@instapay" and float(r7["amount"]) == 199, str(r7))
    r7b = start(c7, "vodafone")
    check("switching method reuses the draft", r7b["request_id"] == r7["request_id"] and r7b["account_value"] == "01001234567")
    r7 = start(c7, "instapay")
    denied("submit without proof", c7, "select public.submit_membership_request(%s, %s, '')", (r7["request_id"], f"{c7}/{r7['request_id']}-zzzz.webp"), contains="proof_required")
    denied("proof upload into another user's folder", c7, "insert into storage.objects (bucket_id, name) values ('proofs', %s)", (f"{c8}/x-abcd.webp",))
    denied("provider cannot upload proofs", p1u, "insert into storage.objects (bucket_id, name) values ('proofs', %s)", (f"{p1u}/x-abcd.webp",))
    denied("guest cannot upload proofs", G, "insert into storage.objects (bucket_id, name) values ('proofs', 'x/y-abcd.webp')")
    pth = proof(c7, r7["request_id"])
    denied("cannot submit someone else's draft", c8, "select public.submit_membership_request(%s, %s, '')", (r7["request_id"], pth), contains="not_found")
    ok(c7, "select public.submit_membership_request(%s, %s, %s)", (r7["request_id"], pth, "Pay One <b>CIB</b>"))
    st = ok(c7, "select public.my_membership_request()")[0][0]
    check("request pending", st["status"] == "pending" and st["method"] == "instapay", str(st))
    check("sender info sanitized", ok(None, "select sender_info from public.membership_requests where id=%s", (r7["request_id"],))[0][0] == "Pay One bCIB/b")
    denied("second request while pending", c7, "select public.start_membership_payment('vodafone')", contains="request_pending")
    denied("customer cannot read requests table", c7, "select * from public.membership_requests")
    check("proof private to owner", ok(c8, "select count(*) from storage.objects where bucket_id='proofs'")[0][0] == 0
          and ok(c7, "select count(*) from storage.objects where bucket_id='proofs'")[0][0] == 1
          and ok(A, "select count(*) from storage.objects where bucket_id='proofs'")[0][0] == 1)
    r8 = start(c8, "instapay")
    check("rotation: 2nd request same account (every 2)", r8["account_value"] == "xgo.one@instapay", str(r8))
    ok(c8, "select public.submit_membership_request(%s, %s, '')", (r8["request_id"], proof(c8, r8["request_id"], "jpg")))
    r9 = start(c9, "instapay")
    check("rotation: 3rd request rolls to next account", r9["account_value"] == "xgo.two@instapay", str(r9))
    ov = ok(A, "select public.admin_payment_overview()")[0][0]
    check("overview counters + current", ov["counters"]["instapay"] == 2 and ov["current"]["instapay"] == str(acc["xgo.two@instapay"][0]) and ov["pending"] == 2, str(ov))
    check("uses_count", ok(A, "select uses_count from public.payment_accounts where value='xgo.one@instapay'")[0][0] == 2)
    ok(c9, "select public.cancel_membership_request()")
    check("cancel draft", ok(c9, "select public.my_membership_request()")[0][0] is None)
    reqs = ok(A, "select id, member_phone, status, member_status from public.admin_list_requests('pending', 10, 0)")
    check("admin lists pending oldest first", [r[1] for r in reqs] == ["201550007777", "201550008888"] and reqs[0][3] == "none", str(reqs))
    check("drafts hidden from admin", all(r[2] != "draft" for r in ok(A, "select id, member_phone, status from public.admin_list_requests('', 50, 0)")))
    denied("customer cannot decide", c7, "select public.admin_decide_request(%s, true, '')", (r7["request_id"],))
    check("still pending after customer attempt", ok(None, "select status from public.membership_requests where id=%s", (r7["request_id"],))[0][0] == "pending")
    st = ok(A, "select public.admin_decide_request(%s, true, 'Thanks')", (r7["request_id"],))[0][0]
    check("approve activates membership", st["status"] == "active", str(st))
    m7 = ok(None, "select source, paid_egp, list_price_egp, extract(day from expires_at - now()) from public.memberships where user_id=%s", (c7,))[0]
    check("membership from payment", m7[0] == "payment" and m7[1] == 199 and 363 <= m7[3] <= 366, str(m7))
    denied("cannot decide twice", A, "select public.admin_decide_request(%s, false, '')", (r7["request_id"],), contains="already_decided")
    ok(A, "select public.admin_decide_request(%s, false, 'Screenshot unclear')", (r8["request_id"],))
    st = ok(c8, "select public.my_membership_request()")[0][0]
    check("rejected visible with note", st["status"] == "rejected" and st["admin_note"] == "Screenshot unclear", str(st))
    check("rejected user has no membership", ok(c8, "select public.get_my_context()->'membership'->>'status'")[0][0] == "none")
    r8b = start(c8, "vodafone")
    check("rejected user can try again", r8b["account_value"] == "01001234567")
    denied("active member cannot pay again early", c7, "select public.start_membership_payment('instapay')", contains="already_active")
    check("admin stats pending", ok(A, "select public.admin_stats()->>'requests_pending'")[0][0] == "0")
    ok(A, "update public.settings set data = data || '{\"payment_mode\": \"free\"}'")
    denied("free mode: no paid requests", c9, "select public.start_membership_payment('instapay')", contains="payments_unavailable")
    ok(c9, "select public.subscribe_membership()")

    # ------------------------------------------------------------ 009: single session per customer
    t1 = ok(c1, "select public.get_member_qr()->>'token'")[0][0]
    old_sid = SESS[c1]
    ok(None, "insert into auth.sessions (id, user_id) values (%s, %s)", (old_sid, c1))
    new_sid = str(uuid.uuid4())
    ok(None, "insert into auth.sessions (id, user_id) values (%s, %s)", (new_sid, c1))
    ok(None, "insert into auth.sessions (id, user_id) values (gen_random_uuid(), %s)", (c1,))
    SESS[c1] = new_sid
    r = ok(c1, "select public.claim_session()")[0][0]
    check("login claims session, revokes the others", r == {"claimed": True, "revoked": 2} and
          ok(None, "select array_agg(id::text) from auth.sessions where user_id=%s", (c1,))[0][0] == [new_sid], str(r))
    res = ok(p1u, "select public.verify_member_qr(%s)", (t1,))[0][0]
    check("QR from the replaced login is invalid", res == {"status": "invalid"}, str(res))
    t2 = ok(c1, "select public.get_member_qr()->>'token'")[0][0]
    check("QR from the active login works", ok(p1u, "select public.verify_member_qr(%s)", (t2,))[0][0]["status"] in ("active", "limit_reached", "not_today"))
    SESS[c1] = old_sid  # the other phone keeps using its old access token
    check("old device: context says revoked", ok(c1, "select public.get_my_context()->>'role'")[0][0] == "revoked")
    denied("old device: no QR", c1, "select public.get_member_qr()", contains="session_revoked")
    denied("old device: no complaint", c1, "select public.file_complaint(%s, %s, '')", (p3, "Other"), contains="session_revoked")
    denied("old device: no trial", c1, "select public.start_trial()", contains="session_revoked")
    ok(c1, "update public.profiles set first_name='Hacker' where id=%s", (c1,))
    check("old device: profile edit blocked", ok(None, "select first_name from public.profiles where id=%s", (c1,))[0][0] != "Hacker")
    SESS[c1] = new_sid
    check("active device fine", ok(c1, "select public.get_my_context()->>'role'")[0][0] == "customer")
    check("partner login doesn't kick other partner devices", ok(p1u, "select public.claim_session()")[0][0] == {"claimed": False})
    check("customer without claim row is not blocked", ok(c2, "select public.session_ok()")[0][0] is True)

    # ------------------------------------------------------------ 009: free trial (1 scan)
    ct, _ = signup("201550012345", "Tri", "Al")
    check("trial available", ok(ct, "select public.get_my_context()->>'trial'")[0][0] == "available")
    denied("no QR before trial", ct, "select public.get_member_qr()", contains="no_membership")
    ok(ct, "select public.start_trial()")
    check("trial active", ok(ct, "select public.get_my_context()->>'trial'")[0][0] == "active")
    denied("trial only once", ct, "select public.start_trial()", contains="trial_used")
    tt = ok(ct, "select public.get_member_qr()")[0][0]
    check("trial QR", tt["status"] == "none" and tt["trial"] == "active")
    res = ok(p1u, "select public.verify_member_qr(%s)", (tt["token"],))[0][0]
    check("trial scan gives the discount", res["status"] == "active" and res["trial"] is True and float(res["discount_percent"]) == 20, str(res))
    check("trial now used", ok(ct, "select public.get_my_context()->>'trial'")[0][0] == "used")
    res = ok(p1u, "select public.verify_member_qr(%s)", (ok(ct, "select public.get_member_qr()->>'token'")[0][0],))[0][0]
    check("same checkout re-scan still ok", res["status"] == "active" and res["repeat"], str(res))
    res = ok(p3u, "select public.verify_member_qr(%s)", (ok(ct, "select public.get_member_qr()->>'token'")[0][0],))[0][0]
    check("trial used at another partner", res["status"] == "trial_used" and res["discount_percent"] is None, str(res))
    ok(None, "update public.trials set used_at = now() - interval '20 minutes' where user_id=%s", (ct,))
    ok(None, "update public.scans set created_at = now() - interval '20 minutes' where member_id=%s", (ct,))
    res = ok(p1u, "select public.verify_member_qr(%s)", (ok(ct, "select public.get_member_qr()->>'token'")[0][0],))[0][0]
    check("trial used later -> refused", res["status"] == "trial_used", str(res))
    check("one counted trial scan", ok(None, "select count(*) from public.scans where member_id=%s and counted and trial", (ct,))[0][0] == 1)
    denied("trials table private", ct, "select * from public.trials")
    denied("member can't start trial", c7, "select public.start_trial()", contains="already_active")
    ok(A, "update public.settings set data = data || '{\"trial_enabled\": false}'")
    cu, _ = signup("201550012346", "No", "Trial")
    check("trial disabled", ok(cu, "select public.get_my_context()->>'trial'")[0][0] == "disabled")
    denied("trial disabled start", cu, "select public.start_trial()", contains="trial_unavailable")
    ok(A, "update public.settings set data = data - 'trial_enabled'")
    # parallel trial scans at two partners: only one gets the discount
    cp, _ = signup("201550012347", "Par", "Trial")
    ok(cp, "select public.start_trial()")
    tokp = ok(cp, "select public.get_member_qr()->>'token'")[0][0]
    outs = []
    def par2(prov_uid):
        with psycopg.connect(DSN, autocommit=True) as cc, cc.transaction():
            cc.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": str(prov_uid), "role": "authenticated"}),))
            cc.execute("set local role authenticated")
            outs.append(cc.execute("select public.verify_member_qr(%s)", (tokp,)).fetchone()[0]["status"])
    import threading
    ths = [threading.Thread(target=par2, args=(u,)) for u in (p1u, p3u, p1u, p3u)]
    [t.start() for t in ths]; [t.join() for t in ths]
    check("parallel trial scans at 2 partners: one discount", ok(None, "select count(*) from public.scans where member_id=%s and counted", (cp,))[0][0] == 1, str(outs))

    # ------------------------------------------------------------ 009: InstaPay links
    ok(A, "update public.payment_accounts set pay_link='https://ipn.eg/S/xgoone/instapay/6PANJ2' where value='xgo.one@instapay'")
    denied("bad pay link rejected", A, "update public.payment_accounts set pay_link='javascript:alert(1)' where value='xgo.one@instapay'")
    denied("non-ipn link rejected", A, "update public.payment_accounts set pay_link='https://evil.com/S/x/instapay/abc' where value='xgo.one@instapay'")
    ok(A, "update public.settings set data = data || '{\"payment_mode\": \"active\"}'")
    cl, _ = signup("201550012348", "Link", "Pay")
    r9 = ok(cl, "select public.start_membership_payment('instapay')")[0][0]
    check("payment start returns pay link", r9["pay_link"] == "https://ipn.eg/S/xgoone/instapay/6PANJ2" or r9["account_value"] != "xgo.one@instapay", str(r9))
    ok(cl, "select public.cancel_membership_request()")
    ok(A, "update public.settings set data = data || '{\"payment_mode\": \"free\"}'")
    check("schema 009", ok(G, "select public.schema_status()->>'m009'")[0][0] == "true")

    # ------------------------------------------------------------ 010: home feed
    f = ok(G, "select public.home_feed(null, 10, 5, 10)")[0][0]
    tops = f["top"]
    n_active = ok(None, "select count(*) from public.providers where is_active")[0][0]
    check("top: up to 10 deals", len(tops) == min(10, n_active), f"{len(tops)} of {n_active}")
    cat_of = {str(r[0]): r[1] for r in ok(None, "select id, category_id from public.providers")}
    first_cats = [cat_of[t["id"]] or t["id"] for t in tops[:3]]
    check("top: spread across categories", len(set(first_cats)) == 3, str(first_cats))
    best = ok(None, "select max(discount_percent) from public.providers where is_active")[0][0]
    check("top: includes the best deal", any(float(t["discount_percent"]) == float(best) for t in tops))
    check("rows: <= 5 categories, <= 10 each, sorted", len(f["rows"]) <= 5 and all(len(r["items"]) <= 10 for r in f["rows"])
          and all([float(i["discount_percent"]) for i in r["items"]] == sorted([float(i["discount_percent"]) for i in r["items"]], reverse=True) for r in f["rows"]))
    check("rows: only active, no private fields", "username" not in json.dumps(f) and "user_id" not in json.dumps(f))
    octo2 = ok(None, "select id from public.areas where name='6th of October'")[0][0]
    fa = ok(G, "select public.home_feed(%s, 10, 5, 10)", (octo2,))[0][0]
    names_in_area = {r[0] for r in ok(None, "select name from public.providers where area_id=%s and is_active", (octo2,))}
    check("area filter", all(t["name"] in names_in_area for t in fa["top"]) and all(i["name"] in names_in_area for r in fa["rows"] for i in r["items"]))
    check("limits capped", len(ok(G, "select public.home_feed(null, 500, 50, 500)")[0][0]["top"]) <= 20)
    check("schema 010", ok(G, "select public.schema_status()->>'m010'")[0][0] == "true")

    # ------------------------------------------------------------ 011: branches / multi-area partners
    octo3 = ok(None, "select id from public.areas where name='6th of October'")[0][0]
    zay2 = ok(A, "insert into public.areas (name, sort_order) values ('Zayed 2', 40) returning id")[0][0]
    mad = ok(A, "insert into public.areas (name, sort_order) values ('Maadi', 50) returning id")[0][0]
    ok(A, "select public.admin_update_provider(%s, %s)", (p1, json.dumps({"area_id": str(octo3)})))
    b1 = ok(A, "insert into public.branches (provider_id, area_id, name, address, phone, maps_url) values (%s, %s, 'Mall branch', '12 Mall St <b>', '+20 100 123 4567', 'https://maps.app.goo.gl/abc123') returning id, address, phone", (p1, zay2))[0]
    check("branch sanitized", b1[1] == "12 Mall St  b" or b1[1].startswith("12 Mall St") and "<" not in b1[1], str(b1))
    check("branch phone normalized", b1[2] == "+201001234567", str(b1))
    denied("bad maps link rejected", A, "insert into public.branches (provider_id, area_id, maps_url) values (%s, %s, 'javascript:alert(1)')", (p1, zay2))
    denied("non-google maps link rejected", A, "insert into public.branches (provider_id, area_id, maps_url) values (%s, %s, 'https://evil.com/maps/x')", (p1, zay2))
    ok(A, "insert into public.branches (provider_id, area_id, address) values (%s, %s, 'Road 9')", (p1, mad))
    ids = set(ok(G, "select area_ids from public.providers where id=%s", (p1,))[0][0])
    check("partner in main + branch areas", ids == {octo3, zay2, mad}, str(ids))
    for who in (G, c1, p1u):
        denied("non-admin cannot add branch", who, "insert into public.branches (provider_id, area_id, address) values (%s, %s, 'x')", (p1, mad))
    denied("partner cannot change area_ids", p1u, "update public.providers set area_ids='{}' where id=%s", (p1,))
    ok(p1u, "update public.branches set address='hacked'")
    check("partner cannot edit branches", ok(None, "select count(*) from public.branches where address='hacked'")[0][0] == 0)
    check("partner sees own branches", len(ok(p1u, "select id from public.branches where provider_id=%s", (p1,))) == 2)
    check("guest sees active branches", len(ok(G, "select id, address, phone, maps_url from public.branches where provider_id=%s", (p1,))) == 2)
    r = [x[0] for x in ok(G, "select name from public.search_providers('cafe', null, 20, 0, null, %s)", (mad,))]
    check("search finds partner by branch area", "Cafe 1" in r, str(r))
    fm = ok(G, "select public.home_feed(%s, 10, 5, 10)", (mad,))[0][0]
    tm = [t for t in fm["top"] if t["name"] == "Cafe 1"]
    check("home feed by branch area shows that area's name", tm and tm[0]["area_name"] == "Maadi" and tm[0]["areas_count"] == 3, str(tm))
    check("offers filter by area_ids", ok(G, "select count(*) from public.providers where is_active and area_ids @> array[%s]::uuid[]", (mad,))[0][0] >= 1)
    ok(A, "update public.branches set is_active=false where area_id=%s", (mad,))
    check("inactive branch area dropped", mad not in ok(G, "select area_ids from public.providers where id=%s", (p1,))[0][0])
    check("hidden branch not public", len(ok(G, "select id from public.branches where provider_id=%s", (p1,))) == 1)
    ok(A, "delete from public.areas where id=%s", (zay2,))
    check("deleted area removed from partner", zay2 not in ok(G, "select area_ids from public.providers where id=%s", (p1,))[0][0])
    ok(A, "select public.admin_update_provider(%s, '{\"area_id\": \"\"}')", (p1,))
    check("main area cleared", octo3 not in ok(G, "select area_ids from public.providers where id=%s", (p1,))[0][0])
    check("area counts use branches", any(r[0] for r in ok(A, "select * from public.admin_area_counts()")))
    denied("branch needs area or address", A, "insert into public.branches (provider_id) values (%s)", (p1,), contains="branch_needs_area_or_address")
    check("schema 011", ok(G, "select public.schema_status()->>'m011'")[0][0] == "true")

    # ------------------------------------------------------------ 012: multiple discounts (offers)
    p9 = ok(A, "select public.admin_create_provider('clinic9', 'Passw0rd!', 'Clinic Nine', 10, '')")[0][0]
    p9u = ok(None, "select user_id from public.providers where id=%s", (p9,))[0][0]
    check("max = standard without offers", float(ok(G, "select max_percent from public.providers where id=%s", (p9,))[0][0]) == 10)
    now_t = "(now() at time zone 'Africa/Cairo')::time"
    tr = ok(A, f"insert into public.discount_rules (provider_id, kind, title, percent, start_time, end_time) values (%s, 'time', 'Lunch <b>', 30, {now_t} - interval '1 hour', {now_t} + interval '1 hour') returning id, title", (p9,))[0]
    check("offer title sanitized", "<" not in tr[1], tr[1])
    ok(A, f"insert into public.discount_rules (provider_id, kind, title, percent, start_time, end_time) values (%s, 'time', 'Night', 45, {now_t} + interval '2 hours', {now_t} + interval '3 hours')", (p9,))
    ok(A, "insert into public.discount_rules (provider_id, kind, percent) values (%s, 'first', 50)", (p9,))
    ok(A, "insert into public.discount_rules (provider_id, kind, title, percent, sort_order) values (%s, 'service', 'Initial assessment', 50, 1), (%s, 'service', 'Cupping', 30, 2), (%s, 'service', 'Massage', 20, 3)", (p9, p9, p9))
    check("max_percent follows best offer", float(ok(G, "select max_percent from public.providers where id=%s", (p9,))[0][0]) == 50)
    denied("second first-visit offer rejected", A, "insert into public.discount_rules (provider_id, kind, percent) values (%s, 'first', 40)", (p9,))
    denied("time offer needs times", A, "insert into public.discount_rules (provider_id, kind, percent) values (%s, 'time', 40)", (p9,))
    denied("service offer needs a name", A, "insert into public.discount_rules (provider_id, kind, percent) values (%s, 'service', 40)", (p9,))
    denied("offer percent > 100 rejected", A, "insert into public.discount_rules (provider_id, kind, title, percent) values (%s, 'service', 'x', 150)", (p9,))
    denied("offer bad weekday rejected", A, "insert into public.discount_rules (provider_id, kind, percent, start_time, end_time, days) values (%s, 'time', 5, '10:00', '11:00', '{9}')", (p9,))
    for who in (G, c1, p9u):
        denied("non-admin cannot add offer", who, "insert into public.discount_rules (provider_id, kind, title, percent) values (%s, 'service', 'x', 90)", (p9,))
    ok(p9u, "update public.discount_rules set percent=99")
    check("partner cannot edit offers", ok(None, "select count(*) from public.discount_rules where percent=99")[0][0] == 0)
    check("guest sees active offers", len(ok(G, "select kind, title, percent, start_time, end_time, days from public.discount_rules where provider_id=%s", (p9,))) == 6)
    check("partner sees own offers", len(ok(p9u, "select id from public.discount_rules where provider_id=%s", (p9,))) == 6)

    def scan9():
        tok = ok(c1, "select public.get_member_qr()")[0][0]["token"]
        return ok(p9u, "select public.verify_member_qr(%s)", (tok,))[0][0]
    def age9():   # pretend the last visit was a while ago
        ok(None, "update public.scans set created_at = now() - interval '2 days' where provider_id=%s", (p9,))
    r = scan9()
    check("first visit gets first-visit offer", r["status"] == "active" and float(r["discount_percent"]) == 50 and r["discount_kind"] == "first", str(r))
    check("scan lists service offers", [(x["title"], float(x["percent"])) for x in r["services"]] == [("Initial assessment", 50), ("Cupping", 30), ("Massage", 20)], str(r["services"]))
    check("scan shows standard", float(r["standard_percent"]) == 10)
    r = scan9()
    check("re-scan same checkout keeps first visit", r["repeat"] and r["discount_kind"] == "first" and float(r["discount_percent"]) == 50, str(r))
    age9()
    r = scan9()
    check("next visit gets time offer", r["discount_kind"] == "time" and float(r["discount_percent"]) == 30 and r["time_title"] == tr[1] and r["time_from"], str(r))
    check("scan stores why", ok(A, "select discount_kind, discount_percent from public.scans where provider_id=%s order by id desc limit 1", (p9,))[0] == ("time", 30))
    ok(A, "update public.discount_rules set is_active=false where provider_id=%s and kind='time'", (p9,))
    age9()
    r = scan9()
    check("outside offers -> standard", r["discount_kind"] == "standard" and float(r["discount_percent"]) == 10, str(r))
    check("hidden offer not public", len(ok(G, "select id from public.discount_rules where provider_id=%s", (p9,))) == 4)
    # time window over midnight that excludes now, and weekday filter
    ok(A, f"update public.discount_rules set is_active=true, start_time={now_t} + interval '1 hour', end_time={now_t} - interval '1 hour' where provider_id=%s and title='Night'", (p9,))
    check("window over midnight excluding now", ok(None, "select count(*) from private.time_rule_now(%s)", (p9,))[0][0] == 0)
    ok(A, f"update public.discount_rules set start_time={now_t} - interval '1 hour', end_time={now_t} + interval '1 hour', days=array[(extract(dow from now() at time zone 'Africa/Cairo')::int + 1) %% 7]::smallint[] where provider_id=%s and title='Night'", (p9,))
    check("offer on another weekday not applied", ok(None, "select count(*) from private.time_rule_now(%s)", (p9,))[0][0] == 0)
    ok(A, "update public.discount_rules set days=array[0,1,2,3,4,5,6]::smallint[] where provider_id=%s and title='Night'", (p9,))
    check("all 7 days stored as every day", ok(A, "select days from public.discount_rules where provider_id=%s and title='Night'", (p9,))[0][0] is None)
    check("time offer applies today", float(ok(None, "select percent from private.time_rule_now(%s)", (p9,))[0][0]) == 45)
    ok(A, "select public.admin_update_provider(%s, '{\"discount_percent\": 0}')", (p9,))
    check("standard discount may be 0", float(ok(G, "select discount_percent from public.providers where id=%s", (p9,))[0][0]) == 0)
    ok(A, "delete from public.discount_rules where provider_id=%s and kind in ('first', 'time')", (p9,))
    check("max_percent drops after delete", float(ok(G, "select max_percent from public.providers where id=%s", (p9,))[0][0]) == 50)
    age9()
    r = scan9()
    check("services-only partner: 0% standard + list", float(r["discount_percent"]) == 0 and len(r["services"]) == 3, str(r))
    hf = ok(G, "select public.home_feed(null, 20, 5, 10)")[0][0]
    t9 = [t for t in hf["top"] if t["name"] == "Clinic Nine"]
    check("home feed has max_percent", t9 and float(t9[0]["max_percent"]) == 50 and float(t9[0]["discount_percent"]) == 0, str(t9))
    r = ok(G, "select name, max_percent from public.search_providers('clinic', null, 20, 0, 40, null)")
    check("discount filter uses best offer", [x[0] for x in r] == ["Clinic Nine"], str(r))
    check("schema 012", ok(G, "select public.schema_status()->>'m012'")[0][0] == "true")

    # ------------------------------------------------------------ 013: interests + Explore ads
    beauty = ok(A, "insert into public.categories (name, icon) values ('Beauty', '💅') returning id")[0][0]
    food = ok(A, "insert into public.categories (name, icon) values ('Food', '🍔') returning id")[0][0]
    pb = ok(A, "select public.admin_create_provider('beauty1', 'Passw0rd!', 'Glow Spa', 20, '')")[0][0]
    pf = ok(A, "select public.admin_create_provider('food1', 'Passw0rd!', 'Burger Hub', 10, '')")[0][0]
    ok(None, "update public.providers set category_id=%s where id=%s", (beauty, pb))
    ok(None, "update public.providers set category_id=%s where id=%s", (food, pf))
    # fresh members so earlier scans don't skew the numbers
    m1, _ = signup("201660000001", "Sara", "Beauty"); m2, _ = signup("201660000002", "Omar", "Food"); m3, _ = signup("201660000003", "No", "Scans")
    def put_scans(uid, pid, n, counted=True):
        for _ in range(n):
            ok(None, "insert into public.scans (provider_id, member_id, member_label, result, discount_percent, counted) values (%s, %s, 'x', 'active', 10, %s)", (pid, uid, counted))
    put_scans(m1, pb, 3); put_scans(m1, pf, 1); put_scans(m1, pb, 5, counted=False)   # 75% beauty (not-counted ignored)
    put_scans(m2, pb, 1); put_scans(m2, pf, 4)                                          # 20% beauty
    r = dict((n, (sc, float(pc))) for _, n, sc, _, pc in ok(A, "select * from public.admin_member_interests(%s)", (m1,)))
    check("member interest %", r == {"Beauty": (3, 75.0), "Food": (1, 25.0)}, str(r))
    for who in (G, c1, p1u):
        denied("non-admin interest report", who, "select public.admin_member_interests(%s)", (m1,))
        denied("non-admin interest summary", who, "select public.admin_interest_summary()")
        denied("non-admin interest ranking", who, "select public.admin_interest_members(%s)", (beauty,))
        denied("non-admin audience", who, "select public.admin_ad_audience(%s)", (beauty,))
    summ = ok(A, "select public.admin_interest_summary()")[0][0]
    b = [c for c in summ["categories"] if c["name"] == "Beauty"][0]
    check("summary: beauty scans + interested at 40%", b["scans"] == 4 and b["members"] == 2 and b["interested"] == 1 and float(summ["min_pct"]) == 40, str(b))
    rk = ok(A, "select first_name, pct from public.admin_interest_members(%s, 0)", (beauty,))
    check("ranking by interest", [x[0] for x in rk] == ["Sara", "Omar"], str(rk))
    check("audience at 40%", ok(A, "select public.admin_ad_audience(%s)", (beauty,))[0][0] == 1)
    check("audience at 15%", ok(A, "select public.admin_ad_audience(%s, 15)", (beauty,))[0][0] == 2)

    # ads (admin only)
    denied("non-admin cannot add ad", c1, "insert into public.explore_ads (advertiser, image_path, category_id) values ('x', 'explore/a.webp', %s)", (beauty,))
    check("non-admin cannot read ads table", ok(c1, "select count(*) from public.explore_ads")[0][0] == 0)
    denied("ad link must be https", A, "insert into public.explore_ads (advertiser, image_path, category_id, link_url) values ('x', 'explore/a.webp', %s, 'javascript:alert(1)')", (beauty,))
    ad_b = ok(A, "insert into public.explore_ads (advertiser, body, image_path, category_id, link_url, cta_label) values ('Nour <b>Beauty</b> Center', 'New laser offer', 'explore/b.webp', %s, 'https://nour.example.com/offer', 'Book now') returning id, advertiser", (beauty,))[0]
    check("ad advertiser sanitized", "<" not in ad_b[1], ad_b[1])
    ad_f = ok(A, "insert into public.explore_ads (advertiser, image_path, category_id, min_pct) values ('Pizza Place', 'explore/f.webp', %s, 50) returning id", (food,))[0][0]
    ad_all = ok(A, "insert into public.explore_ads (advertiser, image_path, category_id, show_to_all, sort_order) values ('Mall Sale', 'explore/m.webp', %s, true, 5) returning id", (food,))[0][0]
    ok(A, "insert into public.explore_ads (advertiser, image_path, category_id, ends_at) values ('Old', 'explore/o.webp', %s, now() - interval '1 day')", (beauty,))
    ok(A, "insert into public.explore_ads (advertiser, image_path, category_id, is_active) values ('Hidden', 'explore/h.webp', %s, false)", (beauty,))
    feed = lambda who: ok(who, "select public.explore_feed()")[0][0]
    check("explore off by default", feed(m1) == {"enabled": False, "items": []}, str(feed(m1)))
    check("track refused when off", ok(m1, "select public.explore_track(%s, 'view')", (ad_b[0],))[0][0] is False)
    ok(A, "update public.settings set data = data || '{\"app_enabled_modules\": [\"explore\"]}'")
    names = lambda who: [x["advertiser"] for x in feed(who)["items"]]
    check("beauty fan sees beauty ad first + broad ad", names(m1) == [ad_b[1], "Mall Sale"], str(names(m1)))
    check("food fan (80%) sees food ad (min 50%) + broad", names(m2) == ["Pizza Place", "Mall Sale"], str(names(m2)))
    check("no scans: only broad ads", names(m3) == ["Mall Sale"], str(names(m3)))
    check("guest: only broad ads", names(G) == ["Mall Sale"], str(names(G)))
    it = feed(m1)["items"][0]
    check("feed item fields", it["targeted"] and it["link_url"] == "https://nour.example.com/offer" and it["cta_label"] == "Book now" and it["category"] == "Beauty", str(it))
    ok(A, "update public.settings set data = data || '{\"explore_min_pct\": 80}'")
    check("admin threshold applies", names(m1) == ["Mall Sale"], str(names(m1)))
    ok(A, "update public.settings set data = data || '{\"explore_min_pct\": 40, \"explore_min_scans\": 5}'")
    check("min lifetime scans applies", names(m1) == ["Mall Sale"] and names(m2) == ["Pizza Place", "Mall Sale"], str((names(m1), names(m2))))
    ok(A, "update public.settings set data = data || '{\"explore_min_scans\": 1}'")
    # tracking
    check("track view", ok(m1, "select public.explore_track(%s, 'view')", (ad_b[0],))[0][0] is True)
    ok(m1, "select public.explore_track(%s, 'view')", (ad_b[0],))
    ok(m1, "select public.explore_track(%s, 'click')", (ad_b[0],))
    check("cannot track ad not shown to you", ok(m3, "select public.explore_track(%s, 'view')", (ad_b[0],))[0][0] is False)
    denied("guest cannot track", G, "select public.explore_track(%s, 'view')", (ad_b[0],))
    denied("events not readable", m1, "select count(*) from public.explore_events")
    st = {r[0]: r[1:] for r in ok(A, "select * from public.admin_explore_stats()")}
    check("stats: 1 daily view, 1 click, audience 1", st[ad_b[0]] == (1, 1, 1, 1), str(st[ad_b[0]]))
    denied("non-admin stats", c1, "select public.admin_explore_stats()")
    ok(A, "update public.settings set data = data || '{\"app_disabled_modules\": [\"explore\"]}'")
    check("disabled module hides feed", feed(m1)["enabled"] is False)
    ok(A, "update public.settings set data = data - 'app_disabled_modules'")
    t0 = time.time(); ok(m1, "select public.explore_feed()"); check("perf explore feed", time.time() - t0 < 1.0)
    check("schema 013", ok(G, "select public.schema_status()->>'m013'")[0][0] == "true")

    # ------------------------------------------------------------ performance (~20k rows)
    t = time.time()
    ok(None, """
      insert into auth.users (id, email, raw_user_meta_data)
      select gen_random_uuid(), 'u2010' || lpad(g::text, 8, '0') || '@xgoplus.online',
             jsonb_build_object('phone', '2010' || lpad(g::text, 8, '0'), 'first_name', 'User' || g, 'last_name', 'Test')
      from generate_series(1, 20000) g;
      insert into public.memberships (user_id, starts_at, expires_at, source)
      select id, now() - interval '30 days', now() + (random() * 400 - 25) * interval '1 day', 'free'
      from public.profiles where phone like '2010%' and length(phone) = 12 and id <> 'C1ID';
      insert into public.providers (username, name, discount_percent, sort_order)
      select 'prov' || g, 'Provider ' || g, 5 + (g % 40), g % 10 from generate_series(1, 20000) g;
      update public.providers p set category_id = (select (array_agg(id order by sort_order))[1 + abs(hashtext(p.id::text)) % 6] from public.categories where is_active),
        area_id = (select (array_agg(id order by sort_order))[1 + abs(hashtext(p.id::text || 'a')) % 1] from public.areas where is_active) where username like 'prov%';
      insert into public.scans (provider_id, member_id, result)
      select (select id from public.providers order by random() limit 1), null, 'invalid' from generate_series(1, 20000);
      insert into public.scans (provider_id, member_id, result, counted, discount_percent)
      select (select id from public.providers order by random() limit 1), (array(select id from public.profiles limit 500))[1 + g % 500], 'active', true, 10
      from generate_series(1, 20000) g;
      analyze;
    """.replace("C1ID", str(c1)))
    print(f"seeded 20k rows/table in {time.time()-t:.1f}s")

    def timed(name, who, sql, params=None, limit_ms=150):
        ok(who, sql, params)  # warm
        t0 = time.time()
        for _ in range(5):
            ok(who, sql, params)
        ms = (time.time() - t0) / 5 * 1000
        print(f"  {name}: {ms:.1f} ms")
        check(f"perf {name} < {limit_ms}ms", ms < limit_ms, f"{ms:.1f}ms")

    timed("guest provider page", G, "select id,name,image_path,discount_percent from public.providers where is_active order by sort_order, name, id limit 24 offset 4800")
    timed("guest provider search", G, "select id,name from public.providers where is_active and name ilike '%%der 1234%%' order by sort_order, name limit 24")
    timed("search typo (20k providers)", G, "select * from public.search_providers('provder 1234', null, 5, 0)")
    timed("search substring page 3", G, "select * from public.search_providers('provider', null, 20, 40)")
    timed("search short query", G, "select * from public.search_providers('pr', null, 5, 0)")
    timed("category filter page", G, "select id,name from public.providers where is_active and category_id = (select id from public.categories order by sort_order limit 1) order by sort_order, name, id limit 24")
    timed("customer history", c1, "select * from public.my_scan_history(20, 0)")
    timed("admin complaints", A, "select * from public.admin_list_complaints(null, 30, 0)")
    timed("search with min discount", G, "select * from public.search_providers('provider', null, 20, 0, 30)")
    timed("search in area", G, "select * from public.search_providers('provider', null, 20, 0, null, (select id from public.areas limit 1))")
    timed("top deals in area", G, "select id,name,discount_percent from public.providers where is_active and area_id=(select id from public.areas limit 1) order by discount_percent desc limit 12")
    timed("admin pending requests", A, "select * from public.admin_list_requests('pending', 30, 0)")
    timed("payment options", G, "select public.payment_options()")
    timed("is_admin check", A, "select public.is_admin()")
    timed("home feed (20k providers)", G, "select public.home_feed(null, 10, 5, 10)", limit_ms=250)
    timed("home feed in area", G, "select public.home_feed((select id from public.areas limit 1), 10, 5, 10)", limit_ms=250)
    timed("search in area (branches)", G, "select * from public.search_providers('provider', null, 20, 0, null, (select id from public.areas limit 1))")
    timed("offers in area (area_ids)", G, "select id,name from public.providers where is_active and area_ids @> array[(select id from public.areas limit 1)] order by sort_order, name, id limit 24 offset 240")
    timed("customer context", c1, "select public.get_my_context()")
    timed("customer QR", c1, "select public.get_member_qr()")
    timed("provider scan", p1u, "select public.verify_member_qr(%s)", (ok(c1, "select public.get_member_qr()->>'token'")[0][0],))
    timed("provider own scans", p1u, "select id, result, created_at from public.scans order by created_at desc limit 50")
    timed("admin members page", A, "select * from public.admin_list_members('', 50, 5000)", limit_ms=400)
    timed("admin member search", A, "select * from public.admin_list_members('01000012', 50, 0)", limit_ms=400)
    timed("admin providers page", A, "select * from public.admin_list_providers('', 50, 1000)", limit_ms=300)
    timed("admin scans page", A, "select * from public.admin_list_scans(null, 50, 0)")
    timed("admin stats", A, "select public.admin_stats()", limit_ms=300)

    print(f"\n{passed} passed, {len(failed)} failed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
