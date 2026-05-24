-- User feedback / bug reports.
create table public.feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  email       text,
  rating      smallint check (rating is null or (rating >= 1 and rating <= 5)),
  category    text,
  message     text not null,
  app_version text,
  created_at  timestamptz not null default now()
);

alter table public.feedback enable row level security;

-- Anyone signed in can insert their own row.
create policy "feedback_insert_self"
  on public.feedback for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Users can read back their own submissions (optional, useful for a "my submissions" view later).
create policy "feedback_select_self"
  on public.feedback for select
  to authenticated
  using (auth.uid() = user_id);

create index feedback_created_at_idx on public.feedback (created_at desc);
