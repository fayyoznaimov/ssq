#!/usr/bin/env bash
# parisahome.com: the same built site in images without build leftovers (npm cache, webpack cache,
# intermediate layers). Nothing is rebuilt from source: the files of the running images are copied
# onto a clean node:18-alpine base. Each service is switched separately and rolled back if the site
# answers differently than before.  Usage: site_slim.sh build | switch | finish
set -uo pipefail
ENVF=/var/www/.env
CF=/var/www/app/docker-compose.yml
DC="docker compose --env-file $ENVF -f $CF"
W=/root/crm2/ops/state/site-slim
mkdir -p "$W"; chmod 700 "$W"

tree_sum() {  # checksum of every file under /build of an image (without the caches that are dropped)
  docker run --rm --entrypoint sh "$1" -c "cd /build && find . -type f -not -path './.next/cache/*' -not -path './admin/.next/cache/*' -not -path './uploads/*' -not -path './documents/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-24; echo \"links \$(find . -type l | wc -l) exec \$(find . -type f -perm -u+x -not -path './.next/cache/*' -not -path './admin/.next/cache/*' | wc -l) node \$(node -v)\""
}

probe() {  # what the site answers: status and size per address
  for u in $(cat "$W/urls.txt"); do
    code=$(curl -s -o /tmp/site-probe.out -L --compressed -m 30 -w "%{http_code}" "$u")
    echo "$code $(wc -c < /tmp/site-probe.out) $u"
  done
}

same_answers() {  # same status everywhere; sizes within 3% (pages carry request ids)
  paste -d' ' "$1" "$2" | awk '{ if ($1 != $4) bad=1; d=$2-$5; if (d<0) d=-d; if ($2 > 2000 && d > $2*0.03) bad=1 } END { exit bad }'
}

case "${1:-}" in
build)
  set -e
  # addresses to compare before and after: pages of every language, the admin, list calls of the API
  { for p in /ru /en /uz /jp /ru/catalog /ru/about /ru/contacts /admin; do echo "https://parisahome.com$p"; done
    for c in $(docker exec api sh -c "grep -rhoE \"Controller\\(['\\\"][a-zA-Z/_-]+['\\\"]\\)\" /build/dist" | grep -oE "['\"][a-zA-Z/_-]+['\"]" | tr -d "'\"" | sort -u); do
      u="https://parisahome.com/api/v1/$c"
      if [ "$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$u")" = 200 ]; then echo "$u"; fi
    done
  } > "$W/urls.txt"
  echo "addresses to compare: $(wc -l < "$W/urls.txt")"
  probe > "$W/before.txt"; cat "$W/before.txt"

  build_one() {  # service, port, cache folder to drop, command
    local svc=$1 port=$2 cache=$3; shift 3
    printf 'FROM app-%s:latest AS build\nRUN rm -rf %s /root/.npm\nFROM node:18-alpine\nCOPY --from=build /build /build\nCMD %s\nEXPOSE %s\n' "$svc" "$cache" "$*" "$port" \
      | docker build -q -t "app-$svc:slim" - > /dev/null
    a=$(tree_sum "app-$svc:latest"); b=$(tree_sum "app-$svc:slim")
    echo "$svc: $(docker images --format '{{.Size}}' app-$svc:latest) -> $(docker images --format '{{.Size}}' app-$svc:slim)   files identical: $([ "$a" = "$b" ] && echo yes || echo NO)"
    [ "$a" = "$b" ] || { echo "  old: $a"; echo "  new: $b"; exit 1; }
  }
  build_one app 3000 /build/.next/cache '["npm", "run", "start", "--prefix", "./build"]'
  build_one admin 4040 /build/admin/.next/cache '["npm", "run", "start", "--prefix", "./build"]'
  build_one api 3030 /nonexistent '["node", "/build/dist/main.js"]'

  # the resized pictures made so far move to a folder that survives redeploys
  mkdir -p /var/www/volumes/next-image-cache
  docker cp app:/build/.next/cache/images/. /var/www/volumes/next-image-cache/
  echo "picture cache kept: $(du -sh /var/www/volumes/next-image-cache | cut -f1), $(find /var/www/volumes/next-image-cache -type f | wc -l) files"

  # a trial copy of the site and the admin next to the live ones (not reachable from outside)
  docker rm -f app-slim-test admin-slim-test >/dev/null 2>&1 || true
  for svc in app admin; do
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $svc | grep -v '^$' > "$W/$svc.env"; chmod 600 "$W/$svc.env"
  done
  docker run -d --name app-slim-test --network app_dropin --env-file "$W/app.env" -v /var/www/volumes/next-image-cache:/build/.next/cache/images app-app:slim >/dev/null
  docker run -d --name admin-slim-test --network app_dropin --env-file "$W/admin.env" app-admin:slim >/dev/null
  sleep 12
  get() { docker exec app sh -c "wget -q -O /tmp/t.out '$1' 2>/dev/null; echo \$? \$(wc -c < /tmp/t.out 2>/dev/null)"; }
  echo "page /ru        live: $(get http://localhost:3000/ru)   trial: $(get http://app-slim-test:3000/ru)"
  echo "page /en        live: $(get http://localhost:3000/en)   trial: $(get http://app-slim-test:3000/en)"
  IMG='/_next/image?url=%2Fimages%2Fhero%2Fhero-towels-green.webp&w=1080&q=70'
  echo "resized picture live: $(get "http://localhost:3000$IMG")   trial: $(get "http://app-slim-test:3000$IMG")"
  echo "admin /admin    live: $(get http://admin:3001/admin)   trial: $(get http://admin-slim-test:3001/admin)"
  echo "trial logs:"; docker logs app-slim-test 2>&1 | tail -3; docker logs admin-slim-test 2>&1 | tail -2
  docker rm -f app-slim-test admin-slim-test >/dev/null
  rm -f "$W/app.env" "$W/admin.env"
  ;;

