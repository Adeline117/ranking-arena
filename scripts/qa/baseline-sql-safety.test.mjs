import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BASELINE_SQL_SAFETY_MODES,
  validateAppSchemaSqlSafety,
  validateBaselineSqlSafety,
  validateFoundationSqlSafety,
  validateReplaySqlSafety,
} from './baseline-sql-safety.mjs'

const TOKEN = `${'A1'.repeat(31)}A`

function rejectsApp(source, pattern) {
  assert.throws(() => validateAppSchemaSqlSafety(source), pattern)
}

function acceptsApp(source) {
  assert.doesNotThrow(() => validateAppSchemaSqlSafety(source))
}

test('accepts schema DDL without a restriction envelope', () => {
  const result = validateAppSchemaSqlSafety(`
    CREATE SCHEMA arena;
    CREATE TABLE arena.example (id bigint PRIMARY KEY);
  `)

  assert.deepEqual(result, {
    mode: BASELINE_SQL_SAFETY_MODES.APP_SCHEMA,
    restrictionToken: null,
    statementCount: 2,
  })
  assert.ok(Object.isFrozen(result))
})

test('accepts the 63-character PostgreSQL 17 pg_dump restriction envelope', () => {
  assert.equal(TOKEN.length, 63)
  const result = validateAppSchemaSqlSafety(`-- dump header
\\restrict ${TOKEN}
CREATE SCHEMA arena;
\\unrestrict ${TOKEN}
-- dump footer
`)

  assert.equal(result.restrictionToken, TOKEN)
  assert.equal(result.statementCount, 1)
})

test('accepts an exact restriction envelope with CRLF line endings', () => {
  acceptsApp(
    `-- header\r\n\\restrict ${TOKEN}\r\nCREATE SCHEMA arena;\r\n\\unrestrict ${TOKEN}\r\n`
  )
})

test('rejects malformed, unmatched, duplicated, and misplaced restriction commands', () => {
  const malformed = [
    `\\restrict ${'a'.repeat(62)}\nCREATE SCHEMA arena;\n\\unrestrict ${'a'.repeat(62)}\n`,
    `\\restrict ${'a'.repeat(64)}\nCREATE SCHEMA arena;\n\\unrestrict ${'a'.repeat(64)}\n`,
    ` \\restrict ${TOKEN}\nCREATE SCHEMA arena;\n\\unrestrict ${TOKEN}\n`,
    `\\restrict ${TOKEN} \nCREATE SCHEMA arena;\n\\unrestrict ${TOKEN}\n`,
    `\\restrict ${TOKEN}\nCREATE SCHEMA arena;\n`,
    `\\unrestrict ${TOKEN}\n`,
    `\\restrict ${TOKEN}\nCREATE SCHEMA arena;\n\\unrestrict ${'B'.repeat(63)}\n`,
    `\\restrict ${TOKEN}\n\\restrict ${TOKEN}\n\\unrestrict ${TOKEN}\n`,
    `CREATE SCHEMA before_restrict;\n\\restrict ${TOKEN}\n\\unrestrict ${TOKEN}\n`,
    `\\restrict ${TOKEN}\n\\unrestrict ${TOKEN}\nCREATE SCHEMA after_unrestrict;\n`,
  ]

  for (const source of malformed) rejectsApp(source, /restrict|meta-command/u)
})

test('rejects every other normal-state psql meta-command including inline gexec', () => {
  const sources = [
    '\\i other.sql\n',
    'CREATE TABLE arena.example (id int); \\gexec\n',
    '\\set value trusted\nCREATE SCHEMA arena;\n',
    `\\restrict ${TOKEN}\nCREATE SCHEMA arena;\n\\gexec\n\\unrestrict ${TOKEN}\n`,
  ]

  for (const source of sources) rejectsApp(source, /meta-commands/u)
})

test('ignores backslashes in comments, strings, identifiers, and dollar bodies', () => {
  acceptsApp(String.raw`
    -- \gexec
    /* outer \i file.sql /* nested \set x y */ still a comment */
    CREATE TABLE arena."\gexec" (id int);
    COMMENT ON TABLE arena."\gexec" IS 'ordinary \gexec and ''quoted'' text';
    COMMENT ON TABLE arena."\gexec" IS E'escape-string \'\gexec';
    COMMENT ON TABLE arena."\gexec" IS U&'unicode \005cgexec';
    CREATE FUNCTION arena.meta_text() RETURNS text
      LANGUAGE sql AS $body$ SELECT '\gexec'::text $body$;
  `)
})

