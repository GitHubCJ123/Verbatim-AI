-- DB-backed quota guard for Azure-proxy Edge Functions.

create table if not exists public.edge_rate_limits (
  function_name text not null,
  limiter_kind text not null check (limiter_kind in ('user', 'ip')),
  limiter_key text not null,
  window_start timestamptz not null,
  window_seconds integer not null check (window_seconds > 0),
  count integer not null default 1 check (count > 0),
  updated_at timestamptz not null default now(),
  primary key (function_name, limiter_kind, limiter_key, window_start)
);

alter table public.edge_rate_limits enable row level security;

create index if not exists edge_rate_limits_updated_idx
  on public.edge_rate_limits (updated_at);

create or replace function public.check_edge_rate_limit(
  p_function_name text,
  p_limiter_kind text,
  p_limiter_key text,
  p_limit integer,
  p_window_seconds integer
)
returns table (
  allowed boolean,
  remaining integer,
  reset_at timestamptz,
  request_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_count integer;
begin
  if p_function_name is null
    or p_limiter_kind not in ('user', 'ip')
    or p_limiter_key is null
    or p_limit <= 0
    or p_window_seconds <= 0 then
    raise exception 'invalid rate limit arguments';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds
  );

  insert into public.edge_rate_limits (
    function_name,
    limiter_kind,
    limiter_key,
    window_start,
    window_seconds,
    count,
    updated_at
  )
  values (
    p_function_name,
    p_limiter_kind,
    p_limiter_key,
    v_window_start,
    p_window_seconds,
    1,
    v_now
  )
  on conflict (function_name, limiter_kind, limiter_key, window_start)
  do update set
    count = public.edge_rate_limits.count + 1,
    updated_at = excluded.updated_at
  returning count into v_count;

  return query select
    v_count <= p_limit,
    greatest(p_limit - v_count, 0),
    v_window_start + make_interval(secs => p_window_seconds),
    v_count;
end;
$$;

revoke all on table public.edge_rate_limits from public, anon, authenticated;
revoke all on function public.check_edge_rate_limit(text, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.check_edge_rate_limit(text, text, text, integer, integer)
  to service_role;
