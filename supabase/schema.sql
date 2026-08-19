-- Break Monitor uses two tables in this project: coworkers (staff) and breaks.
-- This file matches the breaks table you created. Do not create shifts or settings.

-- If the app cannot read/write breaks (empty floor / permission error), run:

alter table public.breaks enable row level security;

drop policy if exists break_monitor_breaks_all on public.breaks;
create policy break_monitor_breaks_all on public.breaks
  for all using (true) with check (true);

grant select, insert, update, delete on public.breaks to anon, authenticated, service_role;
grant usage, select on all sequences in schema public to anon, authenticated, service_role;

-- Leave for the day sets coworkers.active = false. Back on shift sets it true.
alter table public.coworkers add column if not exists active boolean not null default true;

-- During a break, staff mark whether they left the room.
alter table public.breaks add column if not exists is_room_leaved boolean default false;


