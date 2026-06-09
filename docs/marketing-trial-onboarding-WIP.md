# Marketing site + Trial signup + Onboarding — WORK IN PROGRESS

**Status:** **LIVE in prod (2026-06-09).** The two-URL split is built, promoted to `main`, and connected:
`crewlogicai.com` + `www` serve the marketing site; `app.crewlogicai.com` serves the app (v5.29.0); the
trial form fires a magic link at `app.crewlogicai.com` via prod Supabase (Site URL + redirect URLs set).
Verified by read-only GET (each domain serves the right page) + served-page inspection (marketing targets
the prod app + prod Supabase). Cloudflare = two Pages projects from one repo: **`crewlogic`** (app, output
root, domain `app.crewlogicai.com`) and **`crewlogic-marketing`** (output dir `marketing`, domain
`crewlogicai.com`+`www`).

**Full e2e VERIFIED in prod 2026-06-09:** real form submit (`tpass2008@gmail.com`, business "Ricky's Removal") → Resend email delivered **to inbox** → magic link → app.crewlogicai.com → "Name your workspace" **pre-filled with the form's company** → Create → provisioned a `trialing` native workspace → landed in app with the 14-day-trial banner (access gate OK). Earlier ctdennis run confirmed the same chain.

**Custom SMTP DONE (2026-06-09):** Resend wired into Supabase Auth SMTP (`smtp.resend.com:465`, sender `noreply@crewlogicai.com`); domain `crewlogicai.com` verified (MX/SPF/DKIM on the `send` subdomain via Cloudflare). Replaced the built-in ~2/hour throttle that was blocking testing — and is **required for launch** (built-in email is not production-grade). Config lives in the Supabase dashboard (nothing in repo).

**Remaining:**
- **Email + password auth (next build, prioritized)** — the real fix for the magic-link friction. Agreed design: marketing form collects a password → `signUp` → instant session → workspace → app (no inbox detour to enter); **defer** email confirmation (let them in, confirm async; require before going past trial); add password sign-in + "forgot password" to the app login screen (Google + magic-link stay as options). See [[email-password-auth-roadmap]].
- **Phase 2 onboarding wizard** — guide a new owner through brand color/logo, price-book ZIPs, customers, invite crew.
- Test workspaces this generated are removed via `admin_delete_tenant` (migration 0015).

