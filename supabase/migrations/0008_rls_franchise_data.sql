-- 0008: SEC-1 (CL-SPEC-004) — franchise-scoped RLS for the bulk franchise-data tables.
-- Replaces the wide-open `using(true)` policies. Applies the proven customers pattern (0007).
-- Apply to dev:  bash supabase/dev-setup/dev-sql.sh -f supabase/migrations/0008_rls_franchise_data.sql
-- Apply to prod: gated, at promotion (after Google->Supabase Auth so all prod users have auth.uid()).
--
-- NOT covered here (separate migrations, special scoping): profiles, franchises, tenants,
-- invites + feedback (pre-auth carve-outs), vonigo_credentials/_audit (owner-only). customers = 0007.

-- 1) Drop every existing policy on the target tables (names vary; do it generically).
do $$
declare r record;
  targets text[] := array[
    'campaigns','crew_members','customer_price_lists','estimates','job_plans',
    'price_list_zips','price_lists','sign_credits','sign_rewards','sign_sessions',
    'sign_status_events','tools','yard_signs','price_blocks','price_items'
  ];
begin
  for r in select policyname, tablename from pg_policies
           where schemaname='public' and tablename = any(targets) loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- 2) Direct franchise_id tables — the customers pattern (SELECT/INSERT/UPDATE/DELETE, authenticated).
do $$
declare t text;
  direct text[] := array[
    'campaigns','crew_members','customer_price_lists','estimates','job_plans',
    'price_list_zips','price_lists','sign_credits','sign_rewards','sign_sessions',
    'sign_status_events','tools','yard_signs'
  ];
begin
  foreach t in array direct loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (franchise_id = public.current_franchise_id())', t||'_sel', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (franchise_id = public.current_franchise_id())', t||'_ins', t);
    execute format('create policy %I on public.%I for update to authenticated using (franchise_id = public.current_franchise_id()) with check (franchise_id = public.current_franchise_id())', t||'_upd', t);
    execute format('create policy %I on public.%I for delete to authenticated using (franchise_id = public.current_franchise_id())', t||'_del', t);
  end loop;
end $$;

-- 3) Pricing children — scope through the parent up to price_lists.franchise_id.
alter table public.price_blocks enable row level security;
create policy price_blocks_all on public.price_blocks for all to authenticated
  using (exists (select 1 from public.price_lists pl
                 where pl.id = price_blocks.price_list_id
                   and pl.franchise_id = public.current_franchise_id()))
  with check (exists (select 1 from public.price_lists pl
                 where pl.id = price_blocks.price_list_id
                   and pl.franchise_id = public.current_franchise_id()));

alter table public.price_items enable row level security;
create policy price_items_all on public.price_items for all to authenticated
  using (exists (select 1 from public.price_blocks pb
                 join public.price_lists pl on pl.id = pb.price_list_id
                 where pb.id = price_items.price_block_id
                   and pl.franchise_id = public.current_franchise_id()))
  with check (exists (select 1 from public.price_blocks pb
                 join public.price_lists pl on pl.id = pb.price_list_id
                 where pb.id = price_items.price_block_id
                   and pl.franchise_id = public.current_franchise_id()));
