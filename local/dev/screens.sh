#!/usr/bin/env bash
# Screenshots of dev web pages at desktop and phone width: local/dev/screens.sh /path [/path ...]
# (SCREEN_TAB="Название вкладки" clicks a tab first). Files: local/dev/screens/*.png
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
if [ ! -d "$HERE/tools/node_modules/playwright-core" ]; then
  mkdir -p "$HERE/tools" && (cd "$HERE/tools" && { [ -f package.json ] || echo '{"private":true}' > package.json; } && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund --silent playwright-core@1.56.1)
fi
NODE_PATH="$HERE/tools/node_modules" cp "$HERE/screens.mjs" "$HERE/tools/screens.mjs" && exec node "$HERE/tools/screens.mjs" "$@"
