# Прод: root@138.197.184.63

Снимок рабочих настроек прода на 2026-11-22. Секретов здесь нет (они в `*.env` на сервере).

- `nginx.conf` — `/root/crm/parisahon-api/docker/nginx/nginx.conf` (контейнер `crm-nginx`, порт 80; HTTPS
  снимает traefik `app-traefik-1` и проксирует сюда). Блок `# crm-hardening-2026-11-22`: адрес клиента за
  traefik, лимит входа, закрытые снаружи служебные входы, http→https, заголовки.
- `compose.yml` — `/root/crm2/compose.yml`: `crm2-app` (API, образ из `api.Dockerfile` с ffmpeg),
  `crm2-telegram`, `crm2-whatsapp`, `crm2-ftp`, `crm2-stt`. Код — `/root/crm2/<сервис>`, база `crm-db`.
- Клиент: сборка `.output/public` лежит в `/root/crm/parisahon-client/app/.output/public`.

Правки прода делаются в репозитории и выкладываются отсюда; ручные правки на сервере не держатся.
