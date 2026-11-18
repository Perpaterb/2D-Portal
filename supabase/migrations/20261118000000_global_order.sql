-- US-040: the admin sets the order everyone sees the global levels in.
-- New levels take the next number from a sequence, so they go to the bottom; a move swaps
-- a level's position with its neighbour's inside one function call.

create sequence public.global_levels_position_seq;

alter table public.global_levels add column position bigint;

-- keep the order people saw before: newest first
update public.global_levels g
set position = s.rn
from (select id, row_number() over (order by updated_at desc, id) as rn from public.global_levels) s
where g.id = s.id;

select setval('public.global_levels_position_seq', coalesce((select max(position) from public.global_levels), 0) + 1, false);

alter table public.global_levels
  alter column position set default nextval('public.global_levels_position_seq'),
  alter column position set not null;

alter sequence public.global_levels_position_seq owned by public.global_levels.position;

create index global_levels_position on public.global_levels (position);

-- step -1 moves the level up the list, +1 down. Returns false at either end or for an unknown id.
create function public.move_global_level(level_id uuid, step integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me_pos bigint;
  other_id uuid;
  other_pos bigint;
begin
  if step not in (-1, 1) then
    raise exception 'step must be -1 or 1';
  end if;
  -- one move at a time, so two quick clicks cannot interleave their swaps
  lock table public.global_levels in share row exclusive mode;
  select position into me_pos from public.global_levels where id = level_id;
  if not found then
    return false;
  end if;
  if step < 0 then
    select id, position into other_id, other_pos from public.global_levels
    where position < me_pos order by position desc limit 1;
  else
    select id, position into other_id, other_pos from public.global_levels
    where position > me_pos order by position asc limit 1;
  end if;
  if other_id is null then
    return false;
  end if;
  update public.global_levels set position = other_pos where id = level_id;
  update public.global_levels set position = me_pos where id = other_id;
  return true;
end;
$$;

-- only the api function (service role) may call it
revoke all on function public.move_global_level(uuid, integer) from public, anon, authenticated;
grant execute on function public.move_global_level(uuid, integer) to service_role;
