# Карта кода Parisa CRM

Сгенерировано `python3 local/dev/codemap.py` из исходников и dev-базы — не править руками. Как работать с модулями — `CLAUDE.md`.

## 1. Обзор: фронт → блоки API → таблицы

Блоки — группы модулей API по смыслу; цилиндр — таблицы блока.

```mermaid
flowchart LR
  WEB["Фронт<br/>parisahon-client/app"]
  TG["Telegram-сервис<br/>(Python)"]
  REC["Рекордер<br/>звонков"]
  B_Вход_и_права["<b>Вход и права</b><br/>Auth, User, Group"]
  D_Вход_и_права[("deal, file, group, user, user_filler")]
  B_Вход_и_права --> D_Вход_и_права
  B_Сделки["<b>Сделки</b><br/>Deal, DealStage, Events, Trigger"]
  D_Сделки[("collection, company, deal, deal_filler, deal_stage, deal_stage_record, email, event, setting, task, trigger, trigger_run, user")]
  B_Сделки --> D_Сделки
  B_Клиенты_и_справочники["<b>Клиенты и справочники</b><br/>Company, Contact, Product, Filler, Task, TaskType, Desktop, Linkable"]
  D_Клиенты_и_справочники[("company, company_filler, deal, filler, product, product_filler, task, task_type, user, user_filler")]
  B_Клиенты_и_справочники --> D_Клиенты_и_справочники
  B_Каналы["<b>Каналы</b><br/>Email, Telegram, Bot, Calls, Recognition"]
  D_Каналы[("bot_account, bot_link_code, bot_reminder, call_upload, company, deal, email, email_template, email_to, email_transporter, event, file, recorder_token, recording, user")]
  B_Каналы --> D_Каналы
  B_Отчёты["<b>Отчёты</b><br/>Analytics, Objective, Tracking"]
  D_Отчёты[("company, deal, deal_stage, deal_stage_record, event, group, recording, task, user")]
  B_Отчёты --> D_Отчёты
  B_Служебные["<b>Служебные</b><br/>File, Helper, Messenger, NotificationGateWay, Notification, Seed, Setting, WhatsApp"]
  D_Служебные[("collection, deal, deal_stage, event, file, group, notification, setting, task_type, user")]
  B_Служебные --> D_Служебные
  WEB --> B_Вход_и_права
  WEB --> B_Каналы
  WEB --> B_Клиенты_и_справочники
  WEB --> B_Отчёты
  WEB --> B_Сделки
  WEB --> B_Служебные
  TG -->|POST /telegram/incoming<br/>POST /calls/upload| B_Каналы
  REC -->|POST /calls/upload| B_Каналы
```

### Блок «Вход и права»: страницы → модули → таблицы

```mermaid
flowchart LR
  AuthModule["<b>Auth</b><br/>/auth"]
  UserModule["<b>User</b><br/>/users"]
  UserModule --> T_deal[("deal")]
  UserModule --> T_file[("file")]
  UserModule --> T_user[("user")]
  UserModule --> T_user_filler[("user_filler")]
  GroupModule["<b>Group</b><br/>/groups"]
  GroupModule --> T_group[("group")]
  W_analytics(["analytics"]) --> UserModule
  W_components_common(["components/common"]) --> UserModule
  W_components_company(["components/company"]) --> UserModule
  W_components_deal(["components/deal"]) --> UserModule
  W_components_mail(["components/mail"]) --> UserModule
  W_components_modals(["components/modals"]) --> UserModule
  W_deals(["deals"]) --> UserModule
  W_index(["index"]) --> UserModule
  W_lists(["lists"]) --> UserModule
  W_mails(["mails"]) --> UserModule
  W_profile(["profile"]) --> GroupModule
  W_profile(["profile"]) --> UserModule
  W_settings(["settings"]) --> GroupModule
  W_settings(["settings"]) --> UserModule
  W_tasks(["tasks"]) --> UserModule
  W_whatsapp(["whatsapp"]) --> UserModule
```

### Блок «Сделки»: страницы → модули → таблицы

