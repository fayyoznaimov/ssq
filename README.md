# Parisa CRM — локальная копия

Код скачан 2026-11-14 с прод-сервера `138.197.184.63` (`/root/crm`), вместе с git-историей,
незакоммиченными правками сервера и загруженными файлами. CRM в проде: https://crm.parisahome.com

## Состав

| Папка | Что это | Стек | Git remote |
|---|---|---|---|
| `parisahon-api` | Бэкенд | NestJS 10, TypeORM 0.3, Postgres 16, socket.io, imapflow + nodemailer | `NagaiMatsuge/parisahon-api`, ветка `test` |
| `parisahon-client` | Фронт («Houston») | Nuxt 3.7 SPA (`ssr: false`), Vue 3.4, Pinia, Tailwind, CKEditor | `oxygen-001/crm-parisahon-client`, ветка `main` |
| `parisahon-telegram-service` | Мост к Telegram (звонки/сообщения) | Python, Flask, Telethon-сессии, SQLite, ffmpeg | `NagaiMatsuge/parisahon-telegram-service` |
| `crm-db-prod-2026-11-14.sql.gz` | Дамп прод-базы (10 МБ, 30 таблиц) | `pg_dump --no-owner` | — |

⚠️ Дамп и `parisahon-api/public/uploads` содержат реальные данные клиентов. В git их не коммитить.

## Как устроен прод

```
crm.parisahome.com ──▶ Traefik (общий с сайтом parisahome) ──▶ crm-nginx:80
                                                            ├─ /api/v1/*      ─▶ crm-app:3000 (NestJS)
                                                            ├─ /socket.io     ─▶ crm-app:3000 (уведомления)
                                                            ├─ /uploads       ─▶ parisahon-api/public/uploads
                                                            └─ /              ─▶ parisahon-client/app/.output/public (собранная SPA)
crm-app ──▶ crm-db (Postgres 16.3)
crm-app ──▶ почтовый сервер parisahome.com (IMAP 993 / SMTP 465)
crm-app ──▶ crm-telegram:3030 (Flask)
```

Фронт в проде собирается вручную (`nuxt generate`), nginx отдаёт `.output/public` как статику.
API запускается как `nest start --watch` прямо из исходников (Dockerfile → `npm run start:dev`).

## Бэкенд: модули

`auth` (JWT, bcrypt) · `user` / `group` (роли: admin, agent…) · `deal` + `deal_stage` (воронки = collections, этапы, история этапов) ·
`company` / `contact` · `filler` (кастомные поля для сделок/компаний/пользователей/товаров) · `product` ·
`task` / `task_type` · `events` (лента событий по сделке) · `email` (IMAP-синхронизация, отправка, шаблоны, транспортёры) ·
`file` · `trigger` (автоматизации на этапах сделок: задача, письмо, смена агента/полей, удаление файлов) ·
`analytics` + `objective` (цели) · `telegram` · `notification` + `gateway` (socket.io) · `tracking` · `desktop` · `setting`.

При каждом старте `main.ts` прогоняет сиды: группы, admin-пользователь, воронка по умолчанию, этапы
(по именам из `DEAL_STAGE_*` в env), типы задач, настройки, плюс чинит сделки без воронки.
Схема БД ведётся миграциями TypeORM (`src/migrations`, 28 шт.).

Самые большие сервисы: `email.service.ts` (1279 строк), `deal.service.ts`, `trigger.service.ts`, `company.service.ts`.

## Фронт: разделы

Сделки (`deals`, канбан/список, карточка) · Списки (компании, контакты, товары, файлы, звонки) · Почта (`mails`) ·
Задачи (список, канбан, календарь) · Аналитика (продажи, менеджеры, звонки, цели, события) · Заявки (`requests`) ·
Telegram · Настройки (пользователи, группы, роли, триггеры, почтовые транспортёры).

Адрес API берётся из `runtimeConfig.public.apiUrl` (`composables/useApiUrl.ts`), адрес websocket из `runtimeConfig.public.socketUrl`.

## Локальный запуск

Нужен только Docker Desktop. Node ставить не надо, всё работает в контейнерах.

```bash
docker compose -f docker-compose.local.yml up -d
```

- Фронт: http://localhost:4100 (hot reload)
- API: http://localhost:8080/api/v1 (через nginx, как в проде)
- Postgres: `localhost:5434`, логин `root` / `passwd`, база `parisahon`

Первый запуск занимает ~10 минут: ставятся `node_modules`, разворачивается дамп, Nuxt делает первую сборку
(«Starting Nuxt…» / 503 на :4100 означает, что сборка ещё идёт). Дальше старт быстрый.

Вход (и прод, и локально): `admin@gmail.com`, пароль хранится в `parisahon-api/.env` → `ADMIN_PASSWORD`
(см. `local/LOCAL_LOGIN.txt`). У остальных пользователей пароли как в проде (bcrypt-хэши из дампа).

Фронт ставится через **pnpm 9 + Node 20** с `--frozen-lockfile`. `app/pnpm-lock.yaml` имеет формат 9.0, а
`app/Dockerfile` ставит pnpm 7, который этот lock-файл не читает и подбирает самые свежие версии. Так прод-сборка
и получила версии, не совпадающие с lock-файлом. Сейчас свежий `nuxi` на Node 16 вообще не запускается.

API в фоне каждые 5 минут гоняет планировщик триггеров (`src/trigger/trigger.scheduler.ts`). Локально
его письма уходят в GreenMail.

Логи: `docker compose -f docker-compose.local.yml logs -f crm-app front`
Перезалить базу с нуля: `docker compose -f docker-compose.local.yml down -v`, потом `up -d`.

### Изоляция от прода

- `local/api.env` переопределяет **все** ключи из прод `parisahon-api/.env`, поэтому прод-секреты локально не используются.
- Почта уходит в локальный GreenMail (контейнер `mail`), с реальным почтовым ящиком ничего не происходит.
- Telegram-сервис локально не запускается, адрес у API заглушка. Telegram-функции будут отдавать ошибку.
- Фронт ходит только на localhost (`NUXT_PUBLIC_API_URL`, `NUXT_PUBLIC_SOCKET_URL`).

## Правки относительно сервера

- `parisahon-client`, ветка `local-dev-setup`: адрес websocket вынесен в `runtimeConfig.public.socketUrl`
  (по умолчанию прод-адрес, поэтому прод-сборка ведёт себя как раньше).
- `parisahon-api` (ветка `test`): на сервере остались незакоммиченные правки `compose.yml` и nginx-конфигов. Они скачаны как есть.
- `parisahon-client/pnpm-lock.yaml` (в корне, не отслеживается git) остался от серверной установки pnpm 7. Для локального запуска он не нужен.
