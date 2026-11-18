-- US-050: blue now keeps building speed (physics version 4). Runs on levels with any blue in them were
-- played with the old blue, so those leaderboards start again. Levels with no blue play exactly the same,
-- and keep their runs (the game still accepts version 3 replays there).
-- Blue is a tile of kind 3 (blue block), a side coloured 3, or a dispenser pouring liquid 1 (blue).
delete from public.runs r
using public.global_levels g
where r.level_id = g.id
  and (
    exists (
      select 1 from jsonb_array_elements(g.data -> 'tiles') t
      where (t ->> 2)::int = 3
         or (jsonb_typeof(t -> 4) = 'array' and exists (select 1 from jsonb_array_elements(t -> 4) s where s::text = '3'))
    )
    or exists (
      select 1 from jsonb_array_elements(g.data -> 'objects') o
      where o ->> 'kind' = 'dispenser' and (o ->> 'liquid')::int = 1
    )
  );
