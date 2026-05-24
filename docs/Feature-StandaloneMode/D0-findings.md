# D0 — Discovery findings (baseline & RLS audit)

| | |
|---|---|
| **For** | CL-BRD-002 §12 / §14 |
| **Date** | 2026-05-24 |
| **Scope** | Read-only. Re-verify §4 references with current line numbers; capture the exact `crewlogic-price-lookup` response shape; specify the RLS audit query. |
| **Result** | Code-side complete. RLS audit requires SQL-editor access (query provided in §3). |

---

## 1. Re-verified references (current line numbers)

### 1a. OAuth domain restriction (`junkluggers.com`)
- `index.html:47` — `hd: 'junkluggers.com'` (initial OAuth params).
- `index.html:1035` — login copy: "Sign in with your **@junkluggers.com** Google account".
- `index.html:3588` — comment "Only restrict to junkluggers.com if not an invite flow".
- `index.html:3591` — `oauthParams.hd = 'junkluggers.com';` (the conditional set; already lifts for invite flows).

### 1b. Super-admin hardcode
- `index.html:4696` — `const isSuperAdmin = currentUser.email === 'charles.dennis@junkluggers.com';`
- `index.html:4700` — uses it to toggle a "guest" card. (Only 2 sites — small.)

### 1c. Hardcoded tenant UUID `946a4535-aa61-45b6-a6fb-9190ff546d41`
**index.html — 7 occurrences** (BRD §4 listed 6; **`17615` is newly found**):
- `3471` — fallback for `currentUser.tenantID` on login.
- `3751` — `&tenant_id=eq.946a4535…` filter.
- `4335` — franchises lookup filter.
- `4469` — franchises lookup filter.
- `5243` — fallback for `currentUser.tenantID` (alt login path).
- `5322` — `tenant_id:` write value.
- **`17615`** — `payload.tenant_id = currentUser.tenantID || '946a4535…'` ← **not in BRD §4; add it.**

**Edge functions — 5 occurrences:**
- `crewlogic-price-lookup/index.ts:50` — `const TENANT_ID = …`
- `crewlogic-todays-workorders/index.ts:42` — `const TENANT_ID = …`
- `crewlogic-job-plan/index.ts:44` — `const TENANT_ID = …`
- `crewlogic-settings/index.ts:155` — `const REFERENCE_TENANT_ID = …`
- `crewlogic-settings/index.ts:349` — `const JUNKLUGGERS_TENANT_ID = …`

### 1d. Paywall / subscription gating
- `index.html:1091` — `#paywallScreen` div.
- `index.html:8579` — `['paywallScreen','paywall']` entry (allScreens registration).
- `index.html:4766-4769` — the gate:
  ```js
  const status = currentUser.subscriptionStatus || 'trialing';
  const hasAccess = ['active','trialing','tester','pro','enterprise'].includes(status);
  if (!hasAccess) { /* show paywall */ }
  ```
- Login/profile loads set **`currentUser.subscriptionTier`** at `3474`, `3540`, `5000`, `11676`.

> ⚠️ **DISCREPANCY (flag for billing, S-C.2):** the gate at `4766` reads
> `currentUser.subscriptionStatus`, but every code path I found only ever sets
> `currentUser.subscriptionTier` — **`subscriptionStatus` is never assigned in `index.html`.** So
> the gate currently always falls back to `'trialing'` (access granted) unless
> `crewlogic-oauth-callback` injects `subscriptionStatus` onto the session object at sign-in (the
> callback was reported to return a `subscriptionStatus` field — **verify this end-to-end before
> billing work**, or the paywall may never trigger / may key off the wrong field). Either rename to
> one field or have the callback set `subscriptionStatus` explicitly.

### 1e. Franchise `#90` feature gates
- `index.html:4806` — router card visibility: `(String(currentUser.franchiseID) === '90' && role === 'owner')`.
- `index.html:4968` — `if (String(currentUser.franchiseID) !== '90') { … }` (route optimizer guard).
- Only 2 sites.

### 1f. `N8N_BASE` and its call sites
- `index.html:3317` — `const N8N_BASE = 'https://junkluggers.app.n8n.cloud/webhook';`
- Call sites (all Vonigo-dependent): `3812` searchClients, `5711` crewlogic-jobs, `5757` crewlogic-trucks, `5833` crewlogic-route, `10043` + `10164` crewlogic-job-lookup, `10726` crewlogic-submit-quote, `11178` crewlogic-estimate (delete). **8 call sites.**

---

## 2. Exact `crewlogic-price-lookup` response shape (build to THIS)

