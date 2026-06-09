# Marketing site + Trial signup + Onboarding — WORK IN PROGRESS

**Status:** Paused 2026-06-09 mid-build (paused to make a prod change). All code is on the **`dev`** branch (committed + pushed to `origin/dev`). Nothing here is on `main`/prod yet.

## What's built (on dev)
- **`start.html`** — single-page marketing/landing site. Dark theme in the app palette (`#0b131d` bg, `#152230` cards, `#1e2f40` icon tiles), green accent `#39ED07`/`#00E785`. Sections: split hero (copy + 3-step "how it works" panel) → asymmetric features grid (one wide highlight + hover green-top-accent + lift) → inline trust band → split signup form → footer.
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
1. **Repo restructure for the split:** move the marketing page into its own deployable (e.g. `marketing/index.html` + `marketing/assets/`), point the form's magic-link `emailRedirectTo` at `https://app.crewlogicai.com`.
2. **Cloudflare (owner, dashboard, ~10 min):** create a 2nd Pages project for the marketing folder → custom domain **crewlogicai.com**; move the existing app project's custom domain to **app.crewlogicai.com**. DNS is automatic (domain already on Cloudflare). Add `app.crewlogicai.com` to the app's Supabase Auth allowed redirect URLs.
3. **Phase 1b (app):** `index.html` reads the new user's `user_metadata.company` to pre-fill the "Name your workspace" step (and `full_name` for the profile), so the trial start is seamless (no retyping). Optionally apply `phone`/`territory` to franchise settings.
4. **Dev testability:** `crewlogic-signup` is **prod-only** (not deployed to dev — dev edge calls 404 by design). To test the full trial flow on dev, deploy `crewlogic-signup` to dev + allow the dev redirect URL in dev Supabase Auth. (Full flow already works on prod.)
5. **Phase 2 — onboarding wizard** (the bigger net-new build): once provisioned, guide the new owner through brand color/logo, price-book ZIPs (+ the town-name backfill we shipped), customers, invite crew. Ties to STATUS backlog rows 42/54/61.

## Files (dev branch)
`start.html`, `assets/crewlogic-logo.svg`, `_redirects`. App config reused: env detection + publishable anon keys at `index.html` ~3526–3532; native signup at `crewlogic-signup` + `_shared/provisionNative.ts`; "Name your workspace" = `showNameWorkspaceScreen`/`submitNameWorkspace` (~5366/5393).