```mermaid
flowchart LR
  DealModule["<b>Deal</b><br/>/deals"]
  DealModule --> T_company[("company")]
  DealModule --> T_deal[("deal")]
  DealModule --> T_deal_filler[("deal_filler")]
  DealModule --> T_deal_stage_record[("deal_stage_record")]
  DealStageModule["<b>DealStage</b><br/>/stages"]
  DealStageModule --> T_collection[("collection")]
  DealStageModule --> T_deal[("deal")]
  DealStageModule --> T_deal_stage[("deal_stage")]
  DealStageModule --> T_setting[("setting")]
  EventsModule["<b>Events</b>"]
  EventsModule --> T_deal[("deal")]
  EventsModule --> T_email[("email")]
  EventsModule --> T_event[("event")]
  EventsModule --> T_user[("user")]
  TriggerModule["<b>Trigger</b><br/>/stages, /triggers"]
  TriggerModule --> T_deal[("deal")]
  TriggerModule --> T_task[("task")]
  TriggerModule --> T_trigger[("trigger")]
  TriggerModule --> T_trigger_run[("trigger_run")]
  W_components_common(["components/common"]) --> DealModule
  W_components_deal(["components/deal"]) --> DealModule
  W_components_deal(["components/deal"]) --> DealStageModule
  W_components_mail(["components/mail"]) --> DealModule
  W_components_modals(["components/modals"]) --> DealStageModule
  W_components_trigger(["components/trigger"]) --> DealStageModule
  W_deals(["deals"]) --> DealModule
  W_deals(["deals"]) --> DealStageModule
  W_lists(["lists"]) --> DealStageModule
  W_mails(["mails"]) --> DealModule
  W_mails(["mails"]) --> DealStageModule
  W_settings(["settings"]) --> DealStageModule
  W_tasks(["tasks"]) --> DealStageModule
```

### Блок «Клиенты и справочники»: страницы → модули → таблицы

```mermaid
flowchart LR
  CompanyModule["<b>Company</b><br/>/companies"]
  CompanyModule --> T_company[("company")]
  CompanyModule --> T_company_filler[("company_filler")]
  CompanyModule --> T_deal[("deal")]
  CompanyModule --> T_user[("user")]
  ContactModule["<b>Contact</b><br/>/contacts"]
  ContactModule --> T_company[("company")]
  ContactModule --> T_company_filler[("company_filler")]
  ContactModule --> T_user[("user")]
  ContactModule --> T_user_filler[("user_filler")]
  ProductModule["<b>Product</b><br/>/products"]
  ProductModule --> T_product[("product")]
  ProductModule --> T_product_filler[("product_filler")]
  FillerModule["<b>Filler</b><br/>/fillers"]
  FillerModule --> T_filler[("filler")]
  TaskModule["<b>Task</b><br/>/tasks"]
  TaskModule --> T_task[("task")]
  TaskTypeModule["<b>TaskType</b><br/>/task-types"]
  TaskTypeModule --> T_task_type[("task_type")]
  DesktopModule["<b>Desktop</b><br/>/desktop"]
  LinkableModule["<b>Linkable</b><br/>/linkables"]
  W_analytics(["analytics"]) --> ProductModule
  W_components_common(["components/common"]) --> ContactModule
  W_components_common(["components/common"]) --> TaskModule
  W_components_common(["components/common"]) --> TaskTypeModule
  W_components_company(["components/company"]) --> CompanyModule
  W_components_company(["components/company"]) --> FillerModule
  W_components_company(["components/company"]) --> TaskModule
  W_components_deal(["components/deal"]) --> CompanyModule
  W_components_deal(["components/deal"]) --> ContactModule
  W_components_deal(["components/deal"]) --> FillerModule
  W_components_deal(["components/deal"]) --> ProductModule
  W_components_deal(["components/deal"]) --> TaskModule
  W_components_mail(["components/mail"]) --> CompanyModule
  W_components_mail(["components/mail"]) --> ContactModule
  W_components_mail(["components/mail"]) --> FillerModule
  W_components_task(["components/task"]) --> LinkableModule
  W_components_task(["components/task"]) --> TaskModule
  W_components_task(["components/task"]) --> TaskTypeModule
  W_components_trigger(["components/trigger"]) --> TaskTypeModule
  W_deals(["deals"]) --> FillerModule
  W_index(["index"]) --> DesktopModule
  W_lists(["lists"]) --> CompanyModule
  W_lists(["lists"]) --> ContactModule
  W_lists(["lists"]) --> FillerModule
  W_lists(["lists"]) --> ProductModule
  W_lists(["lists"]) --> TaskModule
  W_settings(["settings"]) --> FillerModule
  W_tasks(["tasks"]) --> TaskModule
  W_tasks(["tasks"]) --> TaskTypeModule
```