From `supabase/functions/crewlogic-price-lookup/index.ts:255-290`. The native `crewlogic-pricing`
lookup (S-A.3) must return **this exact shape** — no more, no less:

```jsonc
{
  "success": true,
  "zipCode": "02360",        // echo of input ('' if zoneID used)
  "zoneID": "",              // echo of input ('' if zip used)
  "priceListID": 768,        // number
  "priceListName": "Junk Removal - 9 Increments",
  "zoneName": "9 Increments",// priceListName with "Junk Removal - " and " PL" stripped
  "blocks": [
    {
      "priceBlockID": 561,
      "name": "Volume Charges",
      "sequence": 1,
      "items": [
        {
          "priceItemID": 12345,
          "name": "Full Truckload",
          "value": 600,
          "unitOfMeasure": "volume",
          "sequence": 3
        }
      ]
    }
  ]
}
```

### ⚠️ Corrections to BRD §5 / §6 / S-A.3
The BRD's stated response items (`…, isActive, isAllowDecimals`) are **wrong**. The actual response
item has **only**: `priceItemID, name, value, unitOfMeasure, sequence`.
- `isActive` is a **filter** server-side (inactive items dropped), **not** returned (`index.ts:257`).
- `isAllowDecimals` is **not in the response at all.** The frontend **derives** decimal behavior
  from `unitOfMeasure`:
  - `index.html:15749` — `DECIMAL_ALLOWED_UNITS = new Set(['cubic yards','volume','hour','flight','pound'])`
  - `index.html:15750-15754` — `chargeAllowsDecimals(item)` returns `true` iff
    `item.unitOfMeasure.toLowerCase().trim()` is in that set.
- **Implication for the native price book:** `unitOfMeasure` is load-bearing. Volume tiers should
  carry a unit in `DECIMAL_ALLOWED_UNITS` (e.g. `"volume"`); per-piece surcharges should use a
  non-decimal unit (e.g. `"ea"`) so quantities stay whole. The `price_items.is_allow_decimals`
  column in BRD §6 is therefore **not needed for parity** — keep `unit_of_measure` accurate instead
  (the column can stay as optional metadata but the frontend ignores it).

### Frontend consumers to keep working (unchanged)
- `findVolumeItem(fraction)` `~index.html:9340` — matches volume items by name label per fraction.
- `matchSurchargeItem(name)` `~index.html:7752` — matches surcharge items by normalized name.
- `calcVolumePrice()` `~9542`, `calcVolumePriceSplit()` `~9565`.
These only read `block.name`, `item.name`, `item.value`, `item.unitOfMeasure` → all present above.

---

## 3. RLS audit — query to run (SQL editor)

Could not be read from here (PostgREST does not expose `pg_policies`). Run in the Supabase SQL
editor and paste results back so new-table RLS (S-A.1) matches the existing pattern:

```sql
-- Existing RLS policies on the tables new tables should mirror
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where tablename in ('profiles','franchises','tenants','estimates','customer_price_lists')
order by tablename, policyname;

-- Whether RLS is enabled/forced on those tables
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relname in ('profiles','franchises','tenants','estimates','customer_price_lists');
```

What to look for: are policies scoped by `franchise_id`, by `tenant_id`, or via a join to
`profiles.auth_user_id = auth.uid()`? The new tables (`price_lists`, `price_blocks`, `price_items`,
`service_zones`, `customers`) should use the **same** scoping expression. Note that the edge
functions use the service-role key (which **bypasses RLS**), so RLS primarily protects any direct
`supabaseFetch` reads from the browser — the pricing editor (S-B.2) if it reads via PostgREST.

---

## 4. Net adjustments to fold into CL-BRD-002

1. **§4 tenant-UUID list:** add `index.html:17615`. (7 in index.html, 5 in edge functions = **12 total**.)
2. **§5 invariant + §6 + S-A.3:** correct the response item shape to `{ priceItemID, name, value,
   unitOfMeasure, sequence }`; drop `isActive`/`isAllowDecimals` from the response contract; note
   that decimal behavior is driven by `unitOfMeasure ∈ DECIMAL_ALLOWED_UNITS`.
3. **§6 data model:** `price_items.is_allow_decimals` is not required for parity — `unit_of_measure`
   is the load-bearing field; seed volume tiers with a decimal-allowed unit and surcharges without.
4. **Billing (S-C.2):** resolve the `subscriptionStatus` vs `subscriptionTier` field mismatch (§1d)
   before wiring the paywall, and confirm what `crewlogic-oauth-callback` puts on the session.
5. **RLS:** pending the §3 query output.
