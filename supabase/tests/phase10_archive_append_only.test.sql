-- Behavioural test for migration 044: no API role can rewrite or empty the archive.
\set ON_ERROR_STOP on

do $$
declare r text;
begin
  foreach r in array array['service_role', 'anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.transactions_archive', 'UPDATE')
       or has_table_privilege(r, 'public.transactions_archive', 'TRUNCATE')
       or has_table_privilege(r, 'public.transactions_archive', 'DELETE') then
      raise exception '044: % can still change or empty the archive', r;
    end if;
  end loop;
  if not has_table_privilege('service_role', 'public.transactions_archive', 'INSERT')
     or not has_table_privilege('service_role', 'public.transactions_archive', 'SELECT') then
    raise exception '044: the monthly run can no longer write or read the archive';
  end if;
  raise notice 'ok  044 archive is append-only for every API role';
end $$;

-- ── 044: the monthly run's re-send still works without UPDATE ───────────────
-- report.ts archives with upsert(..., { ignoreDuplicates: true }), which PostgREST sends as
-- INSERT ... ON CONFLICT DO NOTHING. That must not need UPDATE.
begin;
set role service_role;
do $$
declare n int;
begin
  for i in 1..2 loop
    insert into transactions_archive (id, member_id, company_id, item_id, quantity, logged_at, report_month)
      values ('00000000-0000-0000-0000-0000000a0044', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
              1, now(), '2026-11')
      on conflict (id, report_month) do nothing;
  end loop;
  select count(*) into n from transactions_archive where id = '00000000-0000-0000-0000-0000000a0044';
  if n <> 1 then raise exception '044: expected one archived row after a re-send, found %', n; end if;
  raise notice 'ok  044 re-sending a month still archives without UPDATE';
end $$;
reset role;
rollback;
