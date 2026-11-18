-- US-042 to US-049: folders of global levels, submissions from anyone, authors.
-- Global levels are now standalone copies (no link to anyone's local level) that never change
-- layout once approved; only the admin renames, moves or deletes them, through the api function.

create table public.global_folders (
  id uuid primary key default gen_random_uuid(),
  -- null: the top Global folder
  parent_id uuid references public.global_folders (id),
  name text not null check (char_length(name) between 1 and 60),
  position bigint not null default nextval('public.global_levels_position_seq'),
  created_at timestamptz not null default now()
);

create index global_folders_parent on public.global_folders (parent_id, position);

alter table public.global_levels
  add column folder_id uuid references public.global_folders (id),
  add column author text check (author is null or author ~ '^[A-Z0-9 ._-]{1,8}$');
alter table public.global_levels drop constraint global_levels_source_id_key;
alter table public.global_levels alter column source_id drop not null;

create index global_levels_folder on public.global_levels (folder_id, position);

create table public.level_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  author text not null check (author ~ '^[A-Z0-9 ._-]{1,8}$'),
  data jsonb not null,
  level_hash text not null check (level_hash ~ '^[0-9a-f]{8}$'),
  -- who sent it, only to cap waiting requests per address
  ip text not null,
  created_at timestamptz not null default now()
);

create index level_requests_ip on public.level_requests (ip);

alter table public.global_folders enable row level security;
alter table public.level_requests enable row level security;
create policy "global folders are public" on public.global_folders for select using (true);
-- level_requests has no policies: only the api function (service role) reads or writes it
revoke insert, update, delete on public.global_folders from anon, authenticated;
revoke all on public.level_requests from anon, authenticated;

-- ordering is now per folder, by dragging
drop function public.move_global_level(uuid, integer);

-- Puts a level or folder into target_folder (null: the top), just before before_id
-- (null or not in that folder: at the end), renumbering that folder's items of the same kind.
create function public.place_global_item(item_kind text, item_id uuid, target_folder uuid, before_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cur uuid;
  ids uuid[];
  i integer;
begin
  lock table public.global_folders in share row exclusive mode;
  lock table public.global_levels in share row exclusive mode;
  if target_folder is not null and not exists (select 1 from global_folders where id = target_folder) then
    raise exception 'not found: folder';
  end if;
  if item_kind = 'folder' then
    if not exists (select 1 from global_folders where id = item_id) then
      raise exception 'not found: item';
    end if;
    cur := target_folder;
    while cur is not null loop
      if cur = item_id then
        raise exception 'cycle: a folder cannot go inside itself';
      end if;
      select parent_id into cur from global_folders where id = cur;
    end loop;
    update global_folders set parent_id = target_folder where id = item_id;
    select array_agg(id order by position, id) into ids from global_folders
    where parent_id is not distinct from target_folder and id <> item_id;
  elsif item_kind = 'level' then
    if not exists (select 1 from global_levels where id = item_id) then
      raise exception 'not found: item';
    end if;
    update global_levels set folder_id = target_folder where id = item_id;
    select array_agg(id order by position, id) into ids from global_levels
    where folder_id is not distinct from target_folder and id <> item_id;
  else
    raise exception 'bad kind';
  end if;
  ids := coalesce(ids, '{}');
  i := case when before_id is null then null else array_position(ids, before_id) end;
  if i is null then
    ids := ids || item_id;
  else
    ids := ids[1:i - 1] || item_id || ids[i:];
  end if;
  if item_kind = 'folder' then
    update global_folders g set position = t.ord from unnest(ids) with ordinality as t(id, ord) where g.id = t.id;
  else
    update global_levels g set position = t.ord from unnest(ids) with ordinality as t(id, ord) where g.id = t.id;
  end if;
end;
$$;

-- Deletes a folder; whatever was in it moves up to its parent.
create function public.delete_global_folder(folder uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  up uuid;
begin
  lock table public.global_folders in share row exclusive mode;
  lock table public.global_levels in share row exclusive mode;
  select parent_id into up from global_folders where id = folder;
  if not found then
    return false;
  end if;
  update global_levels set folder_id = up where folder_id = folder;
  update global_folders set parent_id = up where parent_id = folder;
  delete from global_folders where id = folder;
  return true;
end;
$$;

-- Turns a request into a global level at the bottom of the top folder, with an empty leaderboard.
create function public.approve_level_request(request uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  insert into global_levels (name, data, level_hash, author, folder_id)
  select name, data, level_hash, author, null from level_requests where id = request
  returning id into new_id;
  if new_id is null then
    return null;
  end if;
  delete from level_requests where id = request;
  return new_id;
end;
$$;

revoke all on function public.place_global_item(text, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.delete_global_folder(uuid) from public, anon, authenticated;
revoke all on function public.approve_level_request(uuid) from public, anon, authenticated;
grant execute on function public.place_global_item(text, uuid, uuid, uuid) to service_role;
grant execute on function public.delete_global_folder(uuid) to service_role;
grant execute on function public.approve_level_request(uuid) to service_role;
