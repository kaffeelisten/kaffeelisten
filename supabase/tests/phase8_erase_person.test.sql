-- scripts/db/erase-person.sql: a dry run changes nothing; a confirmed run leaves
-- no name or email of the person anywhere in the database and keeps every amount.
--
-- The script runs its own transaction, so this test cannot be wrapped in one. It
-- seeds rows with fixed ids, runs the script twice, and removes the rows at the end.

insert into companies (id, name, active, billing_mode, billing_contact_email)
values ('00000000-0000-0000-0000-0000000e0001', 'Erase GmbH', true, 'company_paid', 'office@erase.example.com');

insert into members (id, company_id, name, work_email, kind, active)
values ('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000e0001',
        'Erika Muster', 'erika@erase.example.com', 'person', true);

insert into billing_documents (id, report_month, document_number, recipient_type, recipient_name,
                               recipient_email, company_id, member_id, total_cents, status)
values ('00000000-0000-0000-0000-0000000e0003', '2026-10', 'K-E00001', 'member', 'Erika Muster',
        'erika@erase.example.com', '00000000-0000-0000-0000-0000000e0001',
        '00000000-0000-0000-0000-0000000e0002', 1250, 'sent');

insert into document_deliveries (id, report_month, kind, company_id, member_id, recipient_name,
                                 recipient_email, document_number, billing_document_id,
                                 gross_cents, has_pdf, has_xlsx)
values ('00000000-0000-0000-0000-0000000e0004', '2026-10', 'member_invoice',
        '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0002',
        'Erika Muster', 'erika@erase.example.com', 'K-E00001',
        '00000000-0000-0000-0000-0000000e0003', 1250, true, false),
       -- A company document once addressed to her as the billing contact.
       ('00000000-0000-0000-0000-0000000e0005', '2026-09', 'company_statement',
        '00000000-0000-0000-0000-0000000e0001', null,
        'Erika Muster', 'erika@erase.example.com', null, null, 4000, true, true);

-- 1. Dry run: rolled back, nothing changed.
\set member_id 00000000-0000-0000-0000-0000000e0002
\set confirm false
\ir ../../scripts/db/erase-person.sql

do $$
begin
  if not exists (select 1 from members where id = '00000000-0000-0000-0000-0000000e0002'
                   and name = 'Erika Muster' and active) then
    raise exception 'erase: the dry run changed the member';
  end if;
  raise notice 'ok  erase dry run changes nothing';
end $$;

-- 2. Confirmed run.
\set confirm yes
\ir ../../scripts/db/erase-person.sql

do $$
declare n int;
begin
  select count(*) into n from (
    select name || ' ' || coalesce(work_email, '') as t from members
    union all select recipient_name || ' ' || recipient_email from billing_documents
    union all select recipient_name || ' ' || recipient_email from document_deliveries
  ) x where t ilike '%erika%';
  if n <> 0 then raise exception 'erase: % record(s) still name her', n; end if;

  if not exists (select 1 from members where id = '00000000-0000-0000-0000-0000000e0002'
                   and name = 'Gelöschte Person 00000000' and not active
                   and work_email = 'geloescht-00000000@erased.invalid') then
    raise exception 'erase: the member row is not anonymised as specified';
  end if;

  if (select total_cents from billing_documents where id = '00000000-0000-0000-0000-0000000e0003') <> 1250
     or (select sum(gross_cents) from document_deliveries
          where company_id = '00000000-0000-0000-0000-0000000e0001') <> 5250 then
    raise exception 'erase: an amount changed';
  end if;
  raise notice 'ok  erase leaves no name or email and keeps every amount';
end $$;

-- 3. A second confirmed run is harmless.
\ir ../../scripts/db/erase-person.sql

-- Clean up, so later tests see the database as the migrations left it.
delete from document_deliveries where company_id = '00000000-0000-0000-0000-0000000e0001';
delete from billing_documents   where company_id = '00000000-0000-0000-0000-0000000e0001';
delete from members             where company_id = '00000000-0000-0000-0000-0000000e0001';
delete from companies           where id         = '00000000-0000-0000-0000-0000000e0001';