test('recognizes a meta-command after an escape string has closed', () => {
  rejectsApp(String.raw`COMMENT ON SCHEMA arena IS E'escaped \\'; \gexec`, /meta-commands/u)
})

test('does not recognize a dollar delimiter after an identifier character', () => {
  rejectsApp(
    'CREATE TABLE public.t (id int DEFAULT 1$body$; INSERT INTO public.t VALUES (1); $body$);',
    /top-level INSERT|unterminated dollar/u
  )
})

test('handles Unicode strings and Unicode quoted identifiers', () => {
  acceptsApp(String.raw`
    CREATE TABLE public.U&"d\0061ta" (id int);
    COMMENT ON TABLE public.U&"d\0061ta" IS U&'d\0061ta' UESCAPE '!';
  `)
})

test('rejects unterminated comments and every supported quoted form', () => {
  const sources = [
    '/* outer /* nested */',
    "COMMENT ON SCHEMA arena IS 'missing",
    "COMMENT ON SCHEMA arena IS E'missing\\",
    'CREATE TABLE "missing (id int);',
    "COMMENT ON SCHEMA arena IS U&'missing",
    'CREATE TABLE U&"missing (id int);',
    'CREATE FUNCTION f() RETURNS void AS $body$ SELECT 1;',
  ]

  for (const source of sources) rejectsApp(source, /unterminated/u)
})

test('does not mistake quoted identifiers or GRANT TRUNCATE for data mutation', () => {
  acceptsApp(`
    CREATE TABLE arena."INSERT INTO" ("DELETE FROM" text);
    GRANT TRUNCATE ON TABLE arena."INSERT INTO" TO authenticated;
  `)
})

test('allows only the exact top-level pg_catalog.set_config select form', () => {
  acceptsApp("SELECT pg_catalog.set_config('search_path', '', false);")
  acceptsApp("select /* exact */ pg_catalog.set_config('search_path', U&'', FALSE);")

  const rejected = [
    'SELECT 1;',
    "SELECT set_config('search_path', '', false);",
    "SELECT pg_catalog.set_config('search_path', '', true);",
    "SELECT pg_catalog.set_config('search_path', '', false), now();",
    "SELECT pg_catalog.set_config('search_path', '', false) FROM pg_catalog.pg_class;",
    "SELECT pg_catalog.set_config('search_path', '', false)::text;",
    "SELECT pg_catalog.set_config('search_path', 'auth', false);",
    "SELECT pg_catalog.set_config('role', 'postgres', false);",
  ]
  for (const source of rejected) rejectsApp(source, /top-level SELECT/u)
})

test('accepts only the exact PostgreSQL 17 schema-only pg_dump SET header', () => {
  acceptsApp(`
    SET statement_timeout = 0;
    SET lock_timeout = 0;
    SET idle_in_transaction_session_timeout = 0;
    SET transaction_timeout = 0;
    SET client_encoding = 'UTF8';
    SET standard_conforming_strings = on;
    SET check_function_bodies = false;
    SET xmloption = content;
    SET client_min_messages = warning;
    SET row_security = off;
    SET default_table_access_method = heap;
    SET default_tablespace = '';
  `)
})

test('rejects direct data and execution statement heads despite comments and casing', () => {
  const sources = [
    'INSERT /* split */ INTO arena.example VALUES (1);',
    'update arena.example SET id = 2;',
    'DELETE FROM arena.example;',
    'MERGE INTO arena.example USING arena.other ON false WHEN NOT MATCHED THEN DO NOTHING;',
    'TRUNCATE TABLE arena.example;',
    'COPY arena.example FROM STDIN;',
    'DO $$ BEGIN NULL; END $$;',
    'CALL arena.rebuild();',
    'WITH changed AS (DELETE FROM arena.example RETURNING *) SELECT * FROM changed;',
    'VALUES (1);',
  ]

  for (const source of sources) rejectsApp(source, /forbidden/u)
})

