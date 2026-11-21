#!/usr/bin/env python3
"""Every page of the web client opens: no JavaScript errors on the page, no 5xx from the API
while it loads, nothing wider than the screen on a PC; phone width is reported (legacy pages
are not all adapted yet). Uses local/dev/screens.sh (headless Chrome) against the dev web copy.
    local/dev/check.sh ui        (or: source local/dev/env.sh; python3 local/checks/ui_check.py)
Screenshots: local/dev/screens/ui/*.png. Only for the dev copy on the server.
"""
import json
import os
import shlex
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PSQL = shlex.split(os.environ.get("CRM_PSQL", "node local/dev/psql.js"))
results = {"PASS": 0, "FAIL": 0}
STATIC = [
    "/", "/tasks", "/tasks/calendar", "/tasks/kanban", "/deals", "/deals/new", "/deals/trash",
    "/lists/companies", "/lists/contacts", "/lists/products", "/lists/files", "/lists/calls",
    "/mails", "/mails/new", "/mails/settings", "/telegram", "/whatsapp", "/profile",
    "/analytics/sales", "/analytics/managers", "/analytics/employees", "/analytics/products", "/analytics/events",
    "/analytics/goals", "/analytics/goals/settings", "/analytics/consolidated", "/analytics/calls",
    "/requests", "/roles", "/settings/deals", "/settings/groups", "/settings/users", "/settings/transporters", "/settings/calls",
]


def check(name, ok, detail=""):
    results["PASS" if ok else "FAIL"] += 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {str(detail)[:600]}" if detail and not ok else ""), flush=True)


def one(sql):
    out = subprocess.run(PSQL + ["-At", "-c", sql], capture_output=True, text=True, cwd=ROOT).stdout.strip()
    return out.split("\n")[0] if out else ""


def main():
    dynamic = []
    for path, sql in [
        ("/deals/{}", "select id from deal where deleted_at is null order by id desc limit 1"),
        ("/lists/companies/{}", "select c.id from company c join \"user\" u on u.company_id = c.id where c.deleted_at is null and c.name not like 'AUDIT%' order by c.id desc limit 1"),
        ("/lists/contacts/{}", "select id from \"user\" where role = 'ctr_agent' and deleted_at is null and username not like 'AUDIT%' order by id desc limit 1"),
        ("/lists/products/{}", "select id from product where deleted_at is null order by id desc limit 1"),
        ("/lists/calls/{}", "select id from \"user\" where role = 'agent' and deleted_at is null order by id limit 1"),
        ("/mails/index/{}", "select id from email where deleted_at is null order by id desc limit 1"),
        ("/settings/groups/{}", "select id from \"group\" order by id limit 1"),
        ("/settings/users/{}", "select id from \"user\" where role <> 'ctr_agent' and deleted_at is null order by id limit 1"),
    ]:
        value = one(sql)
        if value:
            dynamic.append(path.format(value))
    pages = STATIC + dynamic
    env = dict(os.environ, SCREEN_JSON="1", SCREEN_OUT=os.path.join(ROOT, "local", "dev", "screens", "ui"))
    proc = subprocess.run([os.path.join(ROOT, "local", "dev", "screens.sh")] + pages, capture_output=True, text=True, env=env, timeout=1800)
    line = next((l for l in proc.stdout.splitlines() if l.startswith("@@")), None)
    if not line:
        check("screenshots ran", False, (proc.stderr or proc.stdout)[-800:])
        return 1
    report = json.loads(line[2:])
    phone_wide = []
    for path in pages:
        rows = {r["size"]: r for r in report if r["path"] == path}
        pc, phone = rows.get("pc"), rows.get("phone")
        if not pc:
            check(f"{path}: rendered", False, "no result")
            continue
        problems = []
        if pc["url"] in ("/login", "/403") and path not in ("/403",):
            problems.append(f"redirected to {pc['url']}")
        for r in (pc, phone):
            if r and r["pageErrors"]:
                problems.append(f"{r['size']}: JS error {r['pageErrors'][0][:200]}")
            if r and r["api5xx"]:
                problems.append(f"{r['size']}: API {', '.join(r['api5xx'][:3])}")
        if pc["overflow"] > 1:
            problems.append(f"pc: wider than the screen by {pc['overflow']}px")
        if phone and phone["overflow"] > 1:
            phone_wide.append(f"{path} (+{phone['overflow']}px)")
        check(f"{path}: opens without errors, fits a PC screen", not problems, "; ".join(problems))
    print(f"\nphone width: {len(phone_wide)} page(s) wider than the screen (not a failure yet): {', '.join(phone_wide) or 'none'}")
    print(f"\nRESULT: {results['PASS']} passed, {results['FAIL']} failed")
    return 1 if results["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