### Блок «Каналы»: страницы → модули → таблицы

```mermaid
flowchart LR
  EmailModule["<b>Email</b><br/>/emails"]
  EmailModule --> T_deal[("deal")]
  EmailModule --> T_email[("email")]
  EmailModule --> T_email_template[("email_template")]
  EmailModule --> T_email_to[("email_to")]
  EmailModule --> T_email_transporter[("email_transporter")]
  EmailModule --> T_event[("event")]
  EmailModule --> T_user[("user")]
  TelegramModule["<b>Telegram</b><br/>/telegram"]
  TelegramModule --> T_deal[("deal")]
  TelegramModule --> T_event[("event")]
  TelegramModule --> T_file[("file")]
  TelegramModule --> T_user[("user")]
  BotModule["<b>Bot</b><br/>/bot"]
  BotModule --> T_bot_account[("bot_account")]
  BotModule --> T_bot_link_code[("bot_link_code")]
  BotModule --> T_bot_reminder[("bot_reminder")]
  CallsModule["<b>Calls</b><br/>/calls"]
  CallsModule --> T_call_upload[("call_upload")]
  CallsModule --> T_deal[("deal")]
  CallsModule --> T_recorder_token[("recorder_token")]
  CallsModule --> T_recording[("recording")]
  CallsModule --> T_user[("user")]
  RecognitionModule["<b>Recognition</b><br/>/companies"]
  RecognitionModule --> T_company[("company")]
  RecognitionModule --> T_user[("user")]
  W_components_common(["components/common"]) --> EmailModule
  W_components_company(["components/company"]) --> TelegramModule
  W_components_deal(["components/deal"]) --> TelegramModule
  W_components_mail(["components/mail"]) --> EmailModule
  W_components_modals(["components/modals"]) --> TelegramModule
  W_components_trigger(["components/trigger"]) --> EmailModule
  W_lists(["lists"]) --> TelegramModule
  W_mails(["mails"]) --> EmailModule
  W_profile(["profile"]) --> BotModule
  W_settings(["settings"]) --> CallsModule
  W_settings(["settings"]) --> EmailModule
  W_telegram(["telegram"]) --> TelegramModule
```

### Блок «Отчёты»: страницы → модули → таблицы

```mermaid
flowchart LR
  AnalyticsModule["<b>Analytics</b><br/>/analytics"]
  AnalyticsModule --> T_company[("company")]
  AnalyticsModule --> T_deal[("deal")]
  AnalyticsModule --> T_deal_stage[("deal_stage")]
  AnalyticsModule --> T_deal_stage_record[("deal_stage_record")]
  AnalyticsModule --> T_event[("event")]
  AnalyticsModule --> T_recording[("recording")]
  AnalyticsModule --> T_task[("task")]
  AnalyticsModule --> T_user[("user")]
  ObjectiveModule["<b>Objective</b><br/>/analytics"]
  ObjectiveModule --> T_deal[("deal")]
  ObjectiveModule --> T_group[("group")]
  ObjectiveModule --> T_user[("user")]
  TrackingModule["<b>Tracking</b><br/>/logs"]
  TrackingModule --> T_event[("event")]
  W_analytics(["analytics"]) --> AnalyticsModule
  W_analytics(["analytics"]) --> TrackingModule
  W_index(["index"]) --> AnalyticsModule
```

### Блок «Служебные»: страницы → модули → таблицы

