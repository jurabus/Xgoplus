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


def phone_ctx(browser, name, **kw):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True,
                              has_touch=True, locale="en-US", **kw)
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
        a.click("button[type=submit]")
        expect(a.locator(".form-error")).to_contain_text("Wrong email or password")
        a.fill("input[type=password]", "AdminPass123")
        a.click("button[type=submit]")
        expect(a.locator("h1")).to_have_text("Dashboard")
        shot(a, "02-admin-dashboard")

        # providers
        a.click("text=Providers")
        expect(a.locator("h1")).to_have_text("Providers")
        a.click("text=+ Add")
        a.fill(".sheet input >> nth=0", "cafe_one")
        a.locator(".sheet input").nth(1).fill("CafePass123")
        a.locator(".sheet input").nth(2).fill("Cafe Aroma")
        a.locator(".sheet input").nth(3).fill("15")
        a.locator(".sheet textarea").fill("Offer only valid on Fridays\nDine-in only")
        a.set_input_files(".sheet input[type=file]", cafe_img)
        shot(a, "03-admin-provider-new", full=False)
        a.click(".sheet button[type=submit]")
        expect(a.locator(".list")).to_contain_text("Cafe Aroma")
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

        # ---------------- guest ----------------
        g = phone_ctx(browser, "guest").new_page()
        g.goto(SITE + "/")
        g.wait_for_selector(".pcard")
        expect(g.locator("main p.muted").first).to_have_text("Members save more, everywhere")
        n1 = g.locator(".pcard").count()
        shot(g, "10-guest-home", full=False)
        g.mouse.wheel(0, 6000); g.wait_for_timeout(800); g.mouse.wheel(0, 6000); g.wait_for_timeout(800)
        n2 = g.locator(".pcard").count()
        assert n1 == 24 and n2 == 42, (n1, n2)
        shot(g, "11-guest-home-scrolled")
        g.fill("input[type=search]", "aroma")
        g.wait_for_timeout(700)
        assert g.locator(".pcard").count() == 1
        g.click(".pcard")
        expect(g.locator("h1")).to_have_text("Cafe Aroma")
        expect(g.locator(".notes")).to_contain_text("Fridays")
        shot(g, "12-guest-provider")
        g.goto(SITE + "/provider.html?id=00000000-0000-0000-0000-000000000000")
        expect(g.locator(".empty")).to_contain_text("not available")
        g.goto(SITE + "/membership.html")
        shot(g, "13-guest-membership")

        # ---------------- customer ----------------
        c = phone_ctx(browser, "customer").new_page()
        c.goto(SITE + "/signup.html")
        shot(c, "20-signup")
        c.fill("input[autocomplete=given-name]", "Ahmed")
        c.fill("input[autocomplete=family-name]", "Mostafa")
        c.fill("input[type=tel]", "0100 111 2222")
        c.fill("input[type=password]", "short")
        c.click("button[type=submit]")
        expect(c.locator(".form-error")).to_contain_text("8 characters")
        c.fill("input[type=password]", "MyPass1234")
        c.click("button[type=submit]")
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
        c2.click("button[type=submit]")
        expect(c2.locator(".form-error")).not_to_be_empty()
        c2.goto(SITE + "/login.html")
        c2.fill("input[type=tel]", "01001112222"); c2.fill("input[type=password]", "wrongpass1")
        c2.click("button[type=submit]")
        expect(c2.locator(".form-error")).to_contain_text("Wrong phone")
        shot(c2, "24-login-error")

        # ---------------- provider scans with a fake camera showing the QR ----------------
        def scan_with(qr_bytes, label):
            im = Image.open(io.BytesIO(qr_bytes)).convert("RGB")
            canvas = Image.new("RGB", (640, 480), (40, 40, 40))
            im = im.resize((360, 360))
            canvas.paste(im, (140, 60))
            src = f"/home/claude/e2e/{label}.png"; vid = f"/home/claude/e2e/{label}.y4m"
            canvas.save(src)
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-i", src, "-t", "3", "-pix_fmt", "yuv420p", vid], check=True)
            b2 = pw.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                                          f"--use-file-for-fake-video-capture={vid}"])
            ctx = phone_ctx(b2, "provider", permissions=["camera"])
            p = ctx.new_page()
            p.goto(SITE + "/partner.html")
            if p.locator("text=Partner login").count():
                p.fill("input[autocomplete=username]", "cafe_one")
                p.fill("input[type=password]", "CafePass123")
                p.click("button[type=submit]")
            p.wait_for_selector(".result", timeout=20000)
            return b2, p

        b2, p = scan_with(qr_png, "qr-active")
        expect(p.locator(".result")).to_contain_text("Membership active")
        expect(p.locator(".result .big")).to_have_text("15%")
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
        p.click("button[type=submit]")
        p.wait_for_selector(".toast")
        shot(p, "32-provider-profile")
        p.set_input_files("input[type=file]", gym_img)
        p.wait_for_selector(".toast")
        p.wait_for_timeout(1200)
        assert sql("select discount_percent from public.providers where username='cafe_one'") == "20.00"
        assert sql("select image_path like 'providers/%' from public.providers where username='cafe_one'") == "t"
        b2.close()

        # wrong login for partner
        pp = phone_ctx(browser, "provider-bad").new_page()
        pp.goto(SITE + "/partner.html")
        shot(pp, "33-partner-login")
        pp.fill("input[autocomplete=username]", "cafe_one"); pp.fill("input[type=password]", "nope-nope")
        pp.click("button[type=submit]")
        expect(pp.locator(".form-error")).to_contain_text("Wrong username")

        # ---------------- admin ends membership -> scan shows expired ----------------
        a.click("text=Members")
        a.wait_for_selector(".list .item")
        shot(a, "40-admin-members")
        a.click(".list .item >> nth=0")
        shot(a, "41-admin-member-sheet", full=False)
        a.click("text=End membership now")
        a.click(".dialog .btn.danger")
        a.wait_for_selector(".toast")
        c.goto(SITE + "/membership.html")
        c.wait_for_selector(".qrbox canvas")
        expect(c.locator(".mcard .badge")).to_have_text("Expired")
        c.wait_for_timeout(400)
        shot(c, "42-customer-expired")
        b3, p3 = scan_with(c.locator(".qrbox canvas").screenshot(), "qr-expired")
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
        dp = d.new_page(); dp.goto(SITE + "/"); dp.wait_for_selector(".pcard")
        shot(dp, "50-desktop-home", full=False)
        browser.close()

    bad = [e for e in errors if "Failed to load resource" not in e or "favicon" not in e]
    csp = [e for e in errors if "Content Security Policy" in e or "Refused" in e]
    print("\nconsole errors:", *errors[:30], sep="\n  ")
    assert not csp, "CSP violations"
    print("UI E2E PASSED")


if __name__ == "__main__":
    main()
