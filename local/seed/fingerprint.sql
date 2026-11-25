-- Fingerprint of the mock data (read only): per table the row count and an md5 of every row without its
-- times (timestamp columns, ISO times inside JSON) and without password hashes / token versions, which a
-- new run makes anew; then the marks of the mock id ranges on the sequences («parisa-mock <first>-<last>»).
-- Two runs of wipe_and_seed.py on the same day give the same lines (take it right after the run: the API
-- writes its own rows later, e.g. audit_log on a login). Tables a database does not have are skipped.
--   docker exec -i crm-db psql -U root -d crm_staging -X -q < fingerprint.sql
DO $fp$
DECLARE
  t text;
  cols text;
  n bigint;
  h text;
  total text := '';
BEGIN
  FOR t IN SELECT unnest(ARRAY['group', 'user', 'collection', 'deal_stage', 'setting', 'task_type', 'filler', 'product',
                               'product_filler', 'company', 'company_filler', 'user_filler', 'deal', 'deal_user',
                               'deal_product', 'deal_filler', 'deal_stage_record', 'task', 'notification', 'email',
                               'email_to', 'email_cc', 'email_read', 'recording', 'event', 'messenger_account',
                               'email_transporter', 'bot_account', 'messenger_ignore', 'email_template', 'audit_log',
                               'deal_inbound', 'conversation_review', 'ai_notice', 'market_mention'])
  LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      CONTINUE;
    END IF;
    SELECT string_agg(
             CASE WHEN c.data_type = 'jsonb'
                  THEN format('coalesce(regexp_replace(%I::text, ''[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z'', ''T'', ''g''), ''~'')', c.column_name)
                  ELSE format('coalesce(%I::text, ''~'')', c.column_name) END,
             ' || ''|'' || ' ORDER BY c.ordinal_position)
      INTO cols
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = t
       AND c.data_type NOT LIKE 'timestamp%' AND c.column_name NOT IN ('password', 'token_version');
    EXECUTE format('SELECT count(*), coalesce(md5(string_agg(r, E''\n'' ORDER BY r)), ''-'') FROM (SELECT %s AS r FROM %I) x', cols, t)
      INTO n, h;
    RAISE NOTICE '% % %', rpad(t, 20), lpad(n::text, 6), left(h, 12);
    total := total || h;
  END LOOP;
  SELECT coalesce(md5(string_agg(c.relname || '=' || coalesce(obj_description(c.oid, 'pg_class'), ''), ',' ORDER BY c.relname)), '-'),
         count(*) FILTER (WHERE obj_description(c.oid, 'pg_class') LIKE 'parisa-mock %')
    INTO h, n
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relkind = 'S';
  RAISE NOTICE '% % %', rpad('(id range marks)', 20), lpad(n::text, 6), left(h, 12);
  total := total || h;
  RAISE NOTICE 'mock user ids: %', coalesce(obj_description(to_regclass('public.user_id_seq'), 'pg_class'), '-');
  RAISE NOTICE 'all tables: %', left(md5(total), 12);
END
$fp$;