```mermaid
flowchart LR
  FileModule["<b>File</b><br/>/files"]
  FileModule --> T_event[("event")]
  FileModule --> T_file[("file")]
  HelperModule["<b>Helper</b>"]
  MessengerModule["<b>Messenger</b>"]
  MessengerModule --> T_deal[("deal")]
  MessengerModule --> T_event[("event")]
  MessengerModule --> T_user[("user")]
  NotificationGateWayModule["<b>NotificationGateWay</b>"]
  NotificationModule["<b>Notification</b>"]
  NotificationModule --> T_notification[("notification")]
  SeedModule["<b>Seed</b>"]
  SeedModule --> T_collection[("collection")]
  SeedModule --> T_deal_stage[("deal_stage")]
  SeedModule --> T_group[("group")]
  SeedModule --> T_setting[("setting")]
  SeedModule --> T_task_type[("task_type")]
  SeedModule --> T_user[("user")]
  SettingModule["<b>Setting</b><br/>/settings"]
  SettingModule --> T_setting[("setting")]
  WhatsAppModule["<b>WhatsApp</b><br/>/whatsapp"]
  WhatsAppModule --> T_deal[("deal")]
  WhatsAppModule --> T_event[("event")]
  WhatsAppModule --> T_file[("file")]
  WhatsAppModule --> T_user[("user")]
  W_components_deal(["components/deal"]) --> SettingModule
  W_components_deal(["components/deal"]) --> WhatsAppModule
  W_components_mail(["components/mail"]) --> SettingModule
  W_components_whatsapp(["components/whatsapp"]) --> WhatsAppModule
  W_index(["index"]) --> FileModule
  W_lists(["lists"]) --> FileModule
  W_whatsapp(["whatsapp"]) --> WhatsAppModule
```

## 2. Зависимости модулей API

Стрелка: модуль импортирует другой модуль (Nest `imports`).

```mermaid
flowchart LR
  AuthModule --> UserModule
  BotModule --> CompanyModule
  BotModule --> RecognitionModule
  BotModule --> TaskModule
  CallsModule --> MessengerModule
  CompanyModule --> DealModule
  CompanyModule --> EventsModule
  CompanyModule --> FileModule
  CompanyModule --> FillerModule
  CompanyModule --> UserModule
  DealModule --> DealStageModule
  DealModule --> EventsModule
  DealModule --> FileModule
  DealModule --> FillerModule
  DealModule --> TriggerModule
  DealModule --> UserModule
  MessengerModule --> DealModule
  ProductModule --> FillerModule
  TaskModule --> EventsModule
  TaskModule --> NotificationGateWayModule
  TelegramModule --> DealModule
  TelegramModule --> FileModule
  TelegramModule --> MessengerModule
  TelegramModule --> TriggerModule
  TriggerModule --> EmailModule
  TriggerModule --> FileModule
  TriggerModule --> NotificationGateWayModule
  UserModule --> EventsModule
  UserModule --> FillerModule
  WhatsAppModule --> DealModule
  WhatsAppModule --> FileModule
  WhatsAppModule --> MessengerModule
  %% every module also uses HelperModule (common helpers)
```

## 3. События между модулями

Модуль генерирует событие (`EventEmitter.emit`) → модули, которые его слушают (`@OnEvent`). Через события пишется история сделки и срабатывают триггеры.