## What's built (on dev)
- **`marketing/index.html`** (was `start.html`; moved 2026-06-09) — single-page marketing/landing site. Dark theme in the app palette (`#0b131d` bg, `#152230` cards, `#1e2f40` icon tiles), green accent `#39ED07`/`#00E785`. Sections: split hero (copy + 3-step "how it works" panel) → asymmetric features grid (one wide highlight + hover green-top-accent + lift) → inline trust band → split signup form → footer.
  - **Logo:** text wordmark — **CrewLogic** (white) + **AI** in a green rounded box (black text). Same treatment in header and hero. Tagline **OPTIMIZE • ESTIMATE • PLAN** (green bullets). (Earlier graphic-logo attempts abandoned; `assets/crewlogic-logo.svg` is a hand-built vector mark kept for later, not used on the page.)
  - **Trial form (simplified):** Full Name, Email, Phone, Business/Franchise Name, City/Territory. (Dropped Franchise Brand, # Trucks, goals textarea per owner.)
- **Trial wiring — Phase 1a (done):** form submit fires a **Supabase magic link** (`signInWithOtp`, env-aware dev/prod by hostname) carrying `full_name / company / phone / territory` as user metadata, `emailRedirectTo: location.origin`, then shows a "Check your email" state. The link lands in the app's **existing native-signup flow** → `crewlogic-signup` provisions a native `trialing` tenant+franchise+profile.
- **`_redirects`** (`/* /index.html 200`) and the optimized logo asset are also on dev.

## The trial machinery already exists (reuse, don't rebuild)
A no-session visitor at the app already gets a "Continue with Google / Continue with email" picker; **email → magic link → "Name your workspace" → `crewlogic-signup` → trialing native workspace.** So "anyone with an email can already start a trial today." The marketing form is just a nicer front door to this.

## Architecture decision (the long-term-right path) — **two-URL split**
- **crewlogicai.com** → the **marketing** site (`start.html` as its index).
- **app.crewlogicai.com** → the **app** (current `index.html`). Returning users go here directly, no marketing in the way.
- Trial magic-link `emailRedirectTo` should point at **app.crewlogicai.com**.
- Rationale: clean separation (marketing changes never touch the 18k-line app), scales (docs/blog/pricing later), and it **sidesteps the Cloudflare routing problem** below.

### Cloudflare routing finding (why a separate `/start.html` URL didn't work)
On `dev.crewlogic.pages.dev`: **static assets serve** (e.g. `/assets/crewlogic-logo.svg` returns the SVG), but **`/start` and `/start.html` both return the app** (`index.html`) — Cloudflare is forcing index.html for HTML page routes. `_redirects` did not change it → it's a **Cloudflare Pages project setting**, not a repo fix. The subdomain split makes this moot (marketing = its own project at the root).

## Remaining steps to resume

### DONE (code side, dev branch, 2026-06-09)
1. ✅ **Repo restructure for the split:** marketing page moved to **`marketing/index.html`** (self-contained — all CDN, no local assets). This is the deployable for the new Cloudflare project (build output dir = `marketing`).
2. ✅ **Magic-link redirect points at the app, not marketing:** `marketing/index.html` now computes `_PROD = hostname is crewlogicai.com/www` (anything else = DEV, so previews need no enumeration) and sets `emailRedirectTo = APP_URL` → **`https://app.crewlogicai.com`** (prod) / **`https://dev.crewlogic.pages.dev`** (dev).
3. ✅ **Phase 1b — workspace pre-fill:** `showNameWorkspaceScreen(email, meta)` now pre-fills company (`user_metadata.company`) + name (`full_name`) from the trial form, set via DOM `.value` (injection-safe). Caller in `resumeNativeSession` (~3952) passes `sbSession.user.user_metadata`. (v5.29.0.)

### TODO — owner dashboard steps (I can't do these; Cloudflare UI + prod Supabase Auth config are gated/manual)
4. **Cloudflare — create the marketing project (~10 min):**
   a. Pages → **Create project** → connect the **same GitHub repo** (`ctdennis/crewlogic`).
   b. **Build output directory = `marketing`** (no build command — it's static). Production branch = `main`.
   c. Once it builds, add **Custom domain → `crewlogicai.com`** (and `www` if desired) to THIS new project.
5. **Cloudflare — move the app's domain to the subdomain:**
   a. On the **existing app** Pages project: **remove** the `crewlogicai.com` custom domain, **add** `app.crewlogicai.com`. (`crewlogic.pages.dev` + `dev.crewlogic.pages.dev` stay as-is.)
   b. Order matters: stand up the marketing project + its domain FIRST, then move the app domain, so `crewlogicai.com` is never dark.
6. **Supabase prod Auth (app project `ozfkpxyachigfpcmvekz`):** Authentication → URL Configuration → add **`https://app.crewlogicai.com`** to **Redirect URLs** (and set it as **Site URL**). Without this the magic link won't redirect to the app.
7. **Dev testability (optional):** `crewlogic-signup` is **prod-only** (dev edge calls 404 by design). To exercise the full trial flow on dev, deploy `crewlogic-signup` to dev + add `https://dev.crewlogic.pages.dev` to **dev** Supabase Auth redirect URLs. (Full flow already works on prod once steps 4–6 land.)
8. **Phase 2 — onboarding wizard** (bigger net-new build): once provisioned, guide the new owner through brand color/logo, price-book ZIPs (+ the town-name backfill we shipped), customers, invite crew. Ties to STATUS backlog rows 42/54/61. Optionally apply trial `phone`/`territory` metadata to franchise settings here.

## Files (dev branch)
`marketing/index.html` (the marketing site), `assets/crewlogic-logo.svg` (unused spare vector mark), `_redirects` (app SPA fallback at repo root — outside `marketing/`, so it only affects the app project). App config reused: env detection + publishable anon keys at `index.html` ~3526–3532; native signup at `crewlogic-signup` + `_shared/provisionNative.ts`; "Name your workspace" = `showNameWorkspaceScreen`/`submitNameWorkspace` (~5370/5395).
