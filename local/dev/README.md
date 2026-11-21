# Dev copy of the CRM on the server

Runs next to the trial copy (`~/parisa-crm`) without touching its data. Russian description
and the day-to-day commands: `docs/AUDIT.md`, section 7.

- `setup.sh` — first run: `api.env` from `api.env.template` (trial db password from
  `~/parisa-crm/db.pass`, fresh dev secrets; not in git), dependencies, database
  `parisahon_dev` (copy of the trial db), systemd user units `crm-dev-*`.
- `units.sh status | start | stop | restart | logs [unit] | remove` — the units:
  `crm-dev-api` (nest watch, :3100), `crm-dev-web` (nuxt dev, :4150),
  `crm-dev-fake-telegram` (:8098), `crm-dev-mock-claude` (:8099).
- `db.js create | recreate | drop` — the dev database.
- `psql.js` — psql stand-in on the `pg` package (no psql binary on the server).
- `in-app.sh CMD…` — run a command with the dev API's env and cwd (what `docker compose exec crm-app` is in the docker stack).
- `env.sh` — `source` it to point `local/checks/*.py` at the dev copy; `check.sh [sets…]` does that and runs them.