```mermaid
flowchart LR
  E_NEW_CALL_RECORDING(["NEW_CALL_RECORDING"])
  CallsModule --> E_NEW_CALL_RECORDING
  E_NEW_CALL_RECORDING --> EventsModule
  E_NEW_CALL_RECORDING --> TriggerModule
  E_NEW_COMPANY(["NEW_COMPANY"])
  DealModule --> E_NEW_COMPANY
  E_NEW_COMPANY --> EventsModule
  E_NEW_CTR_AGENT(["NEW_CTR_AGENT"])
  DealModule --> E_NEW_CTR_AGENT
  E_NEW_CTR_AGENT --> EventsModule
  E_NEW_DEAL(["NEW_DEAL"])
  DealModule --> E_NEW_DEAL
  TriggerModule --> E_NEW_DEAL
  E_NEW_DEAL --> EventsModule
  E_NEW_DEAL_STAGE(["NEW_DEAL_STAGE"])
  DealModule --> E_NEW_DEAL_STAGE
  E_NEW_DEAL_STAGE --> EventsModule
  E_NEW_EMAIL(["NEW_EMAIL"])
  EmailModule --> E_NEW_EMAIL
  E_NEW_EMAIL --> EventsModule
  E_NEW_EMAIL --> TriggerModule
  E_NEW_FIELD_VALUE(["NEW_FIELD_VALUE"])
  CompanyModule --> E_NEW_FIELD_VALUE
  DealModule --> E_NEW_FIELD_VALUE
  ProductModule --> E_NEW_FIELD_VALUE
  TriggerModule --> E_NEW_FIELD_VALUE
  UserModule --> E_NEW_FIELD_VALUE
  E_NEW_FIELD_VALUE --> EventsModule
  E_NEW_PRODUCT(["NEW_PRODUCT"])
  DealModule --> E_NEW_PRODUCT
  E_NEW_PRODUCT --> EventsModule
  E_NEW_TASK(["NEW_TASK"])
  TaskModule --> E_NEW_TASK
  TriggerModule --> E_NEW_TASK
  E_NEW_TASK --> EventsModule
  E_NEW_TASK_STATUS(["NEW_TASK_STATUS"])
  TaskModule --> E_NEW_TASK_STATUS
  TriggerModule --> E_NEW_TASK_STATUS
  E_NEW_TASK_STATUS --> EventsModule
  E_NEW_TELEGRAM_MESSAGE(["NEW_TELEGRAM_MESSAGE"])
  E_NEW_TELEGRAM_MESSAGE --> EventsModule
```

## 4. Таблицы и внешние ключи

Стрелка: таблица ссылается на другую (внешний ключ).

```mermaid
flowchart LR
  user[user] --> group[group]
  user[user] --> company[company]
  bot_account[bot_account] --> user[user]
  bot_reminder[bot_reminder] --> task[task]
  call_upload[call_upload] --> user[user]
  call_upload[call_upload] --> recording[recording]
  company[company] --> user[user]
  company_filler[company_filler] --> company[company]
  company_filler[company_filler] --> filler[filler]
  deal[deal] --> user[user]
  deal[deal] --> company[company]
  deal[deal] --> deal_stage[deal_stage]
  deal_file[deal_file] --> deal[deal]
  deal_file[deal_file] --> file[file]
  deal_filler[deal_filler] --> deal[deal]
  deal_filler[deal_filler] --> filler[filler]
  deal_product[deal_product] --> deal[deal]
  deal_product[deal_product] --> product[product]
  deal_stage[deal_stage] --> collection[collection]
  deal_stage_record[deal_stage_record] --> deal[deal]
  deal_stage_record[deal_stage_record] --> deal_stage[deal_stage]
  deal_user[deal_user] --> user[user]
  deal_user[deal_user] --> deal[deal]
  email[email] --> user[user]
  email_cc[email_cc] --> email[email]
  email_template[email_template] --> user[user]
  email_to[email_to] --> email[email]
  email_transporter[email_transporter] --> user[user]
  event[event] --> group[group]
  event[event] --> user[user]
  event[event] --> deal[deal]
  event[event] --> task[task]
  file[file] --> user[user]
  file[file] --> email[email]
  notification[notification] --> company[company]
  product[product] --> user[user]
  product_filler[product_filler] --> filler[filler]
  product_filler[product_filler] --> product[product]
  recorder_token[recorder_token] --> user[user]
  recording[recording] --> user[user]
  setting[setting] --> user[user]
  setting[setting] --> deal_stage[deal_stage]
  task[task] --> group[group]
  task[task] --> user[user]
  task[task] --> company[company]
  task[task] --> deal[deal]
  task[task] --> task_type[task_type]
  trigger[trigger] --> user[user]
  trigger[trigger] --> deal_stage[deal_stage]
  trigger_run[trigger_run] --> deal[deal]
  trigger_run[trigger_run] --> trigger[trigger]
  user_filler[user_filler] --> user[user]
  user_filler[user_filler] --> filler[filler]
```