test('rejects parenthesized and wrapped top-level queries', () => {
  const sources = [
    '(SELECT 1);',
    'TABLE arena.example;',
    'EXPLAIN SELECT * FROM arena.example;',
    'PREPARE read_example AS SELECT * FROM arena.example;',
    'EXECUTE read_example;',
    'DECLARE examples CURSOR FOR SELECT * FROM arena.example;',
  ]

  for (const source of sources) rejectsApp(source, /safe SQL statement head|execute a query/u)
})

test('rejects CREATE TABLE AS but allows AS inside a generated column', () => {
  rejectsApp(
    'CREATE UNLOGGED TABLE arena.copy AS SELECT * FROM arena.example WITH NO DATA;',
    /CREATE TABLE AS/u
  )
  acceptsApp(`
    CREATE TABLE arena.generated_example (
      source_value int,
      derived_value int GENERATED ALWAYS AS (source_value + 1) STORED
    );
  `)
})

test('materialized views must be declared WITH NO DATA and cannot be refreshed', () => {
  acceptsApp('CREATE MATERIALIZED VIEW arena.safe_mv AS SELECT 1 AS id WITH NO DATA;')
  rejectsApp('CREATE MATERIALIZED VIEW arena.populated_mv AS SELECT 1 AS id;', /WITH NO DATA/u)
  rejectsApp(
    'CREATE MATERIALIZED VIEW arena.populated_mv AS SELECT 1 AS id WITH DATA;',
    /WITH NO DATA/u
  )
  rejectsApp('REFRESH MATERIALIZED VIEW arena.safe_mv;', /REFRESH/u)
})

test('rejects transaction control in both safety modes', () => {
  const sources = [
    'BEGIN;',
    'START TRANSACTION;',
    'COMMIT;',
    'END;',
    'ROLLBACK TO SAVEPOINT before_change;',
    'ABORT;',
    'SAVEPOINT before_change;',
    'RELEASE SAVEPOINT before_change;',
    "PREPARE TRANSACTION 'xid';",
    'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;',
    'SET LOCAL TRANSACTION READ ONLY;',
    'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE;',
  ]

  for (const source of sources) {
    assert.throws(() => validateAppSchemaSqlSafety(source), /transaction control/u)
    assert.throws(() => validateReplaySqlSafety(source), /transaction control/u)
  }
})

test('rejects CONCURRENTLY only in normal lexical state in both safety modes', () => {
  for (const validate of [validateAppSchemaSqlSafety, validateReplaySqlSafety]) {
    assert.throws(
      () => validate('CREATE INDEX CONCURRENTLY idx ON arena.example (id);'),
      /CONCURRENTLY/u
    )
    assert.doesNotThrow(() =>
      validate(`
        CREATE FUNCTION arena.concurrent_text() RETURNS text
          LANGUAGE sql AS $$ SELECT 'CONCURRENTLY'::text $$;
      `)
    )
  }
})

test('rejects cluster-wide and externally connected DDL', () => {
  const sources = [
    "ALTER SYSTEM SET shared_preload_libraries = 'unsafe';",
    'CREATE DATABASE escaped;',
    "CREATE TABLESPACE escaped LOCATION '/tmp/escaped';",
    'CREATE ROLE escaped LOGIN;',
    'CREATE USER escaped;',
    'CREATE GROUP escaped;',
    "CREATE SUBSCRIPTION escaped CONNECTION 'host=example.invalid' PUBLICATION events;",
    'IMPORT FOREIGN SCHEMA remote FROM SERVER escaped INTO arena;',
  ]

  for (const source of sources) rejectsApp(source, /forbidden/u)
})

test('blocks managed-schema and quoted-ledger DDL, ACL, and metadata targets', () => {
  const sources = [
    'DROP POLICY old_policy ON auth.users;',
    'DROP POLICY old_policy ON "auth"."users";',
    'GRANT USAGE ON SCHEMA storage TO authenticated;',
    'REVOKE SELECT ON TABLE "pg_catalog"."pg_class" FROM authenticated;',
    'DROP INDEX "auth"."users_email_idx";',
    'ALTER TABLE IF EXISTS ONLY "auth"."users" ENABLE ROW LEVEL SECURITY;',
    'ALTER TABLE public.example SET SCHEMA "storage";',
    'COMMENT ON TABLE pg_catalog.pg_class IS NULL;',
    'SECURITY LABEL ON TABLE storage.objects IS NULL;',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT ON TABLES TO authenticated;',
    'CREATE TABLE U&"a\\0075th".shadow (id int);',
    'COMMENT ON TABLE "supabase_migrations"."schema_migrations" IS NULL;',
  ]

  for (const source of sources) {
    rejectsApp(source, /managed|ledger|privileges|ACL|metadata|allowlist/u)
  }
})

