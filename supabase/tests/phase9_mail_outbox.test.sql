-- Migration 043: the mail outbox is service-role only and keeps its history.
-- Self-contained and rolled back.

begin;

set role service_role;

do $$
declare
  v_id uuid;
begin
  insert into mail_outbox (idempotency_key, report_month, purpose, recipient, payload, reason, next_attempt_at)
  values ('member-2099-01-m1', '2099-01', 'document', 'a@example.com', '{"subject":"x"}', 'daily_quota', now())
  returning id into v_id;

  update mail_outbox
     set status = 'sent', sent_at = now(), payload = null, resend_message_id = 'msg-043'
   where id = v_id;
  if (select status from mail_outbox where id = v_id) <> 'sent' then
    raise exception '043: service_role could not mark an outbox row sent';
  end if;

  begin
    delete from mail_outbox where id = v_id;
    raise exception '043: service_role can delete outbox rows';
  exception when insufficient_privilege then null;
  end;

  insert into report_runs (report_month, status) values ('2099-02', 'queued');
  update report_runs set status = 'completed', completed_at = now() where report_month = '2099-02';
  raise notice 'ok  043 service_role queues, sends and cannot delete; runs may be queued';
end $$;

reset role;

do $$
begin
  if has_table_privilege('anon', 'public.mail_outbox', 'select')
     or has_table_privilege('authenticated', 'public.mail_outbox', 'select') then
    raise exception '043: the public key can read the mail outbox';
  end if;
  if has_table_privilege('anon', 'public.mail_outbox', 'insert')
     or has_table_privilege('authenticated', 'public.mail_outbox', 'update') then
    raise exception '043: the public key can write the mail outbox';
  end if;
  raise notice 'ok  043 the public key cannot touch the mail outbox';
end $$;

set role anon;

do $$
begin
  begin
    perform 1 from mail_outbox;
    raise exception '043: anon can read the mail outbox';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok  043 anon is refused';
end $$;

reset role;

do $$
begin
  begin
    insert into mail_outbox (idempotency_key, purpose, recipient, payload, reason, next_attempt_at)
    values ('dup-043', 'document', 'b@example.com', '{}', 'daily_quota', now());
    insert into mail_outbox (idempotency_key, purpose, recipient, payload, reason, next_attempt_at)
    values ('dup-043', 'document', 'b@example.com', '{}', 'daily_quota', now());
    raise exception '043: one idempotency key was queued twice';
  exception when unique_violation then null;
  end;
  begin
    insert into mail_outbox (idempotency_key, purpose, recipient, payload, reason, next_attempt_at)
    values ('empty-043', 'document', 'c@example.com', null, 'daily_quota', now());
    raise exception '043: a queued row without a payload was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into mail_outbox (idempotency_key, purpose, recipient, payload, reason, next_attempt_at)
    values ('reason-043', 'document', 'c@example.com', '{}', 'rate_limit', now());
    raise exception '043: a rate limit was accepted as a quota reason';
  exception when check_violation then null;
  end;
  begin
    insert into report_runs (report_month, status) values ('2099-03', 'paused');
    raise exception '043: unknown run status accepted';
  exception when check_violation then null;
  end;
  raise notice 'ok  043 constraints';
end $$;

rollback;
