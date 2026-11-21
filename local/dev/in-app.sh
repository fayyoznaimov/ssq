#!/usr/bin/env bash
# Runs a command "inside the dev API" (what `docker compose exec crm-app ...` does in
# the docker stack): cwd parisahon-api, its env from local/dev/api.env, node 20 on PATH.
#   local/dev/in-app.sh sh -c 'cat /tmp/fake-claude-last.json'
#   local/dev/in-app.sh node -e '...'
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
set -a
# shellcheck disable=SC1091
. "${CRM_DEV_ENV:-$HERE/api.env}"
set +a
cd "$ROOT/parisahon-api"
exec "$@"
