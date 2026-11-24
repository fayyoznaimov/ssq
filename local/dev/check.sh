#!/usr/bin/env bash
# Runs the regression checks against the dev copy on the server.
#   local/dev/check.sh            all five sets, one after another
#   local/dev/check.sh auth bot   only these (schema auth smoke deals history trash files recognition bot modules platform telegram whatsapp triggers analytics mail calls ftp live ui ai audit)
#   local/dev/check.sh -v auth    extra flags go to the scripts
#   local/dev/check.sh --changed  only the sets that cover files changed since the last green run
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
source "$HERE/env.sh"
ALL=(schema auth smoke deals history trash files recognition bot modules platform telegram whatsapp triggers analytics mail calls ftp live ui ai audit)
STAMP="$HERE/.last-green"

# Which sets cover a changed file (see the module map in CLAUDE.md)
sets_for() {
  case "$1" in
    local/checks/*_check.py) basename "$1" _check.py ;;
    parisahon-api/src/auth/*|parisahon-api/src/app.module.ts|parisahon-api/src/main.ts|parisahon-client/app/middleware/*|parisahon-client/app/utils/casl.ts) echo auth ;;
    parisahon-api/src/history/*|parisahon-client/app/components/history/*) echo history deals ui ;;
    parisahon-api/src/deal/deal-trash*|parisahon-api/src/deal/deal-access.ts|parisahon-client/app/pages/deals/trash.vue|parisahon-api/src/helper/*) echo deals trash ;;
    parisahon-api/src/deal/*|parisahon-api/src/deal_stage/*|parisahon-client/app/pages/deals/*) echo deals trash ;;
    parisahon-api/src/file/*|parisahon-client/app/components/deal/files-tab.vue|parisahon-client/app/pages/lists/files/*|parisahon-client/app/utils/files.ts|parisahon-client/app/composables/useUpload.ts) echo files platform ;;
    parisahon-api/src/events/*) echo deals history telegram whatsapp ;;
    parisahon-api/src/ai/*|parisahon-api/src/ai/*/*|parisahon-client/app/components/ai/*|parisahon-client/app/composables/useDealAi.ts) echo ai ;;
    parisahon-api/src/ai-insights/*|parisahon-api/src/ai-insights/*/*|parisahon-client/app/components/ai-insights/*|parisahon-client/app/pages/analytics/market.vue) echo ai ;;
    parisahon-api/src/audit/*|parisahon-api/src/audit/*/*|parisahon-client/app/components/audit/*) echo audit ;;
    local/fake-claude/*) echo recognition bot ai ;;
    parisahon-api/src/recognition/*|parisahon-client/app/components/company/CardRecognition*) echo recognition bot ai ;;
    parisahon-api/src/bot/*|parisahon-client/app/pages/profile/*|parisahon-stt/*|local/fake-telegram/*) echo bot ;;
    parisahon-api/src/company/*|parisahon-api/src/contact/*|parisahon-api/src/user/*|parisahon-api/src/product/*|parisahon-api/src/filler/*|parisahon-api/src/task/*|parisahon-api/src/task_type/*|parisahon-api/src/desktop/*) echo modules ;;
    parisahon-client/app/pages/lists/*|parisahon-client/app/components/company/*|parisahon-client/app/stores/*|parisahon-client/app/pages/tasks*|parisahon-client/app/pages/index.vue) echo modules ;;
    parisahon-api/src/telegram/*|parisahon-telegram-service/*|parisahon-client/app/pages/telegram/*) echo telegram ;;
    parisahon-api/src/whatsapp/*|parisahon-whatsapp-service/*|parisahon-client/app/components/whatsapp/*) echo whatsapp ;;
    parisahon-api/src/messenger/*) echo telegram whatsapp ;;
    parisahon-api/src/trigger/*|parisahon-client/app/pages/settings/deals/*) echo triggers ;;
    parisahon-api/src/analytics/*|parisahon-api/src/objective/*|parisahon-client/app/pages/analytics/*) echo analytics ;;
    parisahon-api/src/email/*|parisahon-client/app/pages/mails/*|parisahon-client/app/components/mail/*) echo mail ;;
    parisahon-api/src/calls/*) echo calls ftp ;;
    parisahon-client/app/pages/settings/calls/*) echo calls ;;
    parisahon-ftp/*|local/dev/ftp-env.sh) echo ftp ;;
    parisahon-api/src/migrations/*|parisahon-api/src/*/*.entity.ts) echo schema deals modules ;;
    parisahon-api/src/group/*|parisahon-api/src/task_type/*|parisahon-api/src/file/*|parisahon-api/src/linkable/*|parisahon-api/src/tracking/*|parisahon-api/src/setting/*) echo platform ;;
    parisahon-api/src/gateway/*|parisahon-client/app/composables/useLive.ts|parisahon-client/app/composables/useAsync.ts|parisahon-client/app/plugins/socket*|local/checks/live_socket.mjs|local/dev/live-browser.mjs) echo live ;;
    parisahon-client/app/components/deal/*) echo deals ui live ;;
    parisahon-client/app/components/trigger/*) echo triggers ui ;;
    parisahon-client/app/components/common/Event*) echo deals history telegram whatsapp ui ;;
    *Controller*.ts|*.controller.ts) echo auth ;;
  esac
  # a controller anywhere changes the route sweeps (auth: rights, smoke: every GET answers)
  case "$1" in *.controller.ts) echo auth smoke ;; esac
  # any page or component of the client: every page still opens
  case "$1" in parisahon-client/app/*.vue|parisahon-client/app/*/*.vue|parisahon-client/app/*/*/*.vue|parisahon-client/app/*/*/*/*.vue|parisahon-client/app/*.ts|parisahon-client/app/*/*.ts) echo ui ;; esac
  # any API source: the GET sweep
  case "$1" in parisahon-api/src/*) echo smoke ;; esac
}

flags=()
sets=()
changed=0
for a in "$@"; do
  case "$a" in --changed) changed=1 ;; -*) flags+=("$a") ;; *) sets+=("$a") ;; esac
done
if [ $changed -eq 1 ]; then
  # files changed since the last fully green run of this script (or all uncommitted ones)
  cd "$ROOT"
  if [ -f "$STAMP" ]; then
    files=$( { git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u | while read -r f; do [ -e "$f" ] && [ "$f" -nt "$STAMP" ] && echo "$f"; done)
  else
    files=$( { git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u)
  fi
  picked=$(for f in $files; do sets_for "$f"; done | tr ' ' '\n' | grep -v '^$' | sort -u)
  for s in "${ALL[@]}"; do echo "$picked" | grep -qx "$s" && sets+=("$s"); done
  if [ ${#sets[@]} -eq 0 ]; then
    echo "no check set covers the files changed since the last green run$( [ -n "$files" ] && echo ':' ; echo "$files" | head -20 | sed 's/^/  /')"
    exit 0
  fi
  echo "changed files -> sets: ${sets[*]}"
fi
[ ${#sets[@]} -eq 0 ] && sets=("${ALL[@]}")
failed=()
for s in "${sets[@]}"; do
  echo "=================== $s"
  if ! python3 "$ROOT/local/checks/${s}_check.py" "${flags[@]}"; then failed+=("$s"); fi
done
echo "==================="
if [ ${#failed[@]} -gt 0 ]; then echo "FAILED: ${failed[*]}"; exit 1; fi
echo "all green: ${sets[*]}"
touch "$STAMP"
