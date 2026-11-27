-- Migration 044: the archive is append-only for every API role.
--
-- deploy: pre
--
-- Migration 042 revoked DELETE on transactions_archive, and the privacy page says the
-- administration cannot delete from it. The service role still held TRUNCATE, which empties
-- the table in one statement, and UPDATE, which can rewrite a reported month. Neither is
-- reachable through PostgREST, but both are open to any direct SQL session with the service
-- credentials, and no code uses them: the app only inserts into the archive and reads it.
-- Found by an independent review of migration 043.
--
-- Erasure (scripts/db/erase-person.sql) runs as the owner and does not touch this table:
-- the archive holds member ids, not names.

revoke update, truncate on public.transactions_archive from service_role, anon, authenticated;
