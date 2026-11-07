# XGo Plus

Members discount platform — https://xgoplus.online

- **Guests** browse partners (logo, name, % off) and partner pages (image, % off, special notes).
- **Customers** sign up with phone + password + first/last name, subscribe to the yearly membership
  (199 EGP list price, free while `membership_free` is on) and show a QR code at checkout.
- **Providers** (created only by admin) log in with username + password at `/partner.html`, edit their
  image/name/discount/notes, and scan customer QR codes to see *active + discount* or *expired*.
- **Search**: header search on every customer page — live top-5 suggestions (image, name, % off) tolerant to typos,
  accents and Arabic letter variants; "View all" opens `search.html` (20 per page, more on scroll).
- **Categories**: filter chips on home and search pages; managed in the admin Categories tab.
- **Admin** (`/admin.html`, email + password, listed in `admins` table, 20-min idle logout) manages
  providers, members, banners, every text, scan log and module switches (`app_disabled_modules`).

Web app only (no native iOS/Android app).

## Layout

| Path | What |
| --- | --- |
| `index.html`, `provider.html`, `login.html`, `signup.html`, `membership.html`, `account.html`, `partner.html`, `admin.html` | Website pages (plain HTML, ES modules, no build) |
| `js/common.js` | Shared core: Supabase client, auth/role, settings, UI kit, image resize |
| `js/pages/*.js` | One script per page |
| `js/admin/*.js` | One admin tab per feature |
| `js/vendor/` | Bundled libraries (supabase-js, QR generator, QR scanner) — rebuild with `tools/vendor/build.sh` |
| `js/config.js` | Supabase URL + publishable key only |
| `shared/settings-defaults.json` | Default texts for site + app (regenerate `js/defaults.js` with `tools/gen-defaults.sh`) |
| `supabase/schema.sql`, `supabase/migrations/0NN_*.sql` | Database (run in order in SQL Editor; idempotent) |
| `tests/db/` | Role-by-role database tests on local Postgres |
| `tests/e2e/` | Real browser tests against local GoTrue + PostgREST + migrations |

## Security model

- Row Level Security on every table; explicit column-level GRANTs (new Supabase projects grant nothing).
- Trust-sensitive writes only through `SECURITY DEFINER` RPCs (membership subscribe/grant, provider admin, QR verify).
- Membership QR = `XG1.<member>.<unix time>.<HMAC-SHA256>` signed with a secret in the private schema;
  valid 3 minutes, refreshed every 60 s, contains no name/phone. Scans are rate-limited (30/min/provider) and logged.
- Phone login maps to `u<digits>@xgoplus.online`; providers to `<username>@p.xgoplus.online`;
  these emails cannot be changed (trigger on `auth.users`).
- Strict CSP via `<meta>`, frame-busting, all output via DOM text nodes (no `innerHTML` with data).

## Database migrations

1. `supabase/schema.sql` — core: admins, settings, banners, profiles + sign-up trigger, storage, rate limits
2. `migrations/002_providers.sql` — providers + admin provider RPCs
3. `migrations/003_membership.sql` — memberships, QR tokens, admin member RPCs
4. `migrations/004_scanner.sql` — scan verification, scan log, admin stats
5. `migrations/005_categories_search.sql` — categories, provider category, typo-tolerant search (`search_providers`)

`supabase/setup_all.sql` = all of the above in one file (regenerate with `tools/gen-setup-all.sh`).

## Tests

```sh
python3 -I tests/db/test_rls.py     # 170 database checks incl. 20k-row performance
tests/e2e/run.sh                    # full UI run, screenshots of every screen
```
