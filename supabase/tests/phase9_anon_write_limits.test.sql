-- Behavioural tests for migration 043: public-API writes are rate-limited by units per call,
-- undo gives units back, signed-in users cannot reach the member RPCs, and the service role
-- and the owner are never limited. One transaction, rolled back; now() is fixed, so window
-- expiry is tested by moving a window back by hand.
\set ON_ERROR_STOP on

begin;

insert into app_settings (id) values (1) on conflict (id) do nothing;
update app_settings set max_items_per_order = null where id = 1;
insert into companies (id, name, active, billing_mode, checkout_mode) values
  ('00000000-0000-0000-0000-00000000c901', 'Limitco', true, 'individual',   'member'),
  ('00000000-0000-0000-0000-00000000c902', 'Housco',  true, 'company_paid', 'company');
insert into companies (id, name, active, billing_mode, checkout_mode)
  select ('00000000-0000-0000-0000-0000000c9' || lpad(g::text, 3, '0'))::uuid, 'Spread ' || g, true, 'individual', 'member'
    from generate_series(10, 20) g;
insert into members (id, company_id, name, work_email, kind) values
  ('00000000-0000-0000-0000-00000000a901', '00000000-0000-0000-0000-00000000c901', 'Ada',  'ada@limit.co', 'person'),
  ('00000000-0000-0000-0000-00000000a902', '00000000-0000-0000-0000-00000000c901', 'Bo',   'bo@limit.co',  'person'),
  ('00000000-0000-0000-0000-00000000a903', '00000000-0000-0000-0000-00000000c902', 'Haus', null,           'house');
insert into items (id, name, price_cents, category, active) values
  ('00000000-0000-0000-0000-00000000e901', 'Espresso', 50, 'coffee', true),
  ('00000000-0000-0000-0000-00000000e902', 'Wasser',   99, 'drink',  true);
delete from anon_write_throttle;

create temp table t9 (name text primary key, ids uuid[]) on commit drop;
grant all on t9 to anon;

-- ── 043: privileges ──────────────────────────────────────────────────────────
do $$
begin
  if has_table_privilege('anon', 'public.anon_write_throttle', 'SELECT')
     or has_table_privilege('authenticated', 'public.anon_write_throttle', 'SELECT')
     or has_table_privilege('service_role', 'public.anon_write_throttle', 'UPDATE') then
    raise exception '043: an API role can read or change the counters';
  end if;
  if not has_table_privilege('service_role', 'public.anon_write_throttle', 'DELETE') then
    raise exception '043: the service role cannot lift a limit';
  end if;
  if has_function_privilege('anon', 'public.anon_write_hit(text, int, int, interval)', 'EXECUTE') then
    raise exception '043: anon can call anon_write_hit directly';
  end if;
  if has_function_privilege('authenticated', 'public.log_order(uuid, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.register_member(uuid, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.log_company_order(uuid, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.undo_order(uuid[])', 'EXECUTE') then
    raise exception '043: a signed-in user can still call a member RPC';
  end if;
  raise notice 'ok  043 counters out of reach; member RPCs closed to signed-in users';
end $$;

-- ── 043: who is limited ──────────────────────────────────────────────────────
do $$
begin
  if request_is_limited() then raise exception '043: a direct owner connection is limited'; end if;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if request_is_limited() then raise exception '043: the service role is limited'; end if;
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  if not request_is_limited() then raise exception '043: a signed-in user is not limited'; end if;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  if not request_is_limited() then raise exception '043: anon is not limited'; end if;
  perform set_config('request.jwt.claims', '', true);
  raise notice 'ok  043 anon and signed-in users are limited; service role and owner are not';
end $$;

set role anon;

-- ── 043: 60 units per person per window, counted per call ────────────────────
do $$
begin
  -- One call over the limit is refused whole.
  begin
    perform log_order('00000000-0000-0000-0000-00000000a901',
      '[{"item_id":"00000000-0000-0000-0000-00000000e901","quantity":41},{"item_id":"00000000-0000-0000-0000-00000000e902","quantity":29}]');
    raise exception '043: a single 70-unit call was accepted';
  exception when others then
    if sqlerrm <> 'rate_limited' then raise; end if;
  end;
  -- 60 units in two calls, then the next unit is refused.
  perform log_order('00000000-0000-0000-0000-00000000a901',
    '[{"item_id":"00000000-0000-0000-0000-00000000e901","quantity":30},{"item_id":"00000000-0000-0000-0000-00000000e902","quantity":20}]');
  perform log_order('00000000-0000-0000-0000-00000000a901',
    '[{"item_id":"00000000-0000-0000-0000-00000000e901","quantity":10}]');
  begin
    perform log_order('00000000-0000-0000-0000-00000000a901',
      '[{"item_id":"00000000-0000-0000-0000-00000000e901","quantity":1}]');
    raise exception '043: unit 61 for one person was accepted';
  exception when others then
    if sqlerrm <> 'rate_limited' then raise; end if;
  end;

  -- Another person is unaffected.
  perform log_order('00000000-0000-0000-0000-00000000a902',
    '[{"item_id":"00000000-0000-0000-0000-00000000e901","quantity":5}]');
  raise notice 'ok  043 60 units per person, per call, refused calls leave nothing';
