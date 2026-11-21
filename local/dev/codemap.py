#!/usr/bin/env python3
"""Builds the code map from the code itself (run again after a change):
    python3 local/dev/codemap.py      -> docs/CODEMAP.md (Mermaid, renders on GitHub) + docs/codemap.html
Reads: API modules (*.module.ts: imports, controllers, entities), controllers (URL prefixes),
entities (tables), foreign keys (the dev database through local/dev/psql.js), events
(emit / @OnEvent), the client (useService(...) per page and component) and the check map
(local/dev/check.sh). Nothing to edit by hand.
"""
import collections
import html
import json
import os
import re
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
API = os.path.join(ROOT, "parisahon-api", "src")
WEB = os.path.join(ROOT, "parisahon-client", "app")


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def walk(root, exts):
    for dp, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".nuxt", ".output", "dist", "migrations")]
        for f in files:
            if f.endswith(exts):
                yield os.path.join(dp, f)


def snake(name):
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


# ------------------------------------------------------------------ API
modules = {}          # ModuleName -> {dir, imports, controllers, entities}
for path in walk(API, (".module.ts",)):
    text = read(path)
    m = re.search(r"export class (\w+Module)", text)
    if not m or m.group(1) == "AppModule":
        continue
    body = text[text.index("@Module("):]
    imports = re.search(r"imports:\s*\[(.*?)\]\s*,\s*(?:providers|controllers|exports|\})", body, re.S)
    imported = re.findall(r"\b(\w+Module)\b", imports.group(1)) if imports else []
    entities = re.findall(r"forFeature\(\[([^\]]*)\]", body)
    modules[m.group(1)] = {
        "dir": os.path.relpath(os.path.dirname(path), API),
        "imports": sorted({x for x in imported if x not in ("TypeOrmModule", m.group(1), "JwtModule", "EventEmitterModule")}),
        "entities": sorted({e.strip() for group in entities for e in group.split(",") if e.strip()}),
        "controllers": [],
    }

# controllers -> URL prefix -> module (by directory)
prefix_module = {}
for path in walk(API, (".controller.ts",)):
    text = read(path)
    d = os.path.relpath(os.path.dirname(path), API).split(os.sep)[0]
    owner = next((name for name, mod in modules.items() if mod["dir"].split(os.sep)[0] == d), None)
    for prefix in re.findall(r"@Controller\(\s*['\"]([^'\"]*)['\"]", text):
        first = prefix.strip("/").split("/")[0]
        if owner:
            modules[owner]["controllers"].append(prefix or "/")
            prefix_module.setdefault(first, owner)

# entities -> table names
entity_table = {}
for path in walk(API, (".entity.ts",)):
    text = read(path)
    for m in re.finditer(r"@Entity\(\s*(?:\{\s*name:\s*)?['\"]?(\w*)['\"]?[^)]*\)\s*(?:@\w+\([^)]*\)\s*)*export class (\w+)", text):
        entity_table[m.group(2)] = m.group(1) or snake(m.group(2))
for path in walk(API, (".entity.ts",)):
    text = read(path)
    for m in re.finditer(r"((?:@Index\([^)]*\)\s*)*)@Entity\(([^)]*)\)\s*export class (\w+)", text):
        arg = m.group(2).strip()
        name = re.search(r"['\"](\w+)['\"]", arg)
        entity_table[m.group(3)] = name.group(1) if name else snake(m.group(3))

def table_of(entity):
    """Table of an entity; an import alias like TaskTypeEntity falls back to TaskType."""
    if entity in entity_table:
        return entity_table[entity]
    base = re.sub(r"Entity$", "", entity)
    return entity_table.get(base, snake(base))