test('allows public-object definitions that only reference managed functions and types', () => {
  acceptsApp(`
    CREATE TABLE public.profile_link (id pg_catalog.int8 PRIMARY KEY);
    CREATE POLICY own_profile ON public.profile_link
      USING (id = auth.uid());
  `)
})

test('rejects custom UESCAPE identifiers instead of guessing managed target spelling', () => {
  rejectsApp(`CREATE TABLE U&"a!0075th" UESCAPE '!'.shadow (id int);`, /custom UESCAPE/u)
})

test('app schema blocks extensions, unsafe languages, event triggers, foreign objects, and large objects', () => {
  const sources = [
    'CREATE EXTENSION file_fdw;',
    'ALTER EXTENSION hstore UPDATE;',
    'DROP EXTENSION hstore;',
    'CREATE LANGUAGE plpython3u;',
    "CREATE FUNCTION public.native() RETURNS void AS 'libunsafe' LANGUAGE C;",
    "CREATE FUNCTION public.native() RETURNS void AS 'boolin' LANGUAGE internal;",
    "CREATE FUNCTION public.python() RETURNS void AS 'pass' LANGUAGE plpython3u;",
    'CREATE EVENT TRIGGER unsafe ON ddl_command_start EXECUTE FUNCTION public.run();',
    'CREATE FOREIGN DATA WRAPPER unsafe;',
    "CREATE SERVER unsafe FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'example.invalid');",
    'CREATE USER MAPPING FOR CURRENT_USER SERVER unsafe;',
    'CREATE FOREIGN TABLE public.remote (id int) SERVER unsafe;',
    'CREATE LARGE OBJECT 1234;',
    'GRANT SELECT ON LARGE OBJECT 1234 TO authenticated;',
  ]

  for (const source of sources) rejectsApp(source, /forbidden|allowlist/u)

  acceptsApp(`
    CREATE FUNCTION public.safe_sql() RETURNS integer
      LANGUAGE sql AS $$ SELECT 1 $$;
    CREATE FUNCTION public.safe_plpgsql() RETURNS integer
      LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;
  `)
})

test('blocks server-file and external-connection function calls in schema expressions', () => {
  const sources = [
    "CREATE VIEW public.files AS SELECT pg_catalog.pg_read_file('/etc/passwd');",
    'CREATE VIEW public.binary_files AS SELECT "pg_read_binary_file"(\'/tmp/x\');',
    "CREATE VIEW public.remote AS SELECT dblink_connect('host=example.invalid');",
    "CREATE TABLE public.files (contents text DEFAULT pg_read_file('/tmp/x'));",
  ]

  for (const source of sources) rejectsApp(source, /server capability/u)
})

test('strict app statement allowlist rejects maintenance and session-privilege bypasses', () => {
  const sources = [
    'VACUUM public.example;',
    'ANALYZE public.example;',
    'LOCK TABLE public.example;',
    'NOTIFY unsafe;',
    'DROP TABLE public.example;',
    'RESET ALL;',
    'SECURITY LABEL ON TABLE public.example IS NULL;',
    'GRANT authenticated TO anon;',
    'REVOKE authenticated FROM anon;',
    'SET ROLE postgres;',
    'SET LOCAL ROLE postgres;',
    'SET SESSION AUTHORIZATION postgres;',
    'SET search_path = auth, pg_catalog;',
    'SET standard_conforming_strings = off;',
    'SET allow_system_table_mods = on;',
    'SET statement_timeout = 1;',
  ]

  for (const source of sources) {
    rejectsApp(source, /allowlist|execution role|search_path|must not|forbidden|pg_dump setting/u)
  }
})