## 5. Модули и проверки

| Модуль | Папка | Адреса API | Таблицы | Наборы проверок |
|---|---|---|---|---|
| Analytics | `parisahon-api/src/analytics` | /analytics | company, deal, deal_stage, deal_stage_record, event, recording, task, user | analytics, auth, smoke |
| Auth | `parisahon-api/src/auth` | /auth | — | auth, smoke |
| Bot | `parisahon-api/src/bot` | /bot/link, /bot/mcp | bot_account, bot_link_code, bot_reminder | auth, bot, smoke |
| Calls | `parisahon-api/src/calls` | /calls | call_upload, deal, recorder_token, recording, user | auth, calls, ftp, smoke |
| Company | `parisahon-api/src/company` | /companies | company, company_filler, deal, user | auth, modules, smoke |
| Contact | `parisahon-api/src/contact` | /contacts | company, company_filler, user, user_filler | auth, modules, smoke |
| Deal | `parisahon-api/src/deal` | /deals, /deals/trash | company, deal, deal_filler, deal_stage_record | auth, deals, smoke, trash |
| DealStage | `parisahon-api/src/deal_stage` | /stages | deal, deal_stage, collection, setting | auth, deals, smoke, trash |
| Desktop | `parisahon-api/src/desktop` | /desktop | — | auth, modules, smoke |
| Email | `parisahon-api/src/email` | /emails | deal, email, email_template, email_to, email_transporter, event, user | auth, mail, smoke |
| Events | `parisahon-api/src/events` | — | deal, email, event, user | deals, telegram, whatsapp |
| File | `parisahon-api/src/file` | /files | event, file | auth, files, platform, smoke |
| Filler | `parisahon-api/src/filler` | /fillers | filler | auth, modules, smoke |
| Group | `parisahon-api/src/group` | /groups | group | auth, platform, smoke |
| Helper | `parisahon-api/src/helper` | — | — | deals, trash |
| Linkable | `parisahon-api/src/linkable` | /linkables | — | auth, platform, smoke |
| Messenger | `parisahon-api/src/messenger` | — | deal, event, user | telegram, whatsapp |
| NotificationGateWay | `parisahon-api/src/gateway` | — | — | live |
| Notification | `parisahon-api/src/notification` | — | notification | — |
| Objective | `parisahon-api/src/objective` | /analytics/objectives | deal, group, user | analytics, auth, smoke |
| Product | `parisahon-api/src/product` | /products | product, product_filler | auth, modules, smoke |
| Recognition | `parisahon-api/src/recognition` | /companies | company, user | auth, bot, recognition, smoke |
| Seed | `parisahon-api/src/seed` | — | deal_stage, collection, group, setting, task_type, user | — |
| Setting | `parisahon-api/src/setting` | /settings | setting | auth, platform, smoke |
| Task | `parisahon-api/src/task` | /tasks | task | auth, modules, smoke |
| TaskType | `parisahon-api/src/task_type` | /task-types | task_type | auth, modules, platform, smoke |
| Telegram | `parisahon-api/src/telegram` | /telegram, /telegram/incoming | deal, event, file, user | auth, smoke, telegram |
| Tracking | `parisahon-api/src/tracking` | /logs | event | auth, platform, smoke |
| Trigger | `parisahon-api/src/trigger` | /stages/:id, /triggers | deal, task, trigger, trigger_run | auth, smoke, triggers |
| User | `parisahon-api/src/user` | /users | deal, file, user, user_filler | auth, modules, smoke |
| WhatsApp | `parisahon-api/src/whatsapp` | /whatsapp, /whatsapp/incoming | deal, event, file, user | auth, smoke, whatsapp |

Наборы для всего проекта: `schema` (база совпадает с кодом), `smoke` (каждый GET-запрос API), `ui` (каждая страница фронта), `auth` (права на всех маршрутах). Запуск: `local/dev/check.sh` (все) или `local/dev/check.sh --changed`.
