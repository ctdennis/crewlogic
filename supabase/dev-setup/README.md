# Dev environment setup

The dev Supabase project mirrors prod's public schema. Two projects now exist:

| Label | Ref | Role |
|---|---|---|
| `crewlogic-prod` | `ozfkpxyachigfpcmvekz` | **Production** (live Junkluggers app) |
| `crewlogic-dev` | `bagkimfwmpwjfhfhmsrb` | **Dev** (standalone/non-franchise development) |

## How the schema was replicated (no Docker/pg_dump needed)
`supabase db dump` needs Docker, which isn't installed. Instead the schema is
generated from prod's catalog via the Management API:

1. **Generate** (linked to prod): `supabase db query --linked -f supabase/dev-setup/generate_baseline.sql | jq -r '.rows[0].schema_sql' > baseline_schema.sql`
   — emits types → tables → PK/unique/check → FKs → indexes → functions → triggers → RLS enable → policies, in dependency order.
2. **Apply** (linked to dev): `supabase db query --linked -f supabase/dev-setup/baseline_schema.sql`

`baseline_schema.sql` is a committed snapshot (18 tables, 5 enums, 9 functions,
8 triggers, 49 RLS policies). Regenerate it from prod with the generator above.

## Intentionally NOT replicated to dev
- **Vault secrets / Vonigo credentials** — encrypted per-project; dev is Vonigo-free
  by design (standalone work needs no CRM). Add real Vonigo creds to dev's Vault only
  if/when testing Vonigo *reads* in dev.
- **Storage bucket `estimate-photos`** — created in dev via `storage_setup.sql` (bucket + anon read/upload/delete policies mirroring prod), so photo upload/sign works in dev.
- **Data** — dev uses synthetic data (a test `crm_provider='none'` tenant), never a
  copy of prod customer data.
- **Cron jobs / edge-function secrets** — re-create/set on dev as needed, pointing at dev.

## Switching the CLI between projects
- `supabase link --project-ref bagkimfwmpwjfhfhmsrb`  → **dev**
- `supabase link --project-ref ozfkpxyachigfpcmvekz`  → **prod**
Always confirm with `supabase projects list` (look for the ● and the prod/dev label)
before running deploys or SQL.
