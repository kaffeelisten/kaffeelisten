-- Erase one person from a Kaffeelisten database: name and email are replaced in
-- every record that holds them; every amount stays, attached to an anonymous id.
--
-- Run it as the DATABASE OWNER (postgres), never through the API. The API role
-- cannot do this on purpose: UPDATE on document_deliveries is revoked from
-- service_role (migration 037), and the ledgers are append-only for the app.
--
--   psql "$OWNER_DB_URL" -v member_id=<uuid> -f scripts/db/erase-person.sql
--       shows what would change, then rolls back (the default: a dry run)
--
--   psql "$OWNER_DB_URL" -v member_id=<uuid> -v confirm=yes -f scripts/db/erase-person.sql
--       does it and commits
--
-- What changes, in one transaction:
--   members              name -> 'Gelöschte Person <first 8 of id>'
--                        work_email -> 'geloescht-<first 8 of id>@erased.invalid'
--                        email verification cleared, active = false
--   billing_documents    recipient_name / recipient_email snapshots of the person's
--   document_deliveries  documents, and of company documents addressed to the
--                        person's email (a billing contact)
--
-- What stays: transactions, transactions_archive, member_payments, document
-- numbers and every amount. They hold the member id, never a name or an email,
-- and a regenerated document now reads the anonymised name.
--
-- It refuses, and changes nothing, when:
--   - the id is not a person (a company house account is not a person)
--   - the email is still a company's billing contact, a report recipient or the
--     CC address in app_settings. Those are the client's own settings: the client
--     names a replacement, it is changed in the admin area, then this is rerun.
--
-- Outside the database, and not this script's job: Resend's logs and the
-- provider backups expire on their own schedules (AVV Additional clause 4).

\set ON_ERROR_STOP on

\if :{?member_id}
\else
  \echo 'usage: psql <owner url> -v member_id=<uuid> [-v confirm=yes] -f scripts/db/erase-person.sql'
  \quit
\endif

\if :{?confirm}
\else
  \set confirm false
\endif

begin;

select set_config('kl.erase_member_id', :'member_id', true);

do $$
declare
  v_id       uuid := current_setting('kl.erase_member_id')::uuid;
  v_member   public.members%rowtype;
  v_tag      text;
  v_name     text;
  v_email    text;
  v_hits     text;
  n_members  int;
  n_billing  int;
  n_delivery int;
begin
  select * into v_member from public.members where id = v_id for update;
  if not found then
    raise exception 'erase: no member with id %', v_id;
  end if;
  if v_member.kind <> 'person' then
    raise exception 'erase: % is a % account, not a person', v_id, v_member.kind;
  end if;

  v_tag   := left(v_id::text, 8);
  v_name  := 'Gelöschte Person ' || v_tag;
  v_email := 'geloescht-' || v_tag || '@erased.invalid';

  if v_member.work_email = v_email then
    raise notice 'erase: % is already erased; nothing to do', v_id;
    return;
  end if;

  -- The client's own settings must stop naming this address first, or the next
  -- monthly run sends to it again.
  select string_agg(where_found, '; ') into v_hits from (
    select 'billing contact of company ' || c.name as where_found
      from public.companies c
     where lower(c.billing_contact_email) = lower(v_member.work_email)
    union all
    select 'report recipient in app_settings'
      from public.app_settings s
     where exists (select 1 from unnest(s.report_recipients) r
                    where lower(btrim(r)) = lower(v_member.work_email))
    union all
    select 'CC address in app_settings'
      from public.app_settings s
     where lower(s.ceo_email) = lower(v_member.work_email)
  ) h;
  if v_hits is not null then
    raise exception 'erase: % is still used as: %. Change it in the admin area first, then rerun.',
      v_member.work_email, v_hits;
  end if;

  update public.billing_documents
     set recipient_name = v_name, recipient_email = v_email
   where member_id = v_id
      or (member_id is null and lower(recipient_email) = lower(v_member.work_email));
  get diagnostics n_billing = row_count;

  update public.document_deliveries
     set recipient_name = v_name, recipient_email = v_email
   where member_id = v_id
      or (member_id is null and lower(recipient_email) = lower(v_member.work_email));
  get diagnostics n_delivery = row_count;

  update public.members
     set name                    = v_name,
         work_email              = v_email,
         email_verified_at       = null,
         email_verify_token_hash = null,
         email_verify_expires_at = null,
         active                  = false
   where id = v_id;
  get diagnostics n_members = row_count;

  raise notice 'erase: member % -> "%": members %, billing_documents %, document_deliveries %',
    v_id, v_name, n_members, n_billing, n_delivery;
end $$;

-- Proof, inside the transaction: nothing left that names the old person.
select id, name, work_email, active from public.members where id = :'member_id';

\if :confirm
  commit;
  \echo 'erase: committed'
\else
  rollback;
  \echo 'erase: dry run, rolled back. Rerun with -v confirm=yes to commit.'
\endif