# events: who emits, who listens
emits, listens = collections.defaultdict(set), collections.defaultdict(set)
for path in walk(API, (".ts",)):
    text = read(path)
    d = os.path.relpath(path, API).split(os.sep)[0]
    owner = next((name for name, mod in modules.items() if mod["dir"].split(os.sep)[0] == d), d)
    for ev in re.findall(r"emit\(\s*EventTypes\.(\w+)", text):
        emits[ev].add(owner)
    for ev in re.findall(r"@OnEvent\(\s*EventTypes\.(\w+)", text):
        listens[ev].add(owner)

# foreign keys from the database
fks = []
try:
    out = subprocess.run(["node", os.path.join(ROOT, "local", "dev", "psql.js"), "-At", "-c",
                          "select c.conrelid::regclass::text, c.confrelid::regclass::text from pg_constraint c "
                          "where c.contype = 'f' and c.connamespace = 'public'::regnamespace group by 1, 2 order by 1, 2"],
                         capture_output=True, text=True, timeout=60).stdout
    fks = [tuple(x.replace('"', "") for x in line.split("|")) for line in out.splitlines() if "|" in line]
except Exception:
    pass

# ------------------------------------------------------------------ client
area_of_page = lambda rel: rel.split(os.sep)[1] if rel.startswith("pages" + os.sep) and len(rel.split(os.sep)) > 2 else (os.path.splitext(rel.split(os.sep)[-1])[0] if rel.startswith("pages") else None)
web_uses = collections.defaultdict(set)    # client area -> API prefixes
for path in walk(WEB, (".vue", ".ts")):
    rel = os.path.relpath(path, WEB)
    parts = rel.split(os.sep)
    if parts[0] not in ("pages", "components") or (parts[0] == "components" and len(parts) < 3):
        continue
    area = area_of_page(rel) if parts[0] == "pages" else "components/" + parts[1]
    for svc in re.findall(r"useService\(\s*['\"]([^'\"]+)['\"]", read(path)):
        web_uses[area].add(svc.strip("/").split("/")[0])
web_uses = {k: v for k, v in web_uses.items() if v}

# ------------------------------------------------------------------ checks
checks = collections.defaultdict(set)
script = read(os.path.join(ROOT, "local", "dev", "check.sh"))
for patterns, sets in re.findall(r"^\s+((?:parisahon-api/src/[^)]*?)\))\s*echo ([a-z ]+);;", script, re.M):
    for d in re.findall(r"parisahon-api/src/([a-z_]+)/", patterns):
        for s in sets.split():
            checks[d].add(s)

# ------------------------------------------------------------------ output
def node(name):
    return re.sub(r"\W", "_", name)

blocks = [
    ("Вход и права", ["AuthModule", "UserModule", "GroupModule"]),
    ("Сделки", ["DealModule", "DealStageModule", "EventsModule", "TriggerModule"]),
    ("Клиенты и справочники", ["CompanyModule", "ContactModule", "ProductModule", "FillerModule", "TaskModule", "TaskTypeModule", "DesktopModule", "LinkableModule"]),
    ("Каналы", ["EmailModule", "TelegramModule", "BotModule", "CallsModule", "RecognitionModule"]),
    ("Отчёты", ["AnalyticsModule", "ObjectiveModule", "TrackingModule"]),
]
placed = {m for _, ms in blocks for m in ms}
other = sorted(m for m in modules if m not in placed)
if other:
    blocks.append(("Служебные", other))

def label(mod):
    m = modules[mod]
    tables = [table_of(e) for e in m["entities"]]
    urls = sorted({c.strip("/").split("/")[0] or "/" for c in m["controllers"]})
    lines = [f"<b>{mod.replace('Module', '')}</b>"]
    if urls:
        lines.append("API: /" + ", /".join(urls))
    if tables:
        lines.append("БД: " + ", ".join(tables[:6]) + (" …" if len(tables) > 6 else ""))
    return "<br/>".join(lines)

def tables_of(mods):
    return sorted({table_of(e) for m in mods for e in modules[m]["entities"]})


present_blocks = [(t, [m for m in ms if m in modules]) for t, ms in blocks]
present_blocks = [(t, ms) for t, ms in present_blocks if ms]
block_of = {m: t for t, ms in present_blocks for m in ms}

