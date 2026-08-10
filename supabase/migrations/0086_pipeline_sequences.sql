-- Pipeline SEQUENCES — user-built, reusable follow-up templates (replaces the hardcoded cadences).
-- A sequence = ordered steps (delay + channel + optional email/text template). Assigning an item to a
-- sequence seeds pipeline_touches from its steps. Franchise-owned; one may be the auto-default per item type.
-- Provider-agnostic (works for native items too). Via crewlogic-pipeline (service role); RLS on, no public policy.

create table if not exists public.pipeline_sequences (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  franchise_id     uuid not null,
  name             text not null,
  description      text,
  default_for_type text,                       -- lead|unconverted_estimate|cancellation|ucb|case → auto-default for that type
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table public.pipeline_sequences enable row level security;
create index if not exists pipeline_sequences_franchise_idx on public.pipeline_sequences (franchise_id);
-- at most one active default sequence per (franchise, type)
create unique index if not exists pipeline_sequences_default_idx on public.pipeline_sequences (franchise_id, default_for_type) where default_for_type is not null and active;

create table if not exists public.pipeline_sequence_steps (
  id           uuid primary key default gen_random_uuid(),
  sequence_id  uuid not null references public.pipeline_sequences(id) on delete cascade,
  sort_order   int not null default 0,
  delay_value  int not null default 0,          -- N
  delay_unit   text not null default 'day',     -- day | week | month  (from when the sequence is assigned)
  channel      text not null default 'call',    -- call | email | text | task
  subject      text,                            -- email subject template
  body         text,                            -- email/text body template (merge fields e.g. {{first_name}})
  created_at   timestamptz not null default now()
);
alter table public.pipeline_sequence_steps enable row level security;
create index if not exists pipeline_sequence_steps_idx on public.pipeline_sequence_steps (sequence_id, sort_order);

-- Link items + touches to the sequence machinery.
alter table public.pipeline_items   add column if not exists sequence_id      uuid;   -- the sequence this item is on
alter table public.pipeline_touches add column if not exists sequence_step_id uuid;   -- which step seeded this touch (→ its template)

-- Keep pipeline_items.next_action_at in sync automatically = the earliest still-scheduled touch. Lets
-- assign/seed/complete just write touches; the tickler (drives the calendar/attention view) maintains itself.
create or replace function public.pipeline_touch_recompute_next() returns trigger
language plpgsql security definer set search_path = public as $$
declare _item uuid;
begin
  _item := coalesce(new.pipeline_item_id, old.pipeline_item_id);
  update public.pipeline_items
     set next_action_at = (select min(due_at) from public.pipeline_touches where pipeline_item_id = _item and status = 'scheduled'),
         updated_at = now()
   where id = _item;
  return null;
end; $$;

drop trigger if exists pipeline_touches_recompute on public.pipeline_touches;
create trigger pipeline_touches_recompute
  after insert or update or delete on public.pipeline_touches
  for each row execute function public.pipeline_touch_recompute_next();

comment on table public.pipeline_sequences is 'User-built follow-up sequences (franchise-owned). Assigning an item seeds pipeline_touches from the steps. One may be the auto-default per item type. Via crewlogic-pipeline.';
comment on table public.pipeline_sequence_steps is 'Ordered steps of a sequence: delay (value+unit) + channel + optional email/text template (subject/body with merge fields). Via crewlogic-pipeline.';

-- ── ROLLBACK (manual): alter table pipeline_touches drop column sequence_step_id; alter table pipeline_items drop column sequence_id; drop table pipeline_sequence_steps; drop table pipeline_sequences;
