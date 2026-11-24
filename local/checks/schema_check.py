#!/usr/bin/env python3
"""The database matches the code: every migration is applied, and the entities describe the same
tables, columns, types, foreign keys (with their ON DELETE rule) and indexes as the database (TypeORM
`schema:log`). Names of constraints and indexes may differ (older migrations named them by hand); anything
structural fails. Then the rules of fix wave 1b (DB-1, DB-3, DB-15, DB-16) are checked in the database itself:
one time zone, no cascade that destroys business data, NOT NULL / CHECK, the foreign-key indexes.
    local/dev/check.sh schema
Runs `typeorm` in the API's environment: CRM_APP_EXEC / CRM_APP_DIR (dev copy) or the docker container.
"""
import os
import re
import shlex
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
COMPOSE_FILE = os.path.join(ROOT, "docker-compose.local.yml")
APP_EXEC = (shlex.split(os.environ["CRM_APP_EXEC"]) if os.environ.get("CRM_APP_EXEC") else
            ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-app"])
APP_DIR = os.environ.get("CRM_APP_DIR", "/app")
results = {"PASS": 0, "FAIL": 0}


def check(name, ok, detail=""):
    results["PASS" if ok else "FAIL"] += 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {str(detail)[:1500]}" if detail and not ok else ""), flush=True)


def psql_rows(psql, query):
    # unaligned output separates the columns with "|" by default; no -F: local/dev/psql.js (the stand-in
    # for psql on the server) did not take it, and the default is the same with the real psql
    done = subprocess.run(psql + ["-At", "-c", query], capture_output=True, text=True, cwd=ROOT)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.strip()[-500:])
    return [line.split("|") for line in done.stdout.splitlines() if line != ""]


# ON DELETE of a foreign key in pg_constraint.confdeltype
RULE_CODES = {"a": "NO ACTION", "r": "RESTRICT", "c": "CASCADE", "n": "SET NULL", "d": "SET DEFAULT"}

FK_RULES_SQL = """
SELECT c.conrelid::regclass::text, a.attname, c.confdeltype::text
  FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
 WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND array_length(c.conkey, 1) = 1
"""

# DB-3 (migration 1795721000000-delete-rules): a DELETE of one row does not take business data with it
DELETE_RULES = {
    ("company_filler", "filler_id"): "RESTRICT", ("deal_filler", "filler_id"): "RESTRICT",
    ("user_filler", "filler_id"): "RESTRICT", ("product_filler", "filler_id"): "RESTRICT",
    ("deal_product", "product_id"): "RESTRICT", ("file", "email_id"): "RESTRICT",
    ("recording", "user_id"): "RESTRICT", ("call_upload", "user_id"): "RESTRICT",
    ('"user"', "company_id"): "SET NULL", ("trigger", "user_id"): "SET NULL", ("task", "type_id"): "RESTRICT",
}

# DB-15 (migration 1795722000000-child-keys-checks): a child row always has its parent
NOT_NULL = [("company_filler", "company_id"), ("company_filler", "filler_id"), ("deal_filler", "deal_id"),
            ("deal_filler", "filler_id"), ("user_filler", "user_id"), ("user_filler", "filler_id"),
            ("product_filler", "product_id"), ("product_filler", "filler_id"), ("deal_product", "deal_id"),
            ("deal_product", "product_id"), ("email_to", "email_id"), ("email_cc", "email_id"),
            ("deal_stage_record", "deal_id"), ("deal_stage_record", "stage_id"), ("trigger", "deal_stage_id"),
            ("deal", "stage_id")]
CHECKS = ["CHK_user_role", "CHK_filler_target", "CHK_call_upload_status", "CHK_trigger_run_status", "CHK_task_times"]

# DB-16 (migration 1795724000000-key-indexes): the foreign keys the CRM looks up by; two covered indexes gone
KEY_INDEXES = ["IDX_task_created_by", "IDX_task_ctr_agent", "IDX_task_open_group", "IDX_deal_stage_record_stage",
               "IDX_deal_product_product", "IDX_file_uploaded_by", "IDX_company_primary_contact", "IDX_email_sent_by"]