# 1. overview: front -> blocks -> their tables (one arrow per pair)
overview = ["flowchart LR", '  WEB["Фронт<br/>parisahon-client/app"]', '  TG["Telegram-сервис<br/>(Python)"]', '  REC["Рекордер<br/>звонков"]']
for title, ms in present_blocks:
    mods = ", ".join(m.replace("Module", "") for m in ms)
    overview.append(f'  B_{node(title)}["<b>{title}</b><br/>{mods}"]')
    tables = tables_of(ms)
    if tables:
        overview.append(f'  D_{node(title)}[("{", ".join(tables)}")]')
        overview.append(f"  B_{node(title)} --> D_{node(title)}")
used_blocks = sorted({block_of[prefix_module[p]] for ps in web_uses.values() for p in ps if p in prefix_module and prefix_module[p] in block_of})
for title in used_blocks:
    overview.append(f"  WEB --> B_{node(title)}")
overview.append(f'  TG -->|POST /telegram/incoming<br/>POST /calls/upload| B_{node(block_of.get("TelegramModule", "Каналы"))}')
overview.append(f'  REC -->|POST /calls/upload| B_{node(block_of.get("CallsModule", "Каналы"))}')

# 2. one diagram per block: pages and components -> modules -> tables
block_diagrams = []
for title, ms in present_blocks:
    lines = ["flowchart LR"]
    for m in ms:
        urls = sorted({c.strip("/").split("/")[0] or "/" for c in modules[m]["controllers"]})
        lines.append(f'  {node(m)}["<b>{m.replace("Module", "")}</b>' + (f'<br/>/{", /".join(urls)}' if urls else "") + '"]')
        for t in sorted({table_of(e) for e in modules[m]["entities"]}):
            lines.append(f'  {node(m)} --> T_{node(t)}[("{t}")]')
    areas = sorted({a for a, ps in web_uses.items() for p in ps if prefix_module.get(p) in ms})
    for a in areas:
        for m in sorted({prefix_module[p] for p in web_uses[a] if prefix_module.get(p) in ms}):
            lines.append(f'  W_{node(a)}(["{a}"]) --> {node(m)}')
    block_diagrams.append((title, lines))

deps = ["flowchart LR"]
for name, m in sorted(modules.items()):
    for imp in m["imports"]:
        if imp in modules and imp not in ("HelperModule",):
            deps.append(f"  {node(name)} --> {node(imp)}")
deps.append("  %% every module also uses HelperModule (common helpers)")

events = ["flowchart LR"]
for ev in sorted(set(emits) | set(listens)):
    events.append(f'  E_{ev}(["{ev}"])')
    for src in sorted(emits.get(ev, [])):
        events.append(f"  {node(src)} --> E_{ev}")
    for dst in sorted(listens.get(ev, [])):
        events.append(f"  E_{ev} --> {node(dst)}")

db = ["flowchart LR"]
for a, b in fks:
    if a != b:
        db.append(f"  {node(a)}[{a}] --> {node(b)}[{b}]")

md = ["# Карта кода Parisa CRM", "",
      "Сгенерировано `python3 local/dev/codemap.py` из исходников и dev-базы — не править руками. Как работать с модулями — `CLAUDE.md`.", "",
      "## 1. Обзор: фронт → блоки API → таблицы", "", "Блоки — группы модулей API по смыслу; цилиндр — таблицы блока.", "",
      "```mermaid", *overview, "```", "",
      *[line for title, lines in block_diagrams for line in (f"### Блок «{title}»: страницы → модули → таблицы", "", "```mermaid", *lines, "```", "")],
      "## 2. Зависимости модулей API", "", "Стрелка: модуль импортирует другой модуль (Nest `imports`).", "",
      "```mermaid", *deps, "```", "",
      "## 3. События между модулями", "", "Модуль генерирует событие (`EventEmitter.emit`) → модули, которые его слушают (`@OnEvent`). Через события пишется история сделки и срабатывают триггеры.", "",
      "```mermaid", *events, "```", "",
      "## 4. Таблицы и внешние ключи", "", "Стрелка: таблица ссылается на другую (внешний ключ).", "",
      "```mermaid", *db, "```", "",
      "## 5. Модули и проверки", "", "| Модуль | Папка | Адреса API | Таблицы | Наборы проверок |", "|---|---|---|---|---|"]
