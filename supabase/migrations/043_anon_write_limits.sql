-- Migration 043: rate limits on what the public API can write, and no member RPCs for
-- signed-in users.
--
-- deploy: pre
--
-- The tablet has no login by design, and the anon key ships in the bundle, so anyone who
-- has an instance's address can call the member RPCs from a script. Each RPC checks what
-- one call may do (known, active member and items; quantities 1–99; the per-order cap),
-- but nothing bounded how many calls arrive:
--   * orders logged against any member, whose ids the name picker exposes, inflate that
--     person's monthly bill;
--   * mass self-registration fills the roster, and every registered address receives the
--     monthly statement, spending the instance's mail quota on addresses nobody chose.
--
-- How it is limited (reviewed independently before it shipped; the first draft counted
-- rows, only for anon, and could be emptied by undo to lock a person out unseen):
--   * Every caller is limited except the service role and a direct owner connection
--     (migrations, scripts/db/*.sql). Supabase Auth sign-ups would otherwise arrive as
--     `authenticated` with no limit, so the member RPCs are revoked from that role too:
--     the app uses no Supabase Auth.
--   * Orders count UNITS (the sum of quantities) per member per 10 minutes, once per call:
--     60 for a person, 300 for a company's shared account. Undoing an order gives its
--     units back, so undo cannot be used to lock someone out without a trace; logging
--     against someone leaves the entries on their bill, where the administration sees and
--     removes them.
--   * Self-registration counts 30 people per company per hour, and 200 per hour across the
--     instance, so fake sign-ups spread over many companies stay bounded too.
--   * No campus-wide counter on orders: one that a stranger can fill would stop everyone
--     from logging. Filling the registration cap only delays new people by an hour.
-- Past a limit the call fails with `rate_limited` and changes nothing; the tablet says to
-- try again in a few minutes. The service role may read and delete counters, so an
-- administrator can lift a limit early.
--
-- Additive except the revoke from `authenticated`, which no part of the app uses.

create table if not exists public.anon_write_throttle (
  key          text primary key,        -- "tx:m:<member uuid>", "reg:c:<company uuid>" or "reg:all"
  window_start timestamptz not null default now(),
  hits         integer not null default 0
);
comment on table public.anon_write_throttle is
  'Fixed-window counters for public-API writes (migration 043). Written only by the limit triggers; the service role may read and delete rows to lift a limit.';
alter table public.anon_write_throttle enable row level security;   -- no policies
revoke all on public.anon_write_throttle from anon, authenticated, service_role;
grant select, delete on public.anon_write_throttle to service_role;

-- True unless the request is the service role or a direct owner connection. PostgREST sets
-- the JWT claims and the role from the verified token; SECURITY DEFINER changes
-- current_user but neither of these. A connection with neither setting is the owner.
create or replace function public.request_is_limited()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
      nullif(current_setting('role', true), 'none')
    ) not in ('service_role', 'postgres', 'supabase_admin'),
    false
  );
$$;
revoke all on function public.request_is_limited() from public, anon, authenticated, service_role;

-- Add p_amount to p_key's window (negative to give back) and refuse past p_limit.
create or replace function public.anon_write_hit(p_key text, p_amount int, p_limit int, p_window interval)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hits int;
begin
  insert into anon_write_throttle as t (key, window_start, hits)
    values (p_key, now(), greatest(p_amount, 0))
  on conflict (key) do update
    set hits         = case when t.window_start < now() - p_window then greatest(p_amount, 0)
                            else greatest(t.hits + p_amount, 0) end,
        window_start = case when t.window_start < now() - p_window then now() else t.window_start end
  returning hits into v_hits;
  if p_amount > 0 and v_hits > p_limit then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.anon_write_hit(text, int, int, interval) from public, anon, authenticated, service_role;

-- One call of an order RPC is one INSERT statement, so a statement trigger counts per call.
create or replace function public.limit_transaction_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  if not request_is_limited() then
    return null;
  end if;
  for r in
    select n.member_id, sum(n.quantity)::int as units, bool_or(m.kind = 'house') as house
      from new_rows n join members m on m.id = n.member_id
     group by n.member_id
  loop
    perform anon_write_hit('tx:m:' || r.member_id, r.units,
                           case when r.house then 300 else 60 end, interval '10 minutes');
  end loop;
  return null;
end;
$$;

create or replace function public.limit_transaction_undo()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  if not request_is_limited() then
    return null;
  end if;
  for r in select member_id, sum(quantity)::int as units from old_rows group by member_id loop
    perform anon_write_hit('tx:m:' || r.member_id, -r.units, 0, interval '10 minutes');
  end loop;
  return null;
end;
$$;

create or replace function public.limit_member_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  if not request_is_limited() then
    return null;
  end if;
  for r in select company_id, count(*)::int as people from new_rows group by company_id loop
    perform anon_write_hit('reg:c:' || r.company_id, r.people, 30, interval '1 hour');
    perform anon_write_hit('reg:all', r.people, 200, interval '1 hour');
  end loop;
  return null;
end;
$$;

revoke all on function public.limit_transaction_insert() from public, anon, authenticated, service_role;
revoke all on function public.limit_transaction_undo()   from public, anon, authenticated, service_role;
revoke all on function public.limit_member_insert()      from public, anon, authenticated, service_role;

drop trigger if exists limit_transaction_insert on public.transactions;
create trigger limit_transaction_insert
  after insert on public.transactions
  referencing new table as new_rows
  for each statement execute function public.limit_transaction_insert();

drop trigger if exists limit_transaction_undo on public.transactions;
create trigger limit_transaction_undo
  after delete on public.transactions
  referencing old table as old_rows
  for each statement execute function public.limit_transaction_undo();

drop trigger if exists limit_member_insert on public.members;
create trigger limit_member_insert
  after insert on public.members
  referencing new table as new_rows
  for each statement execute function public.limit_member_insert();

-- The app has no Supabase Auth users; a sign-up through /auth/v1 must not reach the member RPCs.
revoke execute on function public.log_order(uuid, jsonb)            from authenticated;
revoke execute on function public.log_company_order(uuid, jsonb)    from authenticated;
revoke execute on function public.undo_order(uuid[])                from authenticated;
revoke execute on function public.register_member(uuid, text, text) from authenticated;
