-- RLS policies — every row belongs to one user (auth.uid()).

-- profiles
create policy "profiles_select_self"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles_update_self"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "profiles_insert_self"
  on public.profiles for insert
  with check (auth.uid() = id);

-- Generic policy template applied to user-scoped tables.
do $$
declare
  t text;
begin
  for t in select unnest(array[
    'modes','app_mappings','vocabulary','transcriptions','user_settings'
  ]) loop
    execute format($p$
      create policy "%1$s_select_own" on public.%1$s
        for select using (auth.uid() = user_id);
    $p$, t);
    execute format($p$
      create policy "%1$s_insert_own" on public.%1$s
        for insert with check (auth.uid() = user_id);
    $p$, t);
    execute format($p$
      create policy "%1$s_update_own" on public.%1$s
        for update using (auth.uid() = user_id)
        with check (auth.uid() = user_id);
    $p$, t);
    execute format($p$
      create policy "%1$s_delete_own" on public.%1$s
        for delete using (auth.uid() = user_id);
    $p$, t);
  end loop;
end$$;

-- Helpful indexes per plan §17.
create index transcriptions_user_created_idx
  on public.transcriptions (user_id, created_at desc);

create index modes_user_position_idx
  on public.modes (user_id, position);

create index app_mappings_user_exe_idx
  on public.app_mappings (user_id, app_executable);

create index vocabulary_user_term_idx
  on public.vocabulary (user_id, term);
