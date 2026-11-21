# Parisa CRM — карта проекта для сессий Claude

Карта кода (схемы модулей, событий, таблиц) — `docs/CODEMAP.md`, пересобирается `python3 local/dev/codemap.py`.

Пользователь пишет по-русски, часто с телефона: отвечать коротко. Секреты (`*.env`, `db.pass`, токены) не печатать. Коммит и push — только по прямой команде пользователя. `openclaw-gateway` и `~/.openclaw` не трогать. Аудит, решения и журнал правок — `docs/AUDIT.md` (раздел 7 — как работать на сервере).

## Как делать правку (быстро)
1. Найти модуль по карте ниже, читать только его файлы (крупные файлы — по `grep -n`, не целиком).
2. Правка. API: `npx tsc --noEmit -p tsconfig.json` в `parisahon-api` (node 20: `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH`).
3. Проверка только затронутого: `local/dev/check.sh --changed` (наборы по изменённым файлам) или `local/dev/check.sh <набор>`.
4. Фронт: снимки страниц `local/dev/screens.sh /lists/companies/1 …` (ПК и телефон) — посмотреть и отправить пользователю.
5. Выкладка только нужной части: `local/deploy.sh web`, `local/deploy.sh api` (миграции — сами) `local/deploy.sh telegram`, `local/deploy.sh whatsapp`, `local/deploy.sh stt` или `local/deploy.sh ftp`.
6. Отчёт в 3–5 строк; запись в `docs/AUDIT.md`, только если менялось поведение.

## Окружение на сервере
- Репозиторий `~/parisahome-crm`. Dev-копия: API :3100 (`nest --watch`, пересобирается сам), web http://172.0.30.4:4150 (hot reload), база `parisahon_dev`, конфиг `local/dev/api.env`. Юниты `local/dev/units.sh status|restart|logs <unit>`.
- Пробная копия с боевыми данными: `~/parisa-crm`, http://172.0.30.4:4300, API :3000 — только через `local/deploy.sh`, данные не трогать.
- Нет docker, psql и системного ffmpeg: `local/dev/psql.js -At -c "select …"` (dev-база), ffmpeg — `local/dev/bin/ffmpeg`.
- Команда в окружении dev API: `local/dev/in-app.sh <cmd>` (например миграции: `local/dev/in-app.sh npx typeorm -d dist/datasource.js migration:run`).

## Карта модулей: API (`parisahon-api/src`) → фронт (`parisahon-client/app`) → проверка (`local/checks`)
| Блок | API | Фронт | Набор |
|---|---|---|---|
| Вход, роли, общая защита | `auth/`, `app.module.ts` (глобальный `AuthGuard`, `@Public()`, `@Roles`) | `middleware/auth.global.ts`, `utils/casl.ts`, `app.config.ts` (меню) | auth |
| Сделки, воронки, этапы | `deal/` (`client-history.service.ts` — блок «Клиент» и сделки компании / контакта), `deal_stage/`, `events/` (история) | `pages/deals/`, `components/deal/` (вкладки сделки), `pages/settings/deals/index.vue` | deals |
| Компании, контакты, товары, доп. поля, задачи, рабочий стол | `company/`, `contact/`, `user/`, `product/`, `filler/`, `task/`, `task_type/`, `desktop/` | `pages/lists/companies/[id].vue` + `components/company/` (вкладки и лента компании), `stores/ctrAgents.ts`, `pages/lists/*`, `pages/tasks.vue`, `pages/index.vue` | modules |
| Группы, сотрудники, типы задач, поиск, журнал, настройки, список файлов | `group/`, `user/`, `task_type/`, `linkable/`, `tracking/`, `setting/`, `file/` | `pages/settings/*`, `pages/requests/` | platform |
| Распознавание карточек | `recognition/` (Claude CLI) | `components/company/CardRecognition.vue` | recognition |
| Бот CRM в Telegram | `bot/` (голосовые: `bot-speech.service.ts` → сервис `parisahon-stt/`, faster-whisper) | `pages/profile/index.vue` | bot |
| Telegram-чат менеджеров | `telegram/` (приёмник `/telegram/incoming`) + `parisahon-telegram-service/` | `pages/telegram/`, `components/modals/TelegramConfirmation.vue` | telegram |
| Общее для Telegram и WhatsApp | `messenger/`: `client-deals.service.ts` (в какую сделку идёт сообщение, повторное обращение), `messenger-lookup.service.ts` (поиск номера во втором мессенджере) | `components/deal/ClientBlock.vue` | telegram, whatsapp |
| WhatsApp менеджеров (по QR, как WhatsApp Web) | `whatsapp/` (приёмник `/whatsapp/incoming`) + `parisahon-whatsapp-service/` (Node, Baileys) | `components/whatsapp/WhatsAppConnect.vue` (профиль), тип «WhatsApp» в сделке | whatsapp |
| Триггеры | `trigger/` (`trigger.service` — настройка и расписание `trigger_run`, `trigger-actions.service` — действия, планировщик) | `components/trigger/` (формы), `pages/settings/deals/index.vue` | triggers |
| Аналитика и цели | `analytics/`, `objective/` | `pages/analytics/` | analytics |
| Почта | `email/`: `email.service.ts` — фасад; IMAP `mail-connection`/`mail-sync`, отправка `mail-sending`, ящик `mailbox`, история `mail-history`; сервер — переменные `EMAIL_*` | `pages/mails/`, `components/mail/` | mail |
| Записи звонков | `calls/` (`/calls/upload`, очередь, токены рекордера; `recording-name.ts` — номер, направление и время из имени файла; `call-client.service.ts` — чей звонок, в т.ч. по имени из Telegram-контактов; `call-deal.service.ts` — кнопка «Создать сделку») + `parisahon-ftp/` (Python, pyftpdlib: телефон шлёт папку записей по FTP, пароль — токен рекордера) | `pages/settings/calls/`, `pages/lists/calls/` | calls, ftp |
| Живое обновление страниц | `gateway/` (сокет, `live-updates.subscriber.ts` шлёт `changed` с темами и id) | `composables/useLive.ts` (страница сама перечитывает данные) | live |

