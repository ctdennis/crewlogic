# Dev auth for RLS testing (SEC-1 / CL-SPEC-004)

The dev sign-in **bypass** (`devSignIn` in `index.html`, injected only on `IS_DEV_ENV`) now establishes a
**real Supabase Auth session** via `signInWithPassword`, so `auth.uid()` works and scoped RLS policies are
testable in-browser. This requires each dev test account to have an `auth.users` row whose id is linked to
its `profiles.auth_user_id`.

Set up 2026-06-03. **If the dev project is rebuilt, re-run these steps** (creating `auth.users` needs the
admin API — not pure SQL).

## Accounts
| Email | Franchise | Role | Provider |
|---|---|---|---|
| `dev-owner@crewlogic.test`  | `22222222-…` (Dev Standalone Co, native) | owner | password |
| `dev-vonigo@crewlogic.test` | `44444444-…` (Dev Vonigo #90)            | owner | password |

Password (dev only): `CrewlogicDev!2026` — matches `DEV_BYPASS_PASSWORD` in `index.html`.

## Recreate
1. **Create the auth users** (dev service-role key, fetched transiently — do not commit it):
   ```bash
   SRK=$(supabase projects api-keys --project-ref bagkimfwmpwjfhfhmsrb -o json \
     | python3 -c "import sys,json; print([k['api_key'] for k in json.load(sys.stdin) if k['name']=='service_role'][0])")
   for e in dev-owner@crewlogic.test dev-vonigo@crewlogic.test; do
     curl -s -X POST "https://bagkimfwmpwjfhfhmsrb.supabase.co/auth/v1/admin/users" \
       -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" \
       -d "{\"email\":\"$e\",\"password\":\"CrewlogicDev!2026\",\"email_confirm\":true}" \
       -o /dev/null -w "$e -> %{http_code}\n"
   done
   ```
2. **Link the profiles** to their new auth ids:
   ```bash
   bash supabase/dev-setup/dev-sql.sh "update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.email in ('dev-owner@crewlogic.test','dev-vonigo@crewlogic.test')"
   ```

## Verify RLS (SQL impersonation, no browser)
```sql
begin;
select set_config('request.jwt.claims', '{"sub":"<auth_user_id>"}', true);
set local role authenticated;
select public.current_franchise_id(), count(*) from public.customers;  -- only that franchise's rows
rollback;
```

## Prod
Prod has **no** such bypass (`devSignIn` is never injected outside dev). The prod path to universal
`auth.uid()` is the Google→Supabase Auth migration (CL-SPEC-004 §3), not these test accounts.