GONE_INDEXES = ["IDX_b8c3aeeac35ace9d387fb5e142", "IDX_call_upload_user"]


def db_rules(psql):
    """(table as regclass prints it, column) -> ON DELETE of its foreign key"""
    return {(row[0], row[1]): RULE_CODES.get(row[2], row[2]) for row in psql_rows(psql, FK_RULES_SQL)}


def typeorm(*args):
    cmd = f"cd {shlex.quote(APP_DIR)} && npx typeorm -d dist/datasource.js {' '.join(args)}"
    done = subprocess.run(APP_EXEC + ["sh", "-c", cmd], capture_output=True, text=True, timeout=300)
    return done.returncode, "\n".join(l for l in (done.stdout + done.stderr).splitlines() if not l.startswith("query:"))


def main():
    code, out = typeorm("migration:show")
    applied = re.findall(r"^\s*\[X\]", out, re.M)
    pending = re.findall(r"^\s*\[ \]\s*(.*)$", out, re.M)
    check(f"migrations: {len(applied)} applied, none pending", code == 0 and applied and not pending, pending or out[-500:])

    # the database works in the API's time zone: one setting, TZ (Asia/Tashkent by default; helper/time-zone.ts,
    # migration 1795720000000-database-time-zone, datasource.ts)
    env_file = os.environ.get("CRM_ENV_FILE") or os.path.join(ROOT, "parisahon-api", ".env")
    tz = "Asia/Tashkent"
    try:
        for line in open(env_file, encoding="utf-8"):
            if line.startswith("TZ="):
                tz = line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    psql = (shlex.split(os.environ["CRM_PSQL"]) if os.environ.get("CRM_PSQL") else
            ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "crm-db", "psql", "-U", "root", "-d", "parisahon"])
    db_tz = subprocess.run(psql + ["-At", "-c", "show timezone"], capture_output=True, text=True, cwd=ROOT).stdout.strip()
    check(f"the database time zone is the API's ({tz})", db_tz == tz, db_tz)
    try:
        rules = db_rules(psql)
    except Exception as error:  # noqa: BLE001 - reported as a failure of its own
        rules = None
        check("the foreign keys of the database can be read", False, error)

    code, out = typeorm("schema:log")
    if "Your schema is up to date" in out:
        check("entities and database schema are the same", True)
    else:
        statements = [s.strip() for s in re.findall(r"^(?:ALTER|CREATE|DROP|COMMENT)[^;]*;", out, re.M)]
        structural, fk_drop, fk_add, idx_drop, idx_add = [], {}, {}, 0, []
        for s in statements:
            m = re.match(r'ALTER TABLE "(\w+)" DROP CONSTRAINT "FK_\w+";', s)
            if m:
                fk_drop[m.group(1)] = fk_drop.get(m.group(1), 0) + 1
                continue
            m = re.match(r'ALTER TABLE "(\w+)" ADD CONSTRAINT "FK_\w+" FOREIGN KEY', s)
            if m:
                fk_add[m.group(1)] = fk_add.get(m.group(1), 0) + 1
                continue
            if re.match(r'DROP INDEX "public"\."\w+";', s):
                idx_drop += 1
                continue
            m = re.match(r'CREATE (?:UNIQUE )?INDEX "\w+" ON "(\w+)" \(([^)]*)\)', s)
            if m:
                idx_add.append(s)
                continue
            structural.append(s)
        check("no structural difference between the entities and the database (tables, columns, types)", not structural, "\n".join(structural[:15]))
        check("foreign keys: the same on both sides (only their names differ)", fk_drop == fk_add, {"db_only": fk_drop, "code_only": fk_add})
        # a key of another name is dropped and added again by schema:log, and so is one of the same name with
        # another ON DELETE: the counts above cannot tell them apart, the rule of each added key can
        if rules is not None:
            differ = []
            for s in statements:
                m = re.match(r'ALTER TABLE "(\w+)" ADD CONSTRAINT "FK_\w+" FOREIGN KEY \("(\w+)"\) .*? '
                             r'ON DELETE (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)', s)
                if m:
                    # regclass prints the reserved names quoted
                    key = ('"%s"' % m.group(1) if m.group(1) in ("user", "group") else m.group(1), m.group(2))
                    if rules.get(key) != m.group(3):
                        differ.append("%s.%s: entity %s, database %s" % (m.group(1), m.group(2), m.group(3), rules.get(key)))
            check("foreign keys: the entities and the database have the same ON DELETE", not differ, differ)
        check("indexes: the same on both sides (only their names differ)", idx_drop == len(idx_add), {"dropped": idx_drop, "created": idx_add[:5]})
    wave_1b_rules(psql, rules)
    print(f"\nRESULT: {results['PASS']} passed, {results['FAIL']} failed")
    return 1 if results["FAIL"] else 0


