-- Stress seed: far more, and far stranger, data than any campus will hold.
--
-- LOCAL ONLY. Run it against the local stack (npm run dev:local -- --no-dev) or a throwaway
-- Postgres built by scripts/test-migrations.sh, never against staging or production:
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54422/postgres" -f supabase/snippets/stress-seed.sql
--
-- Every name, address and amount is invented. It adds to what is there and can be run
-- again; `\set scale 2` before it doubles everything.
--
-- What it holds, and why:
--   * 60 companies across every checkout and billing mode, each with a house account;
--   * 6,000 people whose names cover nine scripts, combining marks, emoji, bidi controls,
--     the maximum length, leading and trailing spaces, and strings an attacker types
--     (HTML, template, SQL, CSV-formula and path injection);
--   * 300 items with prices from 0 to 999,999 cents, units and names in the same mix;
--   * about 150,000 entries this month and 600,000 over the previous twelve, so every read
--     that forgets to page past PostgREST's 1,000-row cap shows up as a wrong total.
-- After loading, use the tablet, the admin panel and a report preview against it, and
-- compare a total with the SQL at the end of this file.

\set ON_ERROR_STOP on
-- The names are UTF-8; Windows psql defaults to WIN1252 when its output is redirected.
\encoding UTF8
\if :{?scale}
\else
  \set scale 1
\endif

begin;

insert into app_settings (id) values (1) on conflict (id) do nothing;

create temp table stress_names (n int primary key, name text) on commit drop;
insert into stress_names (n, name) values
  (0, 'Anna-Lena Müller-Lüdenscheidt'), (1, 'Ødegård Ærø'), (2, 'Łukasz Wójcik-Żółć'),
  (3, 'Zoë O''Brien'), (4, 'van der Berg, Jan'), (5, 'محمد الأحمد'), (6, 'דוד כהן'),
  (7, '张伟'), (8, 'さくら 田中'), (9, '김민준'), (10, 'Νίκος Παπαδόπουλος'),
  (11, 'Тарас Шевченко'), (12, 'Ana' || chr(769) || 'is'), (13, '👩' || chr(8205) || '🔬 Dr. Emoji 🇩🇪'),
  (14, '<script>alert(1)</script>'), (15, '"><img src=x onerror=alert(1)>'),
  (16, '&amp;&lt;&gt;&quot;&#39;'), (17, '${7*7} {{7*7}} #{7*7}'), (18, 'Robert''); DROP TABLE members;--'),
  (19, '=HYPERLINK("http://example.invalid","x")'), (20, '+49 (0) 991 / 123-45'), (21, '../../etc/passwd'),
  (22, chr(8238) || 'evil' || chr(8236)), (23, '   viel   Leerraum   '), (24, 'NULL'), (25, 'undefined'),
  (26, '1e309'), (27, '-0'), (28, '١٢٣٤٥ ٦,٧'), (29, repeat('W', 120));

-- Companies, three checkout modes by two billing modes, and a house account for each.
insert into companies (name, billing_mode, checkout_mode, billing_contact_email, employee_list_enabled)
select left(s.name || ' GmbH & Co. KG ' || g, 120),
       (array['individual', 'company_paid'])[1 + g % 2],
       (array['member', 'company', 'both'])[1 + g % 3],
       'billing' || g || '@stress.example',
       g % 4 = 0
  from generate_series(1, 60 * :scale) g
  join stress_names s on s.n = g % 30;

insert into members (company_id, name, work_email, kind)
select c.id, 'Sammelkonto', null, 'house'
  from companies c
 where c.billing_contact_email like '%@stress.example'
   and not exists (select 1 from members m where m.company_id = c.id and m.kind = 'house');

-- People: up to 120 characters, unique addresses, one in twenty inactive.
with cs as (
  select id, row_number() over (order by id) - 1 as i, count(*) over () as n
    from companies where billing_contact_email like '%@stress.example'
)
insert into members (company_id, name, work_email, kind, active)
select cs.id,
       left(s.name || ' ' || g, 120),
       'person' || g || '.' || md5(g::text)::char(6) || '@stress.example',
       'person',
       g % 20 <> 0
  from generate_series(1, 6000 * :scale) g
  join stress_names s on s.n = g % 30
  join cs on cs.i = g % cs.n;

-- Items: every category, free and absurdly expensive, odd units.
insert into items (name, unit_label, price_cents, category, active)
select left(s.name || ' ' || g, 120),
       (array['Tasse', 'Stück', '0,5 l', '½ Kanne', 'Pck.', '㎖'])[1 + g % 6],
       (array[0, 1, 50, 70, 99, 250, 1999, 999999])[1 + g % 8],
       (array['coffee', 'drink', 'snack', 'food', 'other'])[1 + g % 5],
       g % 15 <> 0
  from generate_series(1, 300 * :scale) g
  join stress_names s on s.n = g % 30;

-- Entries: spread over the last 13 months, none in the future, quantities 1 to 99, price snapshot taken.
create temp table stress_people on commit drop as
  select id, company_id, row_number() over (order by id) - 1 as i
    from members where work_email like '%@stress.example' or (kind = 'house' and company_id in
      (select id from companies where billing_contact_email like '%@stress.example'));
create temp table stress_items on commit drop as
  select id, price_cents, row_number() over (order by id) - 1 as i
    from items where active;

insert into transactions (member_id, company_id, item_id, quantity, unit_price_cents, logged_at)
select p.id, p.company_id, it.id, 1 + (g::bigint * 7919) % 99 % 4 + (case when g % 997 = 0 then 90 else 0 end),
       it.price_cents,
       now() - make_interval(mins => ((g::bigint * 104729) % (395 * 24 * 60))::int)
  from generate_series(1, 750000 * :scale) g
  join stress_people p on p.i = g % (select count(*) from stress_people)
  join stress_items it on it.i = (g::bigint * 31) % (select count(*) from stress_items);

commit;

analyze companies; analyze members; analyze items; analyze transactions;

-- The totals to compare against the app's report and export for this month:
select c.name as company, count(*) as entries, sum(t.quantity) as quantity,
       sum(t.quantity * t.unit_price_cents) as total_cents
  from transactions t join companies c on c.id = t.company_id
 where t.logged_at >= date_trunc('month', now())
 group by c.name order by total_cents desc limit 5;
