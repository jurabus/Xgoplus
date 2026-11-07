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


def run(who, sql, params=None, fetch=True):
    """Execute as a given identity. who = None (superuser), 'anon', or a user uuid.
    Returns (rows, error_message)."""
    try:
        with conn.transaction():
            with conn.cursor() as cur:
                if who == "anon":
                    cur.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"role": "anon"}),))
                    cur.execute("set local role anon")
                elif who is not None:
                    cur.execute("select set_config('request.jwt.claims', %s, true)",
                                (json.dumps({"sub": str(who), "role": "authenticated"}),))
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
    ok(p1u, "update public.providers set name='Cafe 1', discount_percent=20, notes='Valid Fri\nonly' where id=%s", (p1,))
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
    old_sig = ok(None, "select private.sign_qr(%s)", (old_payload,))[0][0]
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
    denied("admin bad discount", A, "select public.admin_create_provider('newp2','Passw0rd!','X',0,'')")
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
      update public.providers p set category_id = (select (array_agg(id order by sort_order))[1 + abs(hashtext(p.id::text)) % 6] from public.categories where is_active) where username like 'prov%';
      insert into public.scans (provider_id, member_id, result)
      select (select id from public.providers order by random() limit 1), null, 'invalid' from generate_series(1, 20000);
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