end $$;

-- ── 043: undo gives the units back, so it cannot lock anyone out ─────────────
do $$
declare v_ids uuid[]; n int;
begin
  v_ids := log_order('00000000-0000-0000-0000-00000000a902',
    '[{"item_id":"00000000-0000-0000-0000-00000000e901","quantity":55}]');
  n := undo_order(v_ids);
  if n <> 1 then raise exception '043: undo removed % row(s), expected 1', n; end if;
  -- 5 units remain from the block above; 55 more must fit after the undo.
  perform log_order('00000000-0000-0000-0000-00000000a902',
    '[{"item_id":"00000000-0000-0000-0000-00000000e901","quantity":55}]');
  raise notice 'ok  043 undo returns its units';
end $$;

-- ── 043: a company's shared account has its own, higher limit ────────────────
do $$
begin
  for i in 1..3 loop
    perform log_company_order('00000000-0000-0000-0000-00000000c902',
      '[{"item_id":"00000000-0000-0000-0000-00000000e901","quantity":99}]');
  end loop;
  begin
    perform log_company_order('00000000-0000-0000-0000-00000000c902',
      '[{"item_id":"00000000-0000-0000-0000-00000000e901","quantity":4}]');
    raise exception '043: unit 301 on a shared account was accepted';
  exception when others then
    if sqlerrm <> 'rate_limited' then raise; end if;
  end;
  raise notice 'ok  043 shared account stops at 300 units';
end $$;

-- ── 043: 30 self-registrations per company per hour ──────────────────────────
do $$
begin
  for i in 1..30 loop
    perform register_member('00000000-0000-0000-0000-00000000c901', 'Person ' || i, 'p' || i || '@limit.co');
  end loop;
  begin
    perform register_member('00000000-0000-0000-0000-00000000c901', 'Person 31', 'p31@limit.co');
    raise exception '043: registration 31 into one company was accepted';
  exception when others then
    if sqlerrm <> 'rate_limited' then raise; end if;
  end;
  raise notice 'ok  043 self-registration stops at 30 per company';
end $$;

-- ── 043: 200 self-registrations per hour across the instance ─────────────────
do $$
begin
  -- 30 are already counted above; 170 more across other companies fill the cap.
  for i in 1..170 loop
    perform register_member(('00000000-0000-0000-0000-0000000c9' || lpad((10 + i / 25)::text, 3, '0'))::uuid,
                            'Spread ' || i, 's' || i || '@limit.co');
  end loop;
  begin
    perform register_member('00000000-0000-0000-0000-0000000c9020', 'Spread 171', 's171@limit.co');
    raise exception '043: registration 201 across companies was accepted';
  exception when others then
    if sqlerrm <> 'rate_limited' then raise; end if;
  end;
  raise notice 'ok  043 self-registration stops at 200 per hour across companies';
end $$;

reset role;

-- ── 043: the refused 70-unit call left nothing behind ────────────────────────
do $$
declare n int;
begin
  select count(*) into n from transactions where quantity in (41, 29);
  if n <> 0 then raise exception '043: a refused call left % row(s)', n; end if;
  raise notice 'ok  043 a refused call writes nothing';
end $$;

-- ── 043: a window that has passed starts again ───────────────────────────────
update anon_write_throttle set window_start = now() - interval '11 minutes'
 where key = 'tx:m:00000000-0000-0000-0000-00000000a901';
set role anon;
do $$
begin
  perform log_order('00000000-0000-0000-0000-00000000a901',
    '[{"item_id":"00000000-0000-0000-0000-00000000e901","quantity":60}]');
  raise notice 'ok  043 an expired window resets';
end $$;
reset role;

-- ── 043: the administration and the owner are never limited ─────────────────
do $$
declare n int;
begin
  for i in 1..5 loop
    insert into transactions (member_id, company_id, item_id, quantity, unit_price_cents)
      values ('00000000-0000-0000-0000-00000000a901', '00000000-0000-0000-0000-00000000c901',
              '00000000-0000-0000-0000-00000000e901', 99, 50);
  end loop;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into members (company_id, name, work_email, kind)
    select '00000000-0000-0000-0000-00000000c901', 'Admin ' || g, 'admin' || g || '@limit.co', 'person'
      from generate_series(1, 40) g;
  perform set_config('request.jwt.claims', '', true);
  select count(*) into n from members where work_email like 'admin%@limit.co';
  if n <> 40 then raise exception '043: expected 40 admin-added members, found %', n; end if;
  raise notice 'ok  043 service-side writes pass the limits';
end $$;

rollback;