switch)
  cp -p "$CF" "$CF.before-slim-2026-11-22"
  # keep the resized pictures between redeploys
  python3 - "$CF" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
if "next-image-cache" not in text:
    anchor = "            - traefik.http.services.app.loadbalancer.server.port=3000\n"
    assert text.count(anchor) == 1
    text = text.replace(anchor, anchor + (
        "        volumes:\n"
        "            # resized pictures (next/image): kept between redeploys, so the first visitors\n"
        "            # after a deploy do not wait for every picture to be encoded again\n"
        "            - ../volumes/next-image-cache:/build/.next/cache/images\n"), 1)
    open(path, "w", encoding="utf-8").write(text)
PY
  $DC config -q || { echo "compose file invalid, restored"; cp -p "$CF.before-slim-2026-11-22" "$CF"; exit 1; }
  for svc in api admin app; do
    docker tag "app-$svc:latest" "app-$svc:before-slim"
    docker tag "app-$svc:slim" "app-$svc:latest"
    $DC up -d --no-deps --no-build "$svc" > /dev/null 2>&1
    ok=0
    for i in $(seq 1 20); do
      sleep 3
      probe > "$W/after-$svc.txt"
      if same_answers "$W/before.txt" "$W/after-$svc.txt"; then ok=1; break; fi
    done
    if [ $ok = 1 ]; then
      echo "$svc switched: the site answers as before ($(docker inspect -f '{{.State.Status}}' $svc), image $(docker images --format '{{.Size}}' app-$svc:latest))"
    else
      echo "$svc: the site answers differently, ROLLING BACK"; paste -d' ' "$W/before.txt" "$W/after-$svc.txt" | awk '$1 != $4 || $2 != $5' | head -5
      docker tag "app-$svc:before-slim" "app-$svc:latest"
      [ "$svc" = app ] && cp -p "$CF.before-slim-2026-11-22" "$CF"
      $DC up -d --no-deps --no-build "$svc" > /dev/null 2>&1
      sleep 10; probe > "$W/after-rollback.txt"; same_answers "$W/before.txt" "$W/after-rollback.txt" && echo "rolled back, the site answers as before" || echo "ATTENTION: answers still differ after the rollback"
      exit 1
    fi
  done
  echo "containers:"; docker ps --format '{{.Names}} {{.Status}} {{.Image}}' | grep -E "^(app|admin|api|database|app-traefik-1) "
  ;;

finish)
  probe > "$W/final.txt"
  same_answers "$W/before.txt" "$W/final.txt" || { echo "answers differ from the reference, old images are kept"; paste -d' ' "$W/before.txt" "$W/final.txt" | awk '$1 != $4' ; exit 1; }
  for svc in app admin api; do docker rmi "app-$svc:before-slim" "app-$svc:slim" >/dev/null 2>&1 || true; done
  docker image prune -f | tail -1
  docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep -E "^app-"
  ;;
*) echo "usage: $0 build|switch|finish"; exit 2 ;;
esac