Наборы на весь проект: `schema` (миграции применены, сущности совпадают с базой), `smoke` (каждый GET API с реальными id и временем), `ui` (каждая страница фронта без ошибок JS и 5xx), `auth` (права на всех маршрутах).

Миграции — `parisahon-api/src/migrations/<timestamp>-<name>.ts`, имя класса `<Name><timestamp>`. Новый индекс — и в миграции, и `@Index` на сущности (иначе `schema` упадёт). Сущности TypeORM рядом с сервисом.

В `pages/` — только страницы: компонент, положенный туда, становится лишним адресом (раньше так было с `/deals/main-tab`).

## Правила, о которые уже спотыкались
- Один `@Controller` на файл: `auth_check` разбирает маршруты по файлам. Новый публичный маршрут — `@Public()` + обновить `PUBLIC_ROUTES`/`SELF_AUTH_ROUTES` и счётчик в `local/checks/auth_check.py`.
- TypeORM: `where: { x: null }` — это «без условия», нужен `IsNull()`. Не сохранять сущности с циклическими связями (компания ↔ контакт) через `save()` целиком — `update(id, {...})`.
- Обязательные доп. поля проверяет сервер; данные из каналов (Telegram, бот, визитка) создаются с `skipRequiredFields`.
- Время: всё в `Asia/Karachi` — и то, что пишет API, и то, что заполняет база (`created_at`, `now()`): зона задана базе и подключению (миграция `1794960000000-time-zone`, `datasource.ts`). Не возвращать UTC.
- Фронт: не запускать `nuxt build` в репозитории — он перезаписывает `.nuxt` работающего dev-сайта, и тот отдаёт старую сборку (лечится `local/dev/units.sh restart crm-dev-web`). Сборка — только `local/deploy.sh web`.
- Новая страница со списком или лентой — подключить `useLive(...)`, иначе она не обновится сама.
- Фронт, телефон: в Tailwind этого проекта `xs:` — это «уже 640 px» (max-width), а варианты `max-sm:` / `max-lg:` не генерируются и молча не работают; для телефона писать `xs:` или базовый класс + `lg:`. Обёртка страницы с `overflow-x-hidden`, поэтому проверка «шире экрана» не срабатывает — обрезание видно только на снимке телефона.
- Фронт: таблица вкладок/меню узкая — длинные подписи переносятся и ломают вёрстку; проверять снимком на ширине ПК и телефона.
- Каждый проверочный набор создаёт только строки `AUDIT*` и убирает их; данные dev-копии можно пересоздать `node local/dev/db.js recreate`.