def wave_1b_rules(psql, rules):
    """DB-1, DB-3, DB-15, DB-16 in the database itself (whatever the entities say)."""
    if rules is not None:
        wrong = {"%s.%s" % key: rules.get(key) for key, rule in DELETE_RULES.items() if rules.get(key) != rule}
        check("DB-3: no ON DELETE CASCADE from a field to its values, nor from a product, a letter, an employee "
              "or a company to business data (RESTRICT / SET NULL)", not wrong, wrong)
    try:
        nullable = psql_rows(psql, "SELECT table_name || '.' || column_name FROM information_schema.columns "
                                   "WHERE table_schema = 'public' AND is_nullable = 'YES' AND (table_name, column_name) IN (%s)"
                             % ", ".join("('%s', '%s')" % pair for pair in NOT_NULL))
        check("DB-15: the parent of a child row is NOT NULL (values, product lines, recipients, stage history, "
              "triggers, the stage of a deal)", not nullable, [r[0] for r in nullable])
        have = {r[0]: r[1] for r in psql_rows(psql, "SELECT conname, convalidated::text FROM pg_constraint "
                                                    "WHERE contype = 'c' AND conname IN (%s)" % ", ".join("'%s'" % c for c in CHECKS))}
        check("DB-15: CHECK of the role, the target of a field, the statuses of uploads and trigger runs, "
              "a task's end after its start (validated)", all(have.get(c) == "true" for c in CHECKS), have)
        indexes = {r[0]: r[1] for r in psql_rows(
            psql, "SELECT c.relname, i.indisvalid::text FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid "
                  "WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (%s)"
                  % ", ".join("'%s'" % n for n in KEY_INDEXES + GONE_INDEXES))}
        check("DB-16: the foreign-key indexes exist and are valid",
              all(indexes.get(n) == "true" for n in KEY_INDEXES), {n: indexes.get(n) for n in KEY_INDEXES})
        check("DB-16: the indexes a wider one covers are gone (event.type, call_upload.user_id)",
              not any(n in indexes for n in GONE_INDEXES), [n for n in GONE_INDEXES if n in indexes])
        if psql_rows(psql, "SELECT 1 FROM migrations WHERE name = 'Timestamptz1795729000000'"):
            naive = psql_rows(psql, "SELECT c.table_name || '.' || c.column_name FROM information_schema.columns c "
                                    "JOIN information_schema.tables t ON t.table_schema = c.table_schema "
                                    "AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE' "
                                    "WHERE c.table_schema = 'public' AND c.data_type = 'timestamp without time zone'")
            check("DB-1: every time is stored with its zone (timestamptz, migration 1795729000000)",
                  not naive, [r[0] for r in naive][:20])
        else:
            print("SKIP  DB-1: migration Timestamptz1795729000000 is not applied, the times are stored without a zone", flush=True)
    except Exception as error:  # noqa: BLE001 - reported as a failure of its own
        check("the wave 1b rules of the database can be read", False, error)


if __name__ == "__main__":
    sys.exit(main())
