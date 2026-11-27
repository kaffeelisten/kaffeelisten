-- Migration 043: an outbox for emails held back by Resend's sending quota.
--
-- deploy: pre
--
-- On Resend's free plan an account may send 100 emails per UTC day and 3,000 per
-- month. Past either limit Resend answers 429 daily_quota_exceeded or
-- monthly_quota_exceeded and does not queue the email itself. The monthly run
-- used to count such a send as failed and still record the month as completed,
-- so documents were silently never delivered.
--
-- 1. mail_outbox: one row per email that hit the quota. It keeps the exact
--    Resend payload and the idempotency key of the original attempt, so a retry
--    after the quota resets sends the same email under the same key and can
--    never deliver a document twice. `on_sent` holds what to record once it
--    goes out (the document_deliveries row, the invoice ledger id, or the
--    report/archive slot on report_runs.progress). The payload is cleared once
--    the email is sent; it carries names, addresses and amounts.
--    service_role may select, insert and update. Nothing deletes from it.
--
-- 2. report_runs.status gains 'queued': the month's documents are issued and
--    archived, but some emails are still waiting in the outbox. The retry marks
--    the run completed once the last one has gone out.

create table if not exists public.mail_outbox (
  id                uuid primary key default gen_random_uuid(),
  idempotency_key   text not null unique check (length(idempotency_key) between 1 and 256),
  report_month      text check (report_month ~ '^\d{4}-\d{2}$'),
  purpose           text not null check (purpose in ('document', 'report', 'archive', 'resend')),
  recipient         text not null,
  payload           jsonb,
  on_sent           jsonb,
  status            text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  reason            text not null check (reason in ('daily_quota', 'monthly_quota')),
  attempts          integer not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz not null,
  last_error        text,
  resend_message_id text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  sent_at           timestamptz,
  -- A waiting email must still have something to send.
  constraint mail_outbox_payload_check check (status <> 'queued' or payload is not null),
  constraint mail_outbox_sent_check check ((status = 'sent') = (sent_at is not null))
);

comment on table public.mail_outbox is
  'Emails held back by the Resend sending quota, retried after it resets under their original idempotency key. Service-role select/insert/update only.';

create index if not exists mail_outbox_due_idx   on public.mail_outbox (next_attempt_at) where status = 'queued';
create index if not exists mail_outbox_month_idx on public.mail_outbox (report_month);

alter table public.mail_outbox enable row level security;
revoke all on public.mail_outbox from anon, authenticated;
grant select, insert, update on public.mail_outbox to service_role;
revoke delete on public.mail_outbox from service_role;

alter table public.report_runs drop constraint if exists report_runs_status_check;
alter table public.report_runs add constraint report_runs_status_check
  check (status in ('running', 'queued', 'completed', 'failed'));
