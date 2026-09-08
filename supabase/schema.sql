-- Break Monitor uses two tables: coworkers (staff) and breaks.
-- Run this in the Supabase SQL editor if the app cannot read/write, or if
-- removing a coworker fails with:
--   23503 / breaks_coworker_id_fkey
--   "Key (id)=(…) is still referenced from table breaks"
-- That error means Postgres will not delete a coworker while break rows still
-- point at them. PostgREST can also report DELETE as success with 0 rows when
-- row-level security allows SELECT but not DELETE.

-- ---------------------------------------------------------------------------
-- RLS + grants (anon / authenticated keys need this; service_role bypasses RLS)
-- ---------------------------------------------------------------------------
alter table public.breaks enable row level security;
alter table public.coworkers enable row level security;

drop policy if exists break_monitor_breaks_all on public.breaks;
create policy break_monitor_breaks_all on public.breaks
  for all using (true) with check (true);

drop policy if exists break_monitor_coworkers_all on public.coworkers;
create policy break_monitor_coworkers_all on public.coworkers
  for all using (true) with check (true);

grant select, insert, update, delete on public.breaks to anon, authenticated, service_role;
grant select, insert, update, delete on public.coworkers to anon, authenticated, service_role;
grant usage, select on all sequences in schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Leave for the day sets coworkers.active = false. Back on shift sets it true.
-- ---------------------------------------------------------------------------
alter table public.coworkers add column if not exists active boolean not null default true;

-- During a break, staff mark whether they left the room.
alter table public.breaks add column if not exists is_room_leaved boolean default false;

-- ---------------------------------------------------------------------------
-- Deleting a coworker must also drop their breaks (FK currently has no CASCADE).
-- ---------------------------------------------------------------------------
alter table public.breaks drop constraint if exists breaks_coworker_id_fkey;
alter table public.breaks
  add constraint breaks_coworker_id_fkey
  foreign key (coworker_id) references public.coworkers (id)
  on delete cascade;

-- ---------------------------------------------------------------------------
-- RPC used by the app as a fallback: deletes breaks then the coworker even if
-- table RLS is misconfigured (SECURITY DEFINER runs as the function owner).
-- ---------------------------------------------------------------------------
create or replace function public.remove_coworker_cascade(target_id bigint)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
begin
  delete from public.breaks where coworker_id = target_id;
  get diagnostics n = row_count;
  delete from public.coworkers where id = target_id;
  return json_build_object('breaksRemoved', n);
end;
$$;

grant execute on function public.remove_coworker_cascade(bigint) to anon, authenticated, service_role;
