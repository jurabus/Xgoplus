"""End-to-end UI test: real browser (Chromium, iPhone-sized) against a local
Supabase stand-in (real GoTrue + PostgREST + our migrations, storage stand-in).

The provider scan is tested for real: the customer's on-screen QR is captured,
turned into a fake camera feed, and decoded by the partner page's scanner.

usage: tests/e2e/start.sh && python3 -I tests/e2e/test_ui.py
"""
import io
import os
import subprocess
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.environ.get("SHOTS", "/home/claude/e2e/shots")
SUPA = "https://ipcodsedkvxldqyxpnhx.supabase.co"
SITE = "http://localhost:8080"
os.makedirs(SHOTS, exist_ok=True)
errors = []


def sql(q):
    return subprocess.run(["psql", "-h", "/tmp", "-p", "5433", "-U", "postgres", "-d", "xg_e2e", "-tAqc", q],
                          capture_output=True, text=True, check=True).stdout.strip()


def serve():
    class Q(SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    ThreadingHTTPServer(("127.0.0.1", 8080), partial(Q, directory=ROOT)).serve_forever()


def totp(secret, offset=0):
    import base64, hashlib, hmac as _h
    key = base64.b32decode(secret.upper() + "=" * ((8 - len(secret) % 8) % 8))
    ctr = int(time.time() // 30) + offset
    dg = _h.new(key, ctr.to_bytes(8, "big"), hashlib.sha1).digest()
    o = dg[-1] & 15
    return f"{(int.from_bytes(dg[o:o + 4], 'big') & 0x7fffffff) % 1000000:06d}"


def noisy_png(path, w=2400, h=1800):
    import random
    im = Image.effect_noise((w, h), 90).convert("RGB")
    d = ImageDraw.Draw(im)
    for _ in range(60):
        x, y = random.randint(0, w), random.randint(0, h)
        d.ellipse((x, y, x + 300, y + 300), fill=(random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)))
    im.save(path)
    return path


def png(path, color, text):
    im = Image.new("RGB", (1200, 900), color)
    d = ImageDraw.Draw(im)
    d.ellipse((350, 200, 850, 700), fill=(255, 255, 255))
    d.text((560, 430), text, fill=color)
    im.save(path)
    return path


def wire(ctx, name):
    def handle(route):
        url = route.request.url.replace(SUPA, "http://127.0.0.1:54321")
        try:
            resp = route.fetch(url=url)
            route.fulfill(response=resp)
        except Exception as e:  # browser closed mid-request
            try:
                route.abort()
            except Exception:
                pass
    ctx.route(f"{SUPA}/**", handle)

    def on_page(page):
        page.on("console", lambda m: m.type in ("error",) and errors.append(f"[{name}] {m.text}"))
        page.on("pageerror", lambda e: errors.append(f"[{name}] pageerror {e}"))
    ctx.on("page", on_page)


def shot(page, name, full=True):
    page.wait_for_timeout(350)
    page.screenshot(path=f"{SHOTS}/{name}.png", full_page=full)


IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
AND_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"


def phone_ctx(browser, name, install_popup=False, android=False, **kw):
    vp = {"width": 412, "height": 915} if android else {"width": 390, "height": 844}
    if android:
        kw.setdefault("user_agent", AND_UA)
    ctx = browser.new_context(viewport=vp, device_scale_factor=2, is_mobile=True,
                              has_touch=True, locale="en-US", **kw)
    if not install_popup:  # keep the install popup out of functional tests
        ctx.add_init_script("try { localStorage.setItem('xg-install-dismissed', String(Date.now() + 864e5)); } catch (e) {}")
    wire(ctx, name)
    return ctx


def main():
    threading.Thread(target=serve, daemon=True).start()
    imgs = "/home/claude/e2e/imgs"
    os.makedirs(imgs, exist_ok=True)
    cafe_img = png(f"{imgs}/cafe.png", (120, 60, 30), "CAFE")
    gym_img = png(f"{imgs}/gym.png", (20, 120, 90), "GYM")
    banner_img = png(f"{imgs}/banner.png", (91, 43, 224), "BANNER")

    with sync_playwright() as pw:
        browser = pw.chromium.launch()

        # ---------------- admin bootstrap (dashboard: Auth > add user, then SQL) ----------------
        a = phone_ctx(browser, "admin").new_page()
        a.goto(f"{SITE}/admin.html")
        expect(a.locator("h1")).to_have_text("Admin")
        shot(a, "01-admin-login")
        a.evaluate("""async () => { const m = await import('/js/common.js');
            await m.sb.auth.signUp({ email: 'owner@gmail.com', password: 'AdminPass123' }); await m.sb.auth.signOut(); }""")
        sql("insert into public.admins select id from auth.users where email='owner@gmail.com' on conflict do nothing")
        a.reload()
        a.fill("input[type=email]", "owner@gmail.com")
        a.fill("input[type=password]", "wrong-password")
        a.click("main button[type=submit]")
        expect(a.locator(".form-error")).to_contain_text("Wrong email or password")
        a.fill("input[type=password]", "AdminPass123")
        a.click("main button[type=submit]")
        # first login: set up 2FA (authenticator app)
        expect(a.locator("h1")).to_have_text("Two-step verification")
        a.wait_for_selector("#mfa-secret")
        shot(a, "02a-admin-2fa-setup")
        secret = a.locator("#mfa-secret").inner_text().strip()
        a.fill("input.otp", "000000" if totp(secret) != "000000" else "111111")
        a.click("main button[type=submit]")
        expect(a.locator(".form-error")).to_contain_text("Wrong or expired code")
        a.fill("input.otp", totp(secret))
        a.click("main button[type=submit]")
        expect(a.locator("h1")).to_have_text("Dashboard")
        shot(a, "02-admin-dashboard")
        assert sql("select count(*) from auth.mfa_factors where status='verified'") == "1"
        # second device / new session: password + code (no setup screen)
        a2 = phone_ctx(browser, "admin2").new_page()
        a2.goto(SITE + "/admin.html")
        a2.fill("input[type=email]", "owner@gmail.com"); a2.fill("input[type=password]", "AdminPass123")
        a2.click("main button[type=submit]")
        expect(a2.locator("h1")).to_have_text("Two-step verification")
        expect(a2.locator("#mfa-secret")).to_have_count(0)
        a2.fill("input.otp", totp(secret, 1)); a2.click("main button[type=submit]")
        expect(a2.locator("h1")).to_have_text("Dashboard")
        # password alone is not enough: an aal1 session gets no admin data
        a3 = phone_ctx(browser, "admin-aal1").new_page()
        a3.goto(SITE + "/index.html")
        r = a3.evaluate("""async () => { const m = await import('/js/common.js');
            await m.sb.auth.signInWithPassword({ email: 'owner@gmail.com', password: 'AdminPass123' });
            const s = await m.sb.rpc('admin_stats'); const ctx = await m.sb.rpc('get_my_context'); return [s.data, ctx.data.role]; }""")
        assert r == [None, "none"], r
        # brute force from another IP -> that IP is banned from admin
        atk = phone_ctx(browser, "attacker", extra_http_headers={"X-Test-Client-IP": "203.0.113.50"}).new_page()
        atk.goto(SITE + "/admin.html")
        for i in range(10):
            if atk.locator("text=Access denied").count():
                break
            atk.fill("input[type=email]", "owner@gmail.com"); atk.fill("input[type=password]", f"guess-{i}")
            atk.click("main button[type=submit]")
            atk.wait_for_timeout(300)
            atk.wait_for_function("!document.querySelector('main button[type=submit]') || !document.querySelector('main button[type=submit]').disabled")
        expect(atk.locator("h1")).to_have_text("Access denied")
        shot(atk, "02b-admin-banned", full=False)
        atk.goto(SITE + "/admin.html"); expect(atk.locator("h1")).to_have_text("Access denied")
        # even the right password + code from the banned IP gets nothing
        r = atk.evaluate("""async () => { const m = await import('/js/common.js');
            await m.sb.auth.signInWithPassword({ email: 'owner@gmail.com', password: 'AdminPass123' }); return (await m.sb.rpc('is_admin')).data; }""")
        assert r is False, r
        a.goto(SITE + "/admin.html#security")
        expect(a.locator(".list").first).to_contain_text("203.0.113.50")
        shot(a, "02c-admin-security")
        a.goto(SITE + "/admin.html")
        expect(a.locator("h1")).to_have_text("Dashboard")

        # providers
        a.click("text=Providers")
        expect(a.locator("h1")).to_have_text("Providers")
        a.click("text=+ Add")
        a.fill(".sheet input >> nth=0", "cafe_one")
        a.locator(".sheet input").nth(1).fill("CafePass123")
        a.locator(".sheet input").nth(2).fill("Cafe Aroma")
        a.locator(".sheet input").nth(3).fill("15")
        a.locator(".sheet textarea").fill("Offer only valid on Fridays\nDine-in only")
        a.set_input_files(".sheet input[type=file]", noisy_png("/home/claude/e2e/imgs/big.png"))
        shot(a, "03-admin-provider-new", full=False)
        a.click(".sheet button[type=submit]")
        expect(a.locator(".list")).to_contain_text("Cafe Aroma")
        a.wait_for_timeout(800)
        size = a.evaluate("""async () => { const m = await import('/js/common.js');
            const { data } = await m.sb.from('providers').select('image_path').eq('name', 'Cafe Aroma').single();
            const r = await fetch(m.mediaUrl(data.image_path)); const b = await r.blob(); return [b.size, b.type, data.image_path]; }""")
        print("compressed upload:", size, "original:", os.path.getsize("/home/claude/e2e/imgs/big.png"))
        assert size[0] < 170 * 1024 and size[1] == "image/webp" and size[2].endswith(".webp"), size
        a.click("text=+ Add")
        a.fill(".sheet input >> nth=0", "Bad Name")
        a.locator(".sheet input").nth(2).fill("X")
        a.locator(".sheet input").nth(3).fill("10")
        a.click(".sheet button[type=submit]")
        expect(a.locator(".sheet .form-error")).to_contain_text("Username")
        a.fill(".sheet input >> nth=0", "power_gym")
        a.locator(".sheet input").nth(2).fill("Power Gym")
        a.locator(".sheet input").nth(3).fill("25")
        a.set_input_files(".sheet input[type=file]", gym_img)
        a.click(".sheet button[type=submit]")
        expect(a.locator(".list")).to_contain_text("Power Gym")
        shot(a, "04-admin-providers")
        a.click("text=Power Gym")
        shot(a, "05-admin-provider-edit", full=False)
        a.click(".sheet >> text=Close")

        # extra providers for pagination (fast path through SQL)
        sql("""insert into public.providers (username, name, discount_percent, sort_order)
               select 'shop' || g, 'Shop ' || lpad(g::text, 2, '0'), 5 + g % 30, 5 from generate_series(1, 40) g""")

        # banner
        a.click("text=Banners")
        a.click("text=+ Add")
        a.set_input_files(".sheet input[type=file]", banner_img)
        a.wait_for_selector(".sheet img.preview")
        a.locator(".sheet input").nth(1).fill("Welcome to XGo Plus")
        a.locator(".sheet input").nth(2).fill("Save at every partner with one card")
        a.click(".sheet button[type=submit]")
        expect(a.locator(".list")).to_contain_text("Welcome to XGo Plus")
        shot(a, "06-admin-banners")

        # texts
        a.click("text=Texts & settings")
        a.wait_for_selector("text=Save all texts")
        a.fill("input[placeholder='Exclusive discounts for members']", "Members save more, everywhere")
        shot(a, "07a-admin-texts-full")
        a.click("text=Save all texts")
        a.wait_for_selector(".toast")
        shot(a, "07-admin-texts", full=False)

        # categories: add one, reorder, assign providers
        a.click(".admin-tabs >> text=Categories")
        expect(a.locator("h1")).to_have_text("Categories")
        expect(a.locator(".list .item")).to_have_count(6)
        a.click("text=+ Add")
        a.locator(".sheet input").nth(0).fill("Bakeries")
        a.locator(".sheet input").nth(1).fill("🥐")
        a.click(".sheet button[type=submit]")
        expect(a.locator(".list")).to_contain_text("Bakeries")
        a.locator(".list .item").nth(6).locator("button[aria-label='Move up']").click()
        a.wait_for_timeout(800)
        expect(a.locator(".list .item").nth(5)).to_contain_text("Bakeries")
        shot(a, "08-admin-categories")
        a.locator(".list .item").nth(0).locator(".btn-reset").click()
        shot(a, "08b-admin-category-edit", full=False)
        a.click(".sheet >> text=Close")
        a.click(".admin-tabs >> text=Providers")
        a.wait_for_selector("text=Cafe Aroma")
        for pname, cname in (("Cafe Aroma", "Cafés"), ("Power Gym", "Gyms")):
            a.click(f".list >> text={pname}")
            a.wait_for_selector(".sheet .limits"); sel = a.locator(".sheet select").first
            sel.select_option(label=[o for o in sel.locator("option").all_inner_texts() if cname in o][0])
            a.click(".sheet button[type=submit]")
            expect(a.locator(".list")).to_contain_text(f"{pname}")
            a.wait_for_timeout(500)
        expect(a.locator(".list")).to_contain_text("Gyms")
        shot(a, "09-admin-providers-with-categories")
        # areas: add one, assign Cafe Aroma to Sheikh Zayed
        a.click(".admin-tabs >> text=Areas")
        expect(a.locator("h1")).to_have_text("Areas")
        expect(a.locator(".list .item")).to_have_count(2)
        a.click("text=+ Add")
        a.locator(".sheet input").nth(0).fill("New Cairo")
        a.click(".sheet button[type=submit]")
        expect(a.locator(".list")).to_contain_text("New Cairo")
        shot(a, "09b-admin-areas")
        a.click(".admin-tabs >> text=Providers")
        a.click(".list >> text=Cafe Aroma")
        a.wait_for_selector(".sheet .limits")
        a.locator(".sheet select").nth(1).select_option(label="Sheikh Zayed")
        shot(a, "09c-admin-provider-area", full=False)
        a.click(".sheet button[type=submit]")
        a.wait_for_selector(".toast")
        assert sql("select a.name from public.providers p join public.areas a on a.id=p.area_id where p.username='cafe_one'") == "Sheikh Zayed"
        # category icon picker
        a.click(".admin-tabs >> text=Categories")
        a.locator(".list .item").nth(0).locator(".btn-reset").click()
        a.wait_for_selector(".iconpick")
        shot(a, "09d-admin-category-iconpick", full=False)
        a.click(".sheet >> text=Close")

        # ---------------- guest ----------------
        g = phone_ctx(browser, "guest").new_page()
        g.goto(SITE + "/")
        g.wait_for_selector(".deals .dcard")
        expect(g.locator(".hero-title")).to_contain_text("More Savings.")
        expect(g.locator(".catbar .cat")).to_have_count(7)
        offs = [float(t.split("%")[0]) for t in g.locator(".deals .dcard .off").all_text_contents()]
        assert offs == sorted(offs, reverse=True) and len(offs) == 12, offs
        shot(g, "10-guest-home", full=False)
        shot(g, "10b-guest-home-full")
        g.click(".catbar .cat >> nth=0")
        g.wait_for_url("**/offers.html?cat=*")
        expect(g.locator(".chip.active")).to_contain_text("Cafés")
        g.goto(SITE + "/offers.html")
        g.wait_for_selector(".dcard")
        expect(g.locator("main p.muted").first).to_have_text("Members save more, everywhere")
        n1 = g.locator(".dcard").count()
        g.mouse.wheel(0, 9000); g.wait_for_timeout(900); g.mouse.wheel(0, 9000); g.wait_for_timeout(900)
        n2 = g.locator(".dcard").count()
        assert n1 == 24 and n2 == 42, (n1, n2)
        shot(g, "11-guest-offers", full=False)
        # category chips
        g.mouse.wheel(0, -20000); g.wait_for_timeout(300)
        g.click(".chip:has-text('Gyms')")
        g.wait_for_timeout(800)
        assert "Power Gym" in g.locator(".dcard").all_text_contents()[0] and g.locator(".dcard").count() == 1
        shot(g, "11b-guest-category-gyms", full=False)
        g.click(".chip:has-text('Clinics')"); g.wait_for_timeout(700)
        expect(g.locator(".empty")).to_contain_text("No partners in this category")
        g.click(".chip:has-text('All')"); g.wait_for_timeout(700)
        assert g.locator(".dcard").count() == 24
        # header search: typo -> suggestion
        g.goto(SITE + "/")
        g.fill(".hsearch input", "aroam")
        g.wait_for_selector(".sug")
        expect(g.locator(".sug").first).to_contain_text("Cafe Aroma")
        shot(g, "11c-search-typo", full=False)
        g.fill(".hsearch input", "shpo")
        g.wait_for_timeout(900)
        assert g.locator(".sug").count() == 5, g.locator(".sug").count()
        expect(g.locator(".sug-all")).to_be_visible()
        shot(g, "11d-search-5-suggestions", full=False)
        g.click(".sug-all")
        g.wait_for_url("**/search.html?q=shpo")
        g.wait_for_selector(".dcard")
        assert g.locator(".dcard").count() == 20, g.locator(".dcard").count()
        shot(g, "11e-search-results", full=False)
        g.mouse.wheel(0, 8000); g.wait_for_timeout(1000); g.mouse.wheel(0, 8000); g.wait_for_timeout(1000)
        assert g.locator(".dcard").count() == 40, g.locator(".dcard").count()
        g.goto(SITE + "/search.html?q=zzqqxx")
        expect(g.locator(".empty")).to_contain_text("No partners match")
        shot(g, "11f-search-empty", full=False)
        g.goto(SITE + "/")
        g.fill(".hsearch input", "Cafe Aroma")
        g.wait_for_selector(".sug")
        g.click(".sug >> nth=0")
        expect(g.locator("h1")).to_have_text("Cafe Aroma")
        expect(g.locator(".notes")).to_contain_text("Fridays")
        shot(g, "12-guest-provider")
        expect(g.locator(".p-area")).to_contain_text("Sheikh Zayed")
        # customer area picker -> top deals only from that area
        g.goto(SITE + "/")
        g.click(".site-head .area-pill")
        shot(g, "12b-area-picker", full=False)
        g.click(".area-opt:has-text('Sheikh Zayed')")
        g.wait_for_selector(".deals .dcard, main .empty")
        g.wait_for_timeout(600)
        names = g.locator(".deals .dcard .name").all_text_contents()
        assert names == ["Cafe Aroma"], names
        expect(g.locator(".site-head .area-pill")).to_contain_text("Sheikh Zayed")
        shot(g, "12c-home-area-zayed", full=False)
        g.goto(SITE + "/offers.html"); g.wait_for_selector(".dcard")
        assert g.locator(".dcard").count() == 1
        g.fill(".site-head .hsearch input", "gym"); g.wait_for_timeout(900)
        expect(g.locator(".search-empty")).to_be_visible()
        g.click(".site-head .area-pill"); g.click(".area-opt:has-text('All areas')")
        g.wait_for_selector(".dcard"); g.wait_for_timeout(500)
        assert g.locator(".dcard").count() == 24
        g.goto(SITE + "/provider.html?id=00000000-0000-0000-0000-000000000000")
        expect(g.locator(".empty")).to_contain_text("not available")
        g.goto(SITE + "/membership.html")
        shot(g, "13-guest-membership")

        # ---------------- install popup ----------------
        ios = phone_ctx(browser, "ios", install_popup=True, user_agent=IOS_UA).new_page()
        ios.goto(SITE + "/"); ios.wait_for_selector(".install", timeout=8000)
        expect(ios.locator(".install")).to_contain_text("Add to Home Screen")
        shot(ios, "15-install-ios", full=False)
        ios.click(".install >> text=Not now")
        expect(ios.locator(".install")).to_have_count(0)
        ios.reload(); ios.wait_for_timeout(3500)
        expect(ios.locator(".install")).to_have_count(0)
        st_ctx = phone_ctx(browser, "ios-standalone", install_popup=True, user_agent=IOS_UA)
        st_ctx.add_init_script("Object.defineProperty(navigator, 'standalone', { get: () => true });")
        st = st_ctx.new_page(); st.goto(SITE + "/"); st.wait_for_timeout(3500)
        expect(st.locator(".install")).to_have_count(0)
        pwa = phone_ctx(browser, "android-pwa", install_popup=True, android=True).new_page()
        pwa.goto(SITE + "/index.html?source=pwa"); pwa.wait_for_timeout(3500)
        expect(pwa.locator(".install")).to_have_count(0)
        andp = phone_ctx(browser, "android", install_popup=True, android=True).new_page()
        andp.goto(SITE + "/"); andp.wait_for_selector(".install", timeout=8000)
        expect(andp.locator(".install")).to_contain_text("Install app")
        shot(andp, "16-install-android", full=False)
        # manifest is valid + icons exist
        man = andp.evaluate("fetch('/manifest.webmanifest').then(r => r.json())")
        assert man["display"] == "standalone" and len(man["icons"]) == 3
        for ic in man["icons"]:
            assert andp.evaluate(f"fetch('{ic['src']}').then(r => r.status)") == 200

        # ---------------- customer ----------------
        c = phone_ctx(browser, "customer").new_page()
        c.goto(SITE + "/signup.html")
        shot(c, "20-signup")
        c.fill("input[autocomplete=given-name]", "Ahmed")
        c.fill("input[autocomplete=family-name]", "Mostafa")
        c.fill("input[type=tel]", "0100 111 2222")
        c.fill("input[type=password]", "short")
        c.click("main button[type=submit]")
        expect(c.locator(".form-error")).to_contain_text("8 characters")
        c.fill("input[type=password]", "MyPass1234")
        c.click("main button[type=submit]")
        c.wait_for_url("**/membership.html")
        expect(c.locator(".mcard")).to_contain_text("FREE")
        shot(c, "21-customer-membership-offer")
        c.click("text=Subscribe now")
        c.wait_for_selector(".qrbox canvas")
        expect(c.locator(".mcard .badge")).to_have_text("Active")
        c.wait_for_timeout(500)
        shot(c, "22-customer-qr")
        qr_png = c.locator(".qrbox canvas").screenshot()
        c.goto(SITE + "/account.html")
        expect(c.locator("input[disabled]")).to_have_value("01001112222")
        shot(c, "23-customer-account")
        # same phone can't sign up twice
        c2 = phone_ctx(browser, "customer2").new_page()
        c2.goto(SITE + "/signup.html")
        c2.fill("input[autocomplete=given-name]", "Fake"); c2.fill("input[autocomplete=family-name]", "Dup")
        c2.fill("input[type=tel]", "01001112222"); c2.fill("input[type=password]", "Another123")
        c2.click("main button[type=submit]")
        expect(c2.locator(".form-error")).not_to_be_empty()
        c2.goto(SITE + "/login.html")
        c2.fill("input[type=tel]", "01001112222"); c2.fill("input[type=password]", "wrongpass1")
        c2.click("main button[type=submit]")
        expect(c2.locator(".form-error")).to_contain_text("Wrong phone")
        shot(c2, "24-login-error")

        # ---------------- provider scans with a fake camera showing the QR ----------------
        def scan_with(qr_bytes, label, android=False):
            im = Image.open(io.BytesIO(qr_bytes)).convert("RGB")
            canvas = Image.new("RGB", (640, 480), (40, 40, 40))
            im = im.resize((360, 360))
            canvas.paste(im, (140, 60))
            src = f"/home/claude/e2e/{label}.png"; vid = f"/home/claude/e2e/{label}.y4m"
            canvas.save(src)
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-i", src, "-t", "3", "-pix_fmt", "yuv420p", vid], check=True)
            b2 = pw.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                                          f"--use-file-for-fake-video-capture={vid}"])
            ctx = phone_ctx(b2, "provider-android" if android else "provider", android=android, permissions=["camera"])
            p = ctx.new_page()
            p.goto(SITE + "/partner.html")
            p.wait_for_selector("main h1")
            if p.locator("text=Partner login").count():
                p.fill("input[autocomplete=username]", "cafe_one")
                p.fill("input[type=password]", "CafePass123")
                p.click("main button[type=submit]")
            try:
                p.wait_for_selector(".result", timeout=20000)
            except Exception:
                p.screenshot(path=f"{SHOTS}/FAIL-{label}.png")
                print("SCAN FAIL", label, p.evaluate("document.querySelector('main').innerText.slice(0,300)"),
                      p.evaluate("document.querySelector('.scanner')?.dataset.decoder"))
                raise
            return b2, p

        b2, p = scan_with(qr_png, "qr-active")
        expect(p.locator(".result")).to_contain_text("Membership active")
        expect(p.locator(".result .big")).to_have_text("15%")
        expect(p.locator(".site-head .area-pill")).to_contain_text("Sheikh Zayed")
        expect(p.locator(".result")).to_contain_text("Ahmed M.")
        shot(p, "30-provider-scan-active")
        p.click("text=Scan next")
        p.wait_for_selector(".scanner video")
        p.wait_for_selector(".result", timeout=20000)
        p.goto(SITE + "/partner.html#history")
        p.wait_for_selector(".list .item")
        shot(p, "31-provider-history")
        p.goto(SITE + "/partner.html#profile")
        p.wait_for_selector("h1:has-text(\"My business\")")
        p.fill("input[type=number]", "20")
        p.locator(".limits input[type=checkbox]").check()
        p.locator(".limits select").select_option("month")
        expect(p.locator(".limits .notes")).to_contain_text("1 use per month per member")
        p.click("main button[type=submit]")
        p.wait_for_selector(".toast")
        shot(p, "32-provider-profile")
        assert sql("select limit_count || limit_period from public.providers where username='cafe_one'") == "1month"
        p.wait_for_timeout(3200)
        p.set_input_files("input[type=file]", gym_img)
        p.wait_for_selector(".toast")
        p.wait_for_timeout(1200)
        assert sql("select discount_percent from public.providers where username='cafe_one'") == "20.00"
        assert sql("select image_path like 'providers/%' from public.providers where username='cafe_one'") == "t"
        b2.close()

        # ---------------- limits: 2nd visit this month is refused ----------------
        sql("update public.scans set created_at = created_at - interval '20 minutes'")
        c.goto(SITE + "/membership.html"); c.wait_for_selector(".qrbox canvas"); c.wait_for_timeout(400)
        b4, p4 = scan_with(c.locator(".qrbox canvas").screenshot(), "qr-limit", android=True)
        expect(p4.locator(".result")).to_contain_text("Usage limit reached")
        expect(p4.locator(".result")).to_contain_text("1 use per month")
        shot(p4, "34-provider-scan-limit")
        b4.close()
        cafe_id = sql("select id from public.providers where username='cafe_one'")
        c.goto(SITE + f"/provider.html?id={cafe_id}")
        expect(c.locator(".rules")).to_contain_text("1 use per month per member")
        expect(c.locator(".badge.usage")).to_contain_text("used this offer")
        shot(c, "35-customer-provider-rules")
        # history
        c.goto(SITE + "/history.html")
        c.wait_for_selector(".list .item")
        expect(c.locator(".list")).to_contain_text("Usage limit reached")
        expect(c.locator(".list")).to_contain_text("Discount applied")
        shot(c, "36-customer-history")
        # discount filter
        g.goto(SITE + "/offers.html")
        g.wait_for_selector(".dcard")
        g.select_option(".discount-sel", "20")
        g.wait_for_timeout(900)
        offs = [float(t.split("%")[0]) for t in g.locator(".dcard .off").all_text_contents()]
        assert offs and min(offs) >= 20, offs
        shot(g, "14-guest-discount-filter", full=False)
        # report a partner
        c.goto(SITE + "/report.html")
        c.wait_for_selector(".list .item")
        shot(c, "37-report-pick")
        c.fill("main input[type=search]", "aroma")
        c.wait_for_timeout(800)
        assert c.locator(".list .item").count() == 1
        c.click(".list .item")
        c.locator(".radio").nth(1).click()
        c.fill(".sheet textarea", "They gave me 10% instead of 20%")
        shot(c, "38-report-form", full=False)
        c.click(".sheet button[type=submit]")
        c.wait_for_url("**/report.html#mine")
        expect(c.locator("main .card")).to_contain_text("lower discount")
        expect(c.locator("main .badge")).to_have_text("Open")
        # password change
        c.goto(SITE + "/account.html")
        pw_form = c.locator("form:has-text('Current password')")
        pw_form.locator("input[autocomplete=current-password]").fill("wrong-one-1")
        pw_form.locator("input[autocomplete=new-password]").fill("NewPass5678")
        pw_form.locator("button[type=submit]").click()
        expect(pw_form.locator(".form-error")).to_contain_text("Current password is wrong")
        pw_form.locator("input[autocomplete=current-password]").fill("MyPass1234")
        pw_form.locator("button[type=submit]").click()
        expect(c.locator(".toast")).to_contain_text("Password changed")
        shot(c, "39-customer-account-password")
        c.click("text=Log out")
        c.wait_for_url("**/index.html")
        c.goto(SITE + "/login.html")
        c.fill("input[type=tel]", "01001112222"); c.fill("input[type=password]", "NewPass5678")
        c.click("main button[type=submit]")
        c.wait_for_url("**/membership.html")
        # admin handles the report
        a.goto(SITE + "/admin.html#complaints")
        a.wait_for_selector(".list .item")
        shot(a, "47-admin-reports")
        a.click(".list .item")
        a.locator(".sheet select").select_option("resolved")
        a.fill(".sheet textarea", "We contacted the partner. Sorry about that!")
        shot(a, "48-admin-report-detail", full=False)
        a.click(".sheet button[type=submit]")
        a.wait_for_selector(".toast")
        c.goto(SITE + "/report.html#mine")
        expect(c.locator("main .badge")).to_have_text("Resolved")
        expect(c.locator("main .notes")).to_contain_text("contacted the partner")
        shot(c, "49-customer-report-resolved")
        a.goto(SITE + "/admin.html#providers")
        a.wait_for_selector("text=Cafe Aroma")
        a.click(".list >> text=Cafe Aroma")
        a.wait_for_selector(".sheet .limits")
        expect(a.locator(".sheet .limits .notes")).to_contain_text("1 use per month")
        shot(a, "49b-admin-provider-limits")
        a.click(".sheet >> text=Close")

        # wrong login for partner
        pp = phone_ctx(browser, "provider-bad").new_page()
        pp.goto(SITE + "/partner.html")
        shot(pp, "33-partner-login")
        pp.fill("input[autocomplete=username]", "cafe_one"); pp.fill("input[type=password]", "nope-nope")
        pp.click("main button[type=submit]")
        expect(pp.locator(".form-error")).to_contain_text("Wrong username")

        # ---------------- phone camera app opens the QR link -> auto verify ----------------
        tok = c.evaluate("""async () => { const m = await import('/js/common.js'); return (await m.sb.rpc('get_member_qr')).data.token; }""")
        bq = pw.chromium.launch()
        pv = phone_ctx(bq, "provider-native").new_page()
        pv.goto(SITE + "/partner.html"); pv.wait_for_selector("main h1")
        pv.fill("input[autocomplete=username]", "cafe_one"); pv.fill("input[type=password]", "CafePass123")
        pv.click("main button[type=submit]"); pv.wait_for_selector(".scanner, .scanner.err, .result", timeout=15000)
        pv.goto(SITE + f"/v.html#{tok}")
        pv.wait_for_selector(".result", timeout=15000)
        assert "#" not in pv.url.split("partner.html")[-1] or "XG1" not in pv.url, pv.url
        expect(pv.locator(".result")).to_contain_text("Ahmed M.")
        shot(pv, "33b-native-camera-verify", full=False)
        bq.close()
        # a customer opening someone's QR link sees no member info
        c.goto(SITE + f"/v.html#{tok}")
        expect(c.locator("main")).to_contain_text("Only partner businesses can check it")
        # partner who isn't logged in: login first, then the code is checked automatically
        bq = pw.chromium.launch()
        pv = phone_ctx(bq, "provider-native2").new_page()
        tok2 = c.evaluate("""async () => { const m = await import('/js/common.js'); return (await m.sb.rpc('get_member_qr')).data.token; }""")
        pv.goto(SITE + f"/v.html#{tok2}")
        pv.wait_for_selector("text=Partner login")
        pv.fill("input[autocomplete=username]", "cafe_one"); pv.fill("input[type=password]", "CafePass123")
        pv.click("main button[type=submit]")
        pv.wait_for_selector(".result", timeout=15000)
        expect(pv.locator(".result")).to_contain_text("Ahmed M.")
        bq.close()

        # ---------------- paid membership: InstaPay / Vodafone Cash ----------------
        a.goto(SITE + "/admin.html#payments")
        a.wait_for_selector("text=Membership sign-up")
        a.check("input[value=active]")
        a.locator("form:has-text('Membership sign-up') input[type=number]").nth(1).fill("2")
        a.click("form:has-text('Membership sign-up') button[type=submit]")
        a.wait_for_selector(".toast")
        for meth, vals in (("InstaPay", ["xgo.one@instapay", "xgo.two@instapay"]), ("Vodafone Cash", ["01001234567"])):
            for v in vals:
                a.locator(f".row:has(.pm-tag:text-is('{meth}')) >> text=+ Add").click()
                a.locator(".sheet input").first.fill(v)
                a.click(".sheet button[type=submit]")
                a.wait_for_selector(f".list >> text={v}")
        shot(a, "60-admin-payments-settings")
        payer = phone_ctx(browser, "payer").new_page()
        payer.goto(SITE + "/signup.html")
        payer.fill("input[autocomplete=given-name]", "Sara"); payer.fill("input[autocomplete=family-name]", "Adel")
        payer.fill("input[type=tel]", "01112223333"); payer.fill("input[type=password]", "SaraPass123")
        payer.click("main button[type=submit]"); payer.wait_for_url("**/membership.html")
        payer.wait_for_selector(".pay-method")
        expect(payer.locator(".mcard .price")).to_contain_text("199 EGP")
        shot(payer, "61-pay-choose")
        payer.click(".pay-method.vodafone")
        expect(payer.locator(".pay-value")).to_have_text("01001234567")
        payer.click(".pay-form >> text=Change payment method")
        payer.click(".pay-method.instapay")
        expect(payer.locator(".pay-value")).to_have_text("xgo.one@instapay")
        payer.click(".pay-form button[type=submit]")
        expect(payer.locator(".pay-form .form-error")).to_contain_text("screenshot")
        payer.set_input_files(".pay-form input[type=file]", noisy_png("/home/claude/e2e/imgs/transfer.png", 1170, 2532))
        payer.fill(".pay-form input.input", "Sara A. - CIB")
        shot(payer, "62-pay-form")
        payer.click(".pay-form button[type=submit]")
        payer.wait_for_selector("text=Request under review")
        shot(payer, "63-pay-pending")
        assert sql("select status || ' ' || method from public.membership_requests where status='pending'") == "pending instapay"
        # screenshot is private: no public URL, and another customer can't get a signed link
        pth = sql("select proof_path from public.membership_requests where status='pending'")
        r = c.evaluate(f"""async () => {{ const m = await import('/js/common.js');
            const pub = await fetch(m.SUPABASE_URL + '/storage/v1/object/public/proofs/{pth}');
            const sig = await m.sb.storage.from('proofs').createSignedUrl('{pth}', 60);
            return [pub.status, !!sig.error]; }}""")
        assert r[0] != 200 and r[1] is True, r
        a.goto(SITE + "/admin.html#payments"); a.reload()
        a.wait_for_selector(".list .item:has-text('Sara Adel')")
        a.click(".list .item:has-text('Sara Adel')")
        a.wait_for_selector(".sheet img.proof-img")
        a.wait_for_function("document.querySelector('.sheet img.proof-img').naturalWidth > 0")
        shot(a, "64-admin-request", full=False)
        a.click(".sheet >> text=Approve & activate")
        a.wait_for_selector(".toast")
        payer.reload()
        payer.wait_for_selector(".qrbox canvas")
        expect(payer.locator(".mcard .badge")).to_have_text("Active")
        shot(payer, "65-pay-approved")
        assert sql("select source || ' ' || paid_egp from public.memberships m join public.profiles p on p.id=m.user_id where p.phone='201112223333'") == "payment 199.00"
        # mode closed -> no requests
        a.goto(SITE + "/admin.html#payments"); a.reload(); a.wait_for_selector("text=Membership sign-up")
        a.check("input[value=inactive]"); a.click("form:has-text('Membership sign-up') button[type=submit]"); a.wait_for_selector(".toast")
        p2 = phone_ctx(browser, "payer2").new_page()
        p2.goto(SITE + "/signup.html")
        p2.fill("input[autocomplete=given-name]", "Omar"); p2.fill("input[autocomplete=family-name]", "Z")
        p2.fill("input[type=tel]", "01112224444"); p2.fill("input[type=password]", "OmarPass123")
        p2.click("main button[type=submit]"); p2.wait_for_url("**/membership.html")
        expect(p2.locator(".mcard")).to_contain_text("temporarily unavailable")
        a.check("input[value=free]"); a.click("form:has-text('Membership sign-up') button[type=submit]"); a.wait_for_selector(".toast")

        # ---------------- admin ends membership -> scan shows expired ----------------
        a.click(".admin-tabs >> text=Members")
        a.wait_for_selector(".list .item")
        shot(a, "40-admin-members")
        a.click(".list .item:has-text('Ahmed')")
        shot(a, "41-admin-member-sheet", full=False)
        a.click("text=End membership now")
        a.click(".dialog .btn.danger")
        a.wait_for_selector(".toast")
        c.goto(SITE + "/membership.html")
        c.wait_for_selector(".qrbox canvas")
        expect(c.locator(".mcard .badge")).to_have_text("Expired")
        c.wait_for_timeout(400)
        shot(c, "42-customer-expired")
        b3, p3 = scan_with(c.locator(".qrbox canvas").screenshot(), "qr-expired", android=True)
        assert "Android" in p3.evaluate("navigator.userAgent")
        expect(p3.locator(".result")).to_contain_text("Membership expired")
        shot(p3, "43-provider-scan-expired")
        b3.close()

        a.click("text=Scans")
        a.wait_for_selector(".list .item")
        shot(a, "44-admin-scans")
        a.click("text=Modules")
        a.wait_for_selector(".switch")
        shot(a, "45-admin-modules")
        a.click("text=Dashboard")
        a.wait_for_selector(".stat")
        shot(a, "46-admin-dashboard-after")

        # desktop view of home
        d = browser.new_context(viewport={"width": 1280, "height": 860}); wire(d, "desktop")
        dp = d.new_page(); dp.goto(SITE + "/"); dp.wait_for_selector(".dcard")
        shot(dp, "50-desktop-home", full=False)
        browser.close()

    bad = [e for e in errors if "Failed to load resource" not in e or "favicon" not in e]
    csp = [e for e in errors if "Content Security Policy" in e or "Refused" in e]
    print("\nconsole errors:", *errors[:30], sep="\n  ")
    assert not csp, "CSP violations"
    print("UI E2E PASSED")


if __name__ == "__main__":
    main()