for name, m in sorted(modules.items()):
    d = m["dir"].split(os.sep)[0]
    md.append(f"| {name.replace('Module', '')} | `parisahon-api/src/{m['dir']}` | {', '.join('/' + c for c in sorted(set(m['controllers']))) or '—'} | "
              f"{', '.join(table_of(e) for e in m['entities']) or '—'} | {', '.join(sorted(checks.get(d, set()) | {'smoke', 'auth'} if m['controllers'] else checks.get(d, set()))) or '—'} |")
md += ["", "Наборы для всего проекта: `schema` (база совпадает с кодом), `smoke` (каждый GET-запрос API), `ui` (каждая страница фронта), `auth` (права на всех маршрутах). Запуск: `local/dev/check.sh` (все) или `local/dev/check.sh --changed`.", ""]
os.makedirs(os.path.join(ROOT, "docs"), exist_ok=True)
with open(os.path.join(ROOT, "docs", "CODEMAP.md"), "w", encoding="utf-8", newline="\n") as fh:
    fh.write("\n".join(md))

sections = [("Обзор: фронт → блоки API → таблицы", overview)] + [(f"Блок «{t}»: страницы → модули → таблицы", l) for t, l in block_diagrams] + [("Зависимости модулей API", deps), ("События между модулями", events), ("Таблицы и внешние ключи", db)]
page = ["<!doctype html><html lang=ru><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Карта кода CRM</title>",
        "<style>body{font-family:system-ui,sans-serif;margin:16px;background:#0f172a;color:#e2e8f0}h1,h2{font-weight:600}h2{margin-top:32px}.mermaid{background:#fff;border-radius:8px;padding:12px;overflow:auto}table{border-collapse:collapse;font-size:13px}td,th{border:1px solid #334155;padding:4px 8px;text-align:left;vertical-align:top}</style>",
        "<script src='https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js'></script></head><body>",
        "<h1>Карта кода Parisa CRM</h1><p>Сгенерировано <code>local/dev/codemap.py</code> из исходников и базы.</p>"]
for title, lines in sections:
    page.append(f"<h2>{html.escape(title)}</h2><pre class=mermaid>{html.escape(chr(10).join(lines))}</pre>")
page.append("<h2>Модули и проверки</h2><table><tr><th>Модуль</th><th>Адреса API</th><th>Таблицы</th><th>Проверки</th></tr>")
for name, m in sorted(modules.items()):
    d = m["dir"].split(os.sep)[0]
    page.append(f"<tr><td>{name.replace('Module', '')}</td><td>{html.escape(', '.join('/' + c for c in sorted(set(m['controllers']))))}</td><td>{html.escape(', '.join(table_of(e) for e in m['entities']))}</td><td>{html.escape(', '.join(sorted(checks.get(d, set()) | ({'smoke', 'auth'} if m['controllers'] else set()))))}</td></tr>")
page.append("</table><script>mermaid.initialize({startOnLoad:true,securityLevel:'loose',flowchart:{htmlLabels:true}})</script></body></html>")
with open(os.path.join(ROOT, "docs", "codemap.html"), "w", encoding="utf-8", newline="\n") as fh:
    fh.write("\n".join(page))
print(f"modules {len(modules)}, client areas {len(web_uses)}, events {len(set(emits) | set(listens))}, foreign keys {len(fks)}")
print("docs/CODEMAP.md, docs/codemap.html")