test('foundation mode allows only the four non-login runtime fixture roles', () => {
  const result = validateFoundationSqlSafety(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE "authenticated" WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
    CREATE ROLE authenticator NOLOGIN;
    CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
    CREATE SCHEMA auth;
  `)
  assert.deepEqual(result, {
    mode: BASELINE_SQL_SAFETY_MODES.FOUNDATION,
    restrictionToken: null,
    statementCount: 5,
  })

  const rejected = [
    'CREATE ROLE postgres;',
    'CREATE ROLE dashboard_user NOLOGIN;',
    'CREATE ROLE anon LOGIN;',
    'CREATE ROLE authenticated SUPERUSER;',
    'ALTER ROLE anon SUPERUSER;',
    'DROP ROLE anon;',
  ]
  for (const source of rejected) {
    assert.throws(() => validateFoundationSqlSafety(source), /forbidden/u)
  }
})

test('foundation mode retains replay meta, transaction, concurrently, and outbound gates', () => {
  const rejected = [
    '\\gexec\n',
    'BEGIN;',
    'CREATE INDEX CONCURRENTLY idx ON public.t (id);',
    "COPY public.t TO PROGRAM 'id';",
    "SELECT dblink('conn', 'select 1');",
    "SELECT lo_put(1, 0, '\\x00');",
    "SELECT pg_write_file('/tmp/x', 'x');",
  ]
  for (const source of rejected) {
    assert.throws(
      () => validateFoundationSqlSafety(source),
      /forbidden|meta-command|transaction|CONCURRENTLY|server capability/u
    )
  }
})

test('foundation fixtures are additive and cannot alter existing owners or ACLs', () => {
  for (const source of [
    'ALTER SCHEMA public OWNER TO anon;',
    'REVOKE ALL ON SCHEMA public FROM PUBLIC;',
    'CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;',
    'CREATE INDEX existing_index ON pg_catalog.pg_proc (oid);',
  ]) {
    assert.throws(() => validateFoundationSqlSafety(source), /only add|not replace|not allowed/u)
  }
})

test('replay mode allows migration DML and executable bodies', () => {
  const result = validateReplaySqlSafety(`
    INSERT INTO arena.example (id) VALUES (1);
    UPDATE arena.example SET id = 2 WHERE id = 1;
    DO $$ BEGIN PERFORM 1; END $$;
  `)

  assert.deepEqual(result, {
    mode: BASELINE_SQL_SAFETY_MODES.REPLAY_INPUT,
    restrictionToken: null,
    statementCount: 3,
  })
})

test('replay and foundation modes reject app-only restriction envelopes', () => {
  const source = `\\restrict ${TOKEN}\nCREATE SCHEMA public;\n\\unrestrict ${TOKEN}\n`
  assert.throws(() => validateReplaySqlSafety(source), /only for the app-schema/u)
  assert.throws(() => validateFoundationSqlSafety(source), /only for the app-schema/u)
})

test('replay mode rejects host, cluster, and outbound operations', () => {
  const sources = [
    "COPY public.example TO PROGRAM 'curl example.invalid';",
    "LOAD 'unsafe';",
    'IMPORT FOREIGN SCHEMA remote FROM SERVER unsafe INTO public;',
    'CREATE ROLE escaped LOGIN;',
    "CREATE SUBSCRIPTION escaped CONNECTION 'host=example.invalid' PUBLICATION events;",
    "CREATE SERVER escaped FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'example.invalid');",
    "SELECT pg_read_file('/etc/passwd');",
    "SELECT dblink_connect('host=example.invalid');",
    "CREATE FUNCTION public.native() RETURNS void AS '/tmp/unsafe' LANGUAGE C;",
    'CREATE EXTENSION file_fdw;',
    'CREATE EVENT TRIGGER unsafe ON ddl_command_start EXECUTE FUNCTION public.run();',
    "DO LANGUAGE plpython3u 'pass';",
    'GRANT pg_execute_server_program TO authenticated;',
    'CREATE TRUSTED PROCEDURAL LANGUAGE escaped HANDLER pg_catalog.plpgsql_call_handler INLINE pg_catalog.plpgsql_inline_handler VALIDATOR pg_catalog.plpgsql_validator;',
    "DO $$ BEGIN EXECUTE 'CREATE TRUSTED PROCEDURAL LANGUAGE escaped HANDLER pg_catalog.plpgsql_call_handler'; END $$;",
    "UPDATE pg_catalog.pg_proc SET proname = 'safe_alias' WHERE proname = 'pg_read_file';",
    "UPDATE pg_proc SET proname = 'safe_alias' WHERE proname = 'pg_read_file';",
    'SELECT pg_ls_replslotdir();',
  ]

  for (const source of sources) {
    assert.throws(
      () => validateReplaySqlSafety(source),
      /forbidden|server capability|foreign data/u
    )
  }
})

test('foundation alone may declare extensions but cannot install unsafe-language routines', () => {
  assert.doesNotThrow(() => validateFoundationSqlSafety('CREATE EXTENSION pgcrypto;'))
  assert.throws(
    () =>
      validateFoundationSqlSafety(
        "CREATE FUNCTION auth.native() RETURNS void AS '/tmp/unsafe' LANGUAGE C;"
      ),
    /language C is forbidden/u
  )
  assert.throws(
    () =>
      validateFoundationSqlSafety(
        'CREATE TRUSTED PROCEDURAL LANGUAGE escaped HANDLER pg_catalog.plpgsql_call_handler INLINE pg_catalog.plpgsql_inline_handler VALIDATOR pg_catalog.plpgsql_validator;'
      ),
    /PROCEDURAL LANGUAGE is a forbidden cluster capability/u
  )
})

test('replay mode still rejects meta-command and lexical-state bypasses', () => {
  assert.throws(() => validateReplaySqlSafety('INSERT INTO t VALUES (1); \\gexec'), /meta/u)
  assert.throws(() => validateReplaySqlSafety("INSERT INTO t VALUES ('missing);"), /unterminated/u)
})

test('treats LF, CRLF, and bare CR as real psql line boundaries', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    acceptsApp(
      `\\restrict ${TOKEN}${newline}CREATE SCHEMA arena;${newline}\\unrestrict ${TOKEN}${newline}`
    )
    rejectsApp(`-- hidden command${newline}\\gexec${newline}`, /meta-command/u)
    rejectsApp(`CREATE SCHEMA arena;${newline}\\! id${newline}`, /meta-command/u)
  }
})

test('allows app-owned mutations and read-only references to managed objects', () => {
  const accepted = [
    'CREATE TABLE public.child (id bigint, user_id uuid REFERENCES auth.users(id));',
    'CREATE TABLE arena.child PARTITION OF public.parent FOR VALUES IN (1);',
    'CREATE TABLE public.inherited (id bigint) INHERITS (arena.base);',
    'CREATE INDEX child_id_idx ON public.child (id);',
    'CREATE POLICY child_read ON public.child USING (user_id = auth.uid());',
    'CREATE RULE child_rule AS ON SELECT TO public.child DO INSTEAD NOTHING;',
    'CREATE TRIGGER child_trigger BEFORE INSERT ON arena.child EXECUTE FUNCTION public.touch();',
    'ALTER TABLE public.parent ATTACH PARTITION arena.child FOR VALUES IN (1);',
    'ALTER TABLE public.parent DETACH PARTITION arena.child;',
    'ALTER TABLE public.child SET SCHEMA arena;',
    'ALTER SEQUENCE public.child_id_seq OWNED BY public.child.id;',
    'GRANT SELECT ON TABLE public.child, arena.child TO authenticated;',
    'GRANT USAGE ON SCHEMA public, arena TO authenticated;',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO authenticated;',
    'COMMENT ON TABLE public.child IS NULL;',
    'COMMENT ON POLICY child_read ON public.child IS NULL;',
  ]
  for (const source of accepted) acceptsApp(source)
})

test('rejects every non-app-owned or implicit mutation target', () => {
  const rejected = [
    'CREATE TABLE evil.t (id int);',
    'CREATE TABLE implicit_target (id int);',
    'CREATE TABLE "PUBLIC".t (id int);',
    'ALTER TABLE evil.t ADD COLUMN id int;',
    'CREATE INDEX bad_idx ON evil.t (id);',
    'CREATE POLICY bad_policy ON evil.t USING (true);',
    'CREATE RULE bad_rule AS ON SELECT TO evil.t DO INSTEAD NOTHING;',
    'CREATE TRIGGER bad_trigger BEFORE INSERT ON evil.t EXECUTE FUNCTION public.touch();',
    'CREATE TABLE public.child PARTITION OF evil.parent FOR VALUES IN (1);',
    'CREATE TABLE public.child (id bigint) INHERITS (evil.parent);',
    'ALTER TABLE public.parent ATTACH PARTITION evil.child FOR VALUES IN (1);',
    'ALTER TABLE public.parent DETACH PARTITION evil.child;',
    'ALTER TABLE public.child SET SCHEMA evil;',
    'GRANT CONNECT ON DATABASE postgres TO authenticated;',
    'GRANT SELECT ON TABLE evil.t TO authenticated;',
    'GRANT SELECT ON TABLE implicit_target TO authenticated;',
    'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO authenticated;',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA evil GRANT SELECT ON TABLES TO authenticated;',
    'COMMENT ON TABLE evil.t IS NULL;',
    'COMMENT ON TABLE implicit_target IS NULL;',
    'COMMENT ON DATABASE postgres IS NULL;',
    'CREATE PUBLICATION unsafe_publication FOR TABLE public.child;',
  ]
  for (const source of rejected) {
    rejectsApp(source, /public or arena|app-owned|database.global|database-wide|PUBLICATION/u)
  }
})

test('rejects sequence and identity restart operations', () => {
  rejectsApp('ALTER SEQUENCE public.child_id_seq RESTART WITH 10;', /RESTART/u)
  rejectsApp('ALTER TABLE public.child ALTER COLUMN id RESTART WITH 10;', /RESTART/u)
})

test('foundation and replay reject every top-level COPY form', () => {
  const sources = [
    'COPY public.t FROM STDIN;',
    "COPY public.t FROM '/tmp/input';",
    "COPY public.t TO '/tmp/output';",
    'COPY (SELECT 1) TO STDOUT;',
  ]
  for (const validate of [validateFoundationSqlSafety, validateReplaySqlSafety]) {
    for (const source of sources) assert.throws(() => validate(source), /COPY/u)
  }
})

test('scans routine and DO bodies for direct and dynamic host capabilities', () => {
  const appBodies = [
    "CREATE FUNCTION public.bad_copy() RETURNS void LANGUAGE sql AS $$ COPY public.t TO '/tmp/x' $$;",
    "CREATE FUNCTION public.bad_dynamic() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'COPY public.t TO ''/tmp/x'''; END $$;",
    "CREATE PROCEDURE public.bad_read() LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_read_file('/etc/passwd'); END $$;",
    "CREATE FUNCTION public.bad_dblink() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM dblink_connect('x'); END $$;",
    "CREATE FUNCTION public.bad_lo() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM lo_import('/tmp/x'); END $$;",
    "CREATE FUNCTION public.bad_role() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'CREATE ROLE escaped LOGIN'; END $$;",
    "CREATE FUNCTION public.bad_extension() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'CREATE EXTENSION file_fdw'; END $$;",
    "CREATE FUNCTION public.bad_native() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'CREATE FUNCTION public.native() RETURNS void AS ''/tmp/lib'' LANGUAGE C'; END $$;",
  ]
  for (const source of appBodies) rejectsApp(source, /executable SQL|server capability/u)

  assert.throws(
    () => validateReplaySqlSafety("DO $$ BEGIN EXECUTE 'ALTER SYSTEM SET work_mem = 1'; END $$;"),
    /executable SQL/u
  )
  assert.throws(
    () => validateFoundationSqlSafety('DO $$ BEGIN PERFORM 1; END $$;'),
    /declarative|DO is forbidden/u
  )
  acceptsApp(`
    CREATE FUNCTION public.safe_dml() RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO public.child (id) VALUES (1);
      UPDATE public.child SET id = 2 WHERE id = 1;
    END
    $$;
  `)
})

test('generic API validates modes, labels, and input types', () => {
  assert.throws(
    () => validateBaselineSqlSafety(Buffer.from('SELECT 1;')),
    /input must be a string/u
  )
  assert.throws(
    () => validateBaselineSqlSafety('CREATE SCHEMA arena;', { mode: 'unknown' }),
    /unknown SQL safety mode/u
  )
  assert.throws(
    () => validateBaselineSqlSafety('CREATE SCHEMA arena;', { label: '' }),
    /label must be a non-empty string/u
  )
})
