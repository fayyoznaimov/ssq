#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Parisa CRM: delete the data of a CRM database and load a mock data set for testing.

  python3 wipe_and_seed.py --db crm_staging                     # the plan only: what goes, what stays; exit 2
  python3 wipe_and_seed.py --db crm_staging --rollback          # all of it and the checks, then ROLLBACK (dry run)
  python3 wipe_and_seed.py --db crm_staging --i-have-a-backup   # wipe + seed + checks in ONE transaction

Only the databases parisahon (production) and crm_staging are accepted.

What stays: migrations (and typeorm_metadata if there is one), the admin user id 1 and what belongs to
that account itself (its messenger_account, email_transporter, bot_account, its «Не клиент» list in
messenger_ignore, its e-mail templates). Everything else of schema public is deleted; then the mock data
set is written: staff, groups, the pipeline, task types, custom fields, products, companies, contacts,
deals with their stage history and feed, tasks, letters, call records (no audio). Nothing of it can reach
a real person (reserved phone ranges, @example.com/.org/.net, Telegram / WhatsApp ids that cannot exist).

Ids: no id that was ever handed out goes to a mock row, and no sequence moves back. The Telegram, WhatsApp
and FTP services keep sessions, outboxes and folders by CRM user id, the CRM bot's buttons in Telegram chats
carry task ids, the outboxes deal ids: so the mock rows of every table get the ids right above the highest
id that table ever had (its max(id) and its sequence, rounded up to a hundred), the sequence then stands
after them and carries the comment «parisa-mock <first>-<last>». Only mock rows ever had those ids, so the
next run gives the same mock rows the same ids again (two runs give the same data).
Every change, sequences and their comments included, is transactional (ALTER SEQUENCE ... RESTART, never
setval; TRUNCATE ... CONTINUE IDENTITY): --rollback and a failed run leave the database exactly as it was,
and the script compares every sequence before and after to prove it.

The passwords of the mock staff are written only to /root/crm2/seed/mock-users-<db>.txt (chmod 600) and
never printed; a second run on the same database reuses them, another database gets its own. The same
--seed gives the same data (dates are relative to the moment of the run).
Talks to Postgres through `docker exec -i <container> psql`; needs Python 3.8+ and the `bcrypt` module.
See README.md next to this file.
"""

import argparse
import copy
import datetime as dt
import hashlib
import json
import os
import random
import re
import secrets
import string
import subprocess
import sys
import tempfile
from decimal import Decimal, ROUND_HALF_UP

ADMIN_ID = 1
TZ_NAME = 'Asia/Tashkent'          # UTC+5 like Asia/Karachi of the servers; no DST
UTC_OFFSET = dt.timedelta(hours=5)
DATABASES = ('parisahon', 'crm_staging')      # production and its staging copy: nothing else
USERS_DIR = '/root/crm2/seed'                 # mock-users-<db>.txt
MARK = 'parisa-mock'                          # comment of a sequence: «parisa-mock <first>-<last>», the mock ids
MARK_RE = re.compile(r'^parisa-mock (\d+)-(\d+)$')

# tables that are not data
KEEP_FULL = {'migrations', 'typeorm_metadata'}
# tables of which the admin's own rows stay: table -> SQL condition of the rows that stay
PARTIAL = {
    'user': 'id = 1',
    'messenger_account': 'user_id = 1',
    'email_transporter': 'user_id = 1',
    'bot_account': 'user_id = 1',
    'messenger_ignore': 'agent_id = 1',
    'email_template': 'created_by = 1',
}
# wiped and written again (setting: the company's mail signature is carried over)
RESET = {'setting'}

# what the mock data set writes, with the columns it needs (checked before anything is changed)
SEEDED_COLUMNS = {
    'group': ['id', 'name', 'created_at', 'objectives'],
    'user': ['id', 'username', 'email', 'phone', 'password', 'role', 'permissions', 'updated_at', 'deleted_at',
             'created_at', 'group_id', 'company_id', 'created_by', 'updated_by', 'tg_id', 'objectives',
             'wa_id', 'avatar', 'token_version'],
    'collection': ['id', 'name', 'is_active', 'created_at'],
    'deal_stage': ['id', 'name', 'order', 'description', 'created_at', 'color', 'collection_id', 'kind'],
    'setting': ['id', 'default_stage_id', 'defaultAgentId', 'mail_signature'],
    'task_type': ['id', 'name'],
    'filler': ['id', 'target', 'field', 'created_at', 'is_required'],
    'product': ['id', 'name', 'deleted_at', 'created_at', 'created_by', 'updated_by', 'sku', 'unit', 'price'],
    'product_filler': ['id', 'value', 'created_at', 'product_id', 'filler_id'],
    'company': ['id', 'name', 'email', 'phone', 'updated_at', 'deleted_at', 'created_at', 'created_by', 'updated_by',
                'is_old', 'inn', 'legal_address', 'bank_account', 'bank_name', 'mfo', 'oked', 'director',
                'primary_contact_id'],
    'company_filler': ['id', 'value', 'created_at', 'company_id', 'filler_id'],
    'user_filler': ['id', 'value', 'created_at', 'user_id', 'filler_id'],
    'deal': ['id', 'label', 'display_id', 'budget', 'created_at', 'stage_id', 'agent_id', 'created_by', 'company_id',
             'closed_at', 'last_stage_change', 'deleted_at', 'deleted_by', 'repeat_of_id', 'lost_reason', 'lost_comment'],
    'deal_user': ['dealId', 'userId'],
    'deal_product': ['id', 'quantity', 'price', 'deal_id', 'product_id'],
    'deal_filler': ['id', 'value', 'created_at', 'deal_id', 'filler_id'],
    'deal_stage_record': ['id', 'moved_after_minutes', 'created_at', 'deal_id', 'stage_id', 'from_stage_id', 'moved_by'],
    'task': ['id', 'label', 'result', 'closed_at', 'start_time', 'end_time', 'allDay', 'created_at', 'type_id',
             'company_id', 'ctr_agent_id', 'agent_id', 'group_id', 'deal_id', 'createdById'],
    'notification': ['id', 'message', 'company_id'],
    'email': ['id', 'email_id', 'from', 'subject', 'body', 'sent_at', 'read', 'user_id', 'outgoing', 'is_spam',
              'deleted_at', 'from_mailbox', 'thread_id', 'message_id', 'uidvalidity', 'sent_by_id', 'from_name',
              'in_reply_to', 'reference_ids', 'html', 'deleted_by_id'],
    'email_to': ['id', 'value', 'email_id'],
    'email_cc': ['id', 'value', 'email_id'],
    'email_read': ['email_id', 'user_id', 'read_at'],
    'recording': ['id', 'duration', 'outgoing', 'path', 'created_at', 'user_id', 'from_number'],
    'event': ['id', 'type', 'field_of', 'before_state', 'after_state', 'created_at', 'deal_id', 'task_id', 'user_id',
              'target_user_id', 'target_group_id', 'outgoing', 'tg_message_id', 'duration', 'replied_at',
              'external_id', 'company_id', 'contact_id', 'source', 'source_ref'],
}

# event types (src/events/event.entity.ts)
E_NEW_DEAL, E_NEW_CONTACT, E_NEW_COMPANY, E_FIELD, E_FIELD_UPDATE, E_COMMENT = 0, 1, 2, 3, 4, 5
E_TASK, E_TASK_STATUS, E_CHAT, E_EMAIL, E_CALL = 6, 7, 8, 9, 10
E_TELEGRAM, E_PRODUCT, E_STAGE, E_WHATSAPP = 12, 14, 15, 16
CHAT_TYPES = (E_EMAIL, 11, E_TELEGRAM, E_WHATSAPP)          # a client's message when incoming
ANSWER_TYPES = (E_EMAIL, 11, E_TELEGRAM, E_WHATSAPP, E_CALL)  # the manager's answer when outgoing

# Telegram user ids have at most 52 significant bits: from 2^52 on no account can exist (and the
# numbers stay exact in JavaScript, below 2^53)
TG_ID_BASE = 2 ** 52

# the working time «Контроль ответов» counts (CONTROL_WORK_HOURS / CONTROL_WORK_DAYS of the API, defaults):
# 09:00-18:00, Monday to Saturday; an answer within 15 working minutes is in the norm (CONTROL_SLA_MINUTES)
WORK_FROM, WORK_TILL = dt.time(9, 0), dt.time(18, 0)
# how fast each manager answers a client: share within the norm (1.5-12.5 working minutes), within an hour
# (17-55), the rest late (75-260 working minutes: a meeting, a busy day). A message of the evening or the weekend
# is answered the next working morning (within the norm in working time) or at once from the phone. The shares
# are dealt out evenly over each manager's answers (Gen.pace), so «Контроль ответов» shows about them: a normal
# team of 75-80 % within the norm, Сардор the weaker one (about 60 %).
PACE = {'head': (0.80, 0.13), 'dk': (0.80, 0.13), 'st': (0.60, 0.25), 'am': (0.80, 0.13), 'my': (0.79, 0.14)}
GOLDEN = 0.6180339887498949
EVENING = 0.15       # share of the client's own (not prompted) messages written after 18:00


def out(text=''):
    print(text, flush=True)


# =========================================================================================== database

class Db:
    """psql of the database container: queries for the plan, one script for the change."""

    def __init__(self, container, user, name):
        self.name = name
        self.cmd = ['docker', 'exec', '-i', '-e', 'PGCLIENTENCODING=UTF8', container,
                    'psql', '-U', user, '-d', name, '-v', 'ON_ERROR_STOP=1', '-X', '-q']

    def rows(self, sql):
        res = subprocess.run(self.cmd + ['-A', '-t', '-F', '\x1f', '-c', sql],
                             capture_output=True, encoding='utf-8')
        if res.returncode != 0:
            raise SystemExit(f'psql failed ({self.name}): {res.stderr.strip()}')
        return [line.split('\x1f') for line in res.stdout.split('\n') if line != '']

    def script(self, sql):
        res = subprocess.run(self.cmd, input=sql, encoding='utf-8')
        return res.returncode


def qi(name):
    return '"' + name.replace('"', '""') + '"'


def q(text):
    return "'" + str(text).replace("'", "''") + "'"


class Raw:
    def __init__(self, sql):
        self.sql = sql


def lit(v):
    if v is None:
        return 'NULL'
    if isinstance(v, Raw):
        return v.sql
    if isinstance(v, bool):
        return 'TRUE' if v else 'FALSE'
    if isinstance(v, int):
        return str(v)
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, float):
        return repr(v)
    if isinstance(v, dt.datetime):
        return q(v.strftime('%Y-%m-%d %H:%M:%S'))
    if isinstance(v, dt.date):
        return q(v.isoformat())
    if isinstance(v, (dict, list)):
        return q(json.dumps(v, ensure_ascii=False)) + '::jsonb'
    return q(v)


def inserts(table, rows, chunk=200):
    if not rows:
        return []
    cols = list(rows[0].keys())
    for r in rows:
        if list(r.keys()) != cols:
            raise SystemExit(f'internal error: rows of {table} have different columns')
    sql = []
    for i in range(0, len(rows), chunk):
        part = rows[i:i + chunk]
        values = ',\n  '.join('(' + ', '.join(lit(r[c]) for c in cols) + ')' for r in part)
        sql.append(f'INSERT INTO {qi(table)} ({", ".join(qi(c) for c in cols)}) VALUES\n  {values};')
    return sql


# ============================================================================================ helpers

def iso(t):
    """A local time as the API puts it into the JSON of the history (UTC, «Z»)."""
    return (t - UTC_OFFSET).strftime('%Y-%m-%dT%H:%M:%S.') + f'{t.microsecond // 1000:03d}Z'


def sec(t):
    """Whole seconds: what is computed from the times (minutes in a stage) matches what the database keeps."""
    return t.replace(microsecond=0) if t is not None else None


def plural(n, one, few, many):
    """«3 дня», «5 дней», «21 паллета»."""
    n = int(n)
    word = one if n % 10 == 1 and n % 100 != 11 else few if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14 else many
    return f'{n} {word}'


def money(n):
    return f'{int(n):,}'.replace(',', ' ')


def usd(value):
    """«6,70», «33 500»: dollars as a Russian text writes them."""
    d = Decimal(value).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    whole, cents = divmod(d, 1)
    text = money(whole)
    return text if cents == 0 else f'{text},{int(cents * 100):02d}'


def dec_text(value):
    """numeric as the API gives it in the history (decimal.ts): no trailing zeros."""
    d = Decimal(value).quantize(Decimal('0.01'))
    text = format(d, 'f')
    if '.' in text:
        text = text.rstrip('0').rstrip('.')
    return text


def round_price(value):
    return int((Decimal(value) / 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP) * 100)


def person(u):
    if u is None:
        return None
    return {'id': u['id'], 'username': u['username'], 'role': u['role']}


def and_join(parts):
    """«a», «a и b», «a, b и c»."""
    parts = [p for p in parts if p]
    if len(parts) <= 1:
        return ''.join(parts)
    return ', '.join(parts[:-1]) + ' и ' + parts[-1]


MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября',
              'ноября', 'декабря']


def human_date(day, year):
    """«24 октября», «4 января 2027 г.» (the year only when it is not the year of the conversation)."""
    return f'{day.day} {MONTHS_GEN[day.month - 1]}' + ('' if day.year == year else f' {day.year} г.')


def working(t):
    return t.weekday() != 6 and WORK_FROM <= t.time() < WORK_TILL


def add_work(t, minutes):
    """t plus so many minutes of working time (09:00-18:00, Monday to Saturday), as «Контроль ответов» counts."""
    left = dt.timedelta(minutes=minutes)
    cur = t
    for _ in range(40):
        if cur.weekday() == 6:
            cur = dt.datetime.combine(cur.date() + dt.timedelta(days=1), WORK_FROM)
            continue
        opening = dt.datetime.combine(cur.date(), WORK_FROM)
        closing = dt.datetime.combine(cur.date(), WORK_TILL)
        if cur < opening:
            cur = opening
        if cur >= closing:
            cur = dt.datetime.combine(cur.date() + dt.timedelta(days=1), WORK_FROM)
            continue
        if left <= closing - cur:
            return cur + left
        left -= closing - cur
        cur = dt.datetime.combine(cur.date() + dt.timedelta(days=1), WORK_FROM)
    return cur


GENDER = re.compile(r'\(\(([^()|]*)\|([^()|]*)\)\)')


def item(direction, text, subj=None, mail=False):
    """One message of a burst: 'in' from the client, 'out' from the manager; mail: by e-mail when the client has one."""
    return {'dir': direction, 'text': text, 'subj': subj, 'mail': mail}


# ============================================================================================ the data

STAGES = [
    # key, name, kind, colour, description
    ('new', 'Неразобранное', 'new', '#D5D8DB', 'Новые обращения из мессенджеров, почты и звонков'),
    ('first', 'Первичный контакт', 'first_contact', '#99CCFF', 'Первый разговор с клиентом'),
    ('needs', 'Выявление потребности', 'work', '#8ECAE6', 'Изделия, размеры, плотность, цвет, объём, сроки'),
    ('kp', 'Отправлено КП', 'work', '#FFD166', 'Коммерческое предложение у клиента'),
    ('samples', 'Образцы', 'work', '#F4A261', 'Образцы отправлены, ждём оценку клиента'),
    ('agree', 'Согласование', 'work', '#E9C46A', 'Цена, условия оплаты и договор'),
    ('prepay', 'Предоплата', 'prepayment', '#FFCC66', 'Счёт выставлен, ждём предоплату'),
    ('prod', 'Производство', 'work', '#90BE6D', 'Заказ в производстве'),
    ('ship', 'Отгрузка', 'work', '#43AA8B', 'Отгрузка и доставка, окончательный расчёт'),
    ('won', 'Успешно', 'won', '#2A9D8F', 'Заказ получен и оплачен'),
    ('lost', 'Не реализовано', 'lost', '#9E2A2B', 'Сделка не состоялась'),
]
FLOW = ['first', 'needs', 'kp', 'samples', 'agree', 'prepay', 'prod', 'ship', 'won']

TASK_TYPES = ['Связаться', 'Звонок', 'Встреча', 'Отправить КП', 'Отправить образцы', 'Подготовить договор',
              'Контроль оплаты']   # «Связаться» is the default (DEFAULT_TASK_TYPE of the API)

FILLERS = [
    # key, target, field, required
    ('c_country', 'company', 'Страна', True),
    ('c_city', 'company', 'Город', False),
    ('c_type', 'company', 'Тип клиента', False),
    ('u_position', 'user', 'Должность', False),
    ('d_gsm', 'deal', 'Граммаж, г/м²', False),
    ('d_size', 'deal', 'Размер', False),
    ('d_color', 'deal', 'Цвет', False),
    ('d_qty', 'deal', 'Количество, шт', False),
    ('d_logo', 'deal', 'Логотип', False),
    ('d_country', 'deal', 'Страна поставки', False),
    ('d_deadline', 'deal', 'Срок поставки', False),
    ('d_currency', 'deal', 'Валюта контракта', False),
    ('p_comp', 'product', 'Состав', False),
    ('p_usd', 'product', 'Экспортная цена, USD', False),
]

PRODUCTS = [
    # key, name, sku, unit, price UZS, composition, export price USD, gsm, size, short name, (kind, size) for texts
    ('mt3050', 'Полотенце махровое 30×50, 400 г/м²', 'PH-MT-3050-400', 'шт', 18000, '100% хлопок', '1.40', '400', '30×50', 'махровые 30×50', ('махровые полотенца', '30×50')),
    ('mt5090', 'Полотенце махровое 50×90, 450 г/м²', 'PH-MT-5090-450', 'шт', 42000, '100% хлопок', '3.30', '450', '50×90', 'махровые 50×90', ('махровые полотенца', '50×90')),
    ('mt70140', 'Полотенце махровое 70×140, 500 г/м²', 'PH-MT-70140-500', 'шт', 85000, '100% хлопок', '6.70', '500', '70×140', 'махровые 70×140', ('махровые полотенца', '70×140')),
    ('mt100150', 'Полотенце банное 100×150, 500 г/м²', 'PH-MT-100150-500', 'шт', 118000, '100% хлопок', '9.30', '500', '100×150', 'банные 100×150', ('банные полотенца', '100×150')),
    ('mtfoot', 'Полотенце для ног 50×70, 650 г/м²', 'PH-MT-5070-650', 'шт', 38000, '100% хлопок', '3.00', '650', '50×70', 'для ног 50×70', ('полотенца для ног', '50×70')),
    ('vf4570', 'Полотенце вафельное 45×70, 200 г/м²', 'PH-VF-4570-200', 'шт', 14000, '100% хлопок', '1.10', '200', '45×70', 'вафельные 45×70', ('вафельные полотенца', '45×70')),
    ('vf50100', 'Полотенце вафельное 50×100, 240 г/м²', 'PH-VF-50100-240', 'шт', 21000, '100% хлопок', '1.65', '240', '50×100', 'вафельные 50×100', ('вафельные полотенца', '50×100')),
    ('kitchen', 'Набор кухонных полотенец 3 шт., 40×60', 'PH-KT-4060-3', 'компл.', 36000, 'хлопок 80%, лён 20%', '2.85', '220', '40×60', 'кухонные наборы', ('наборы кухонных полотенец', None)),
    ('robe_mt', 'Халат махровый с шалевым воротником, 380 г/м²', 'PH-HL-MT-380', 'шт', 165000, '100% хлопок', '13.00', '380', 'S–XXL', 'махровые халаты', ('махровые халаты', None)),
    ('robe_vf', 'Халат вафельный (кимоно), 250 г/м²', 'PH-HL-VF-250', 'шт', 120000, '100% хлопок', '9.50', '250', 'S–XXL', 'вафельные халаты', ('вафельные халаты', None)),
    ('robe_vel', 'Халат велюровый с капюшоном', 'PH-HL-VL-420', 'шт', 210000, 'хлопок 90%, полиэстер 10%', '16.50', '420', 'S–XXL', 'велюровые халаты', ('велюровые халаты', None)),
    ('sheet_mt', 'Простыня махровая 150×200', 'PH-PR-MT-150200', 'шт', 230000, '100% хлопок', '18.00', '400', '150×200', 'махровые простыни', ('махровые простыни', '150×200')),
    ('sheet_bz', 'Простыня бязевая 150×220', 'PH-PR-BZ-150220', 'шт', 55000, '100% хлопок (бязь)', '4.30', '142', '150×220', 'бязевые простыни', ('бязевые простыни', '150×220')),
    ('bedset', 'Комплект постельного белья 1,5-сп., бязь', 'PH-KPB-15-BZ', 'компл.', 190000, '100% хлопок (бязь)', '15.00', '142', '1,5-сп.', 'комплекты белья', ('комплекты постельного белья', None)),
    ('hotel_std', 'Набор для отелей «Стандарт»: 2 полотенца + коврик', 'PH-HOT-STD', 'компл.', 135000, '100% хлопок', '10.60', '450', '50×90, 70×140', 'наборы «Стандарт»', ('наборы для отелей «Стандарт»', None)),
    ('hotel_lux', 'Набор для отелей «Люкс»: 3 полотенца + халат + коврик', 'PH-HOT-LUX', 'компл.', 420000, '100% хлопок', '33.00', '500', '30×50, 50×90, 70×140', 'наборы «Люкс»', ('наборы для отелей «Люкс»', None)),
    ('mat', 'Коврик для ванной махровый 50×70, 700 г/м²', 'PH-KV-5070-700', 'шт', 45000, '100% хлопок', '3.55', '700', '50×70', 'коврики', ('коврики для ванной', '50×70')),
]

# rights of the user card (user.permissions): 0 nothing, 1 own, 2 group, 3 all
def rights(view, update, task_update, task_delete=0, delete=0, export=0):
    entity = lambda: {'view': view, 'create': 3, 'update': update, 'delete': delete, 'export': export}
    return {'deal': entity(), 'company': entity(), 'contact': entity(),
            'task': {'update': task_update, 'delete': task_delete}, 'mail': True, 'file': True}

GROUPS = [
    # key, name
    ('g_uz', 'Опт и розница'),
    ('g_exp', 'Экспорт и HoReCa'),
]

STAFF = [
    # key, name, e-mail, phone tail, role, group, rights, title, goal per month (UZS)
    ('head', 'Рустам Абдуллаев', 'r.abdullaev@example.com', 9001, 'manager', None,
     rights(3, 3, 3, 3, 3, 3), 'Руководитель отдела продаж', 0),
    ('dk', 'Дилноза Каримова', 'd.karimova@example.com', 9002, 'agent', 'g_uz',
     rights(2, 2, 2, 1), 'Менеджер по продажам (опт)', 300_000_000),
    ('st', 'Сардор Турсунов', 's.tursunov@example.com', 9003, 'agent', 'g_uz',
     rights(1, 1, 1), 'Менеджер по продажам (сети), видит только свои сделки', 250_000_000),
    ('am', 'Алексей Морозов', 'a.morozov@example.com', 9004, 'agent', 'g_exp',
     rights(2, 2, 2, 1), 'Менеджер ВЭД (Казахстан, Кыргызстан, Россия)', 450_000_000),
    ('my', 'Малика Юсупова', 'm.yusupova@example.com', 9005, 'agent', 'g_exp',
     rights(3, 2, 2, 1, 0, 1), 'Менеджер по работе с отелями', 300_000_000),
]

# first names of the women among the staff and the contacts: verbs in the past tense agree with them
FEMALE = {'Дилноза', 'Малика', 'Гульнора', 'Зарина', 'Дилфуза', 'Ольга', 'Камола', 'Ирина', 'Севара', 'Лола',
          'Мохира', 'Елена', 'Нигора', 'Айгерим', 'Асель', 'Айжан', 'Наталья', 'Татьяна', 'Шахноза', 'Феруза',
          'Мадина', 'Зульфия', 'Светлана'}

BANKS = {
    'UZ': [('АКБ «Савдогар Банк», Мирабадский филиал', '00991'), ('АКБ «Шарқ Инвест Банк», Юнусабадский филиал', '00992'),
           ('АКБ «Тадбиркор Кредит Банк», филиал Самарканд', '00993')],
    'KZ': [('АО «Алтын Дала Банк»', 'ADBKKZKX')],
    'KG': [('ОАО «Ала-Тоо Финанс Банк»', '129901')],
    'RU': [('ПАО «Волжский Кредит Банк»', '049999901')],
}
OKED = {'opt': '46410', 'retail': '47510', 'hotel': '55100', 'export': '46410'}
SEGMENT_TYPE = {'opt': 'Оптовый покупатель', 'retail': 'Розничная сеть', 'hotel': 'Отель / HoReCa',
                'export': 'Экспорт'}
COUNTRY = {'UZ': 'Узбекистан', 'KZ': 'Казахстан', 'KG': 'Кыргызстан', 'RU': 'Россия'}
IN_COUNTRY = {'UZ': 'в Узбекистане', 'KZ': 'в Казахстане', 'KG': 'в Кыргызстане', 'RU': 'в России'}
# every city of the data set: «в …» (where), «в …» (where to), «до … / из …» (genitive)
CITY = {
    'Ташкент': ('в Ташкенте', 'в Ташкент', 'Ташкента'),
    'Наманган': ('в Намангане', 'в Наманган', 'Намангана'),
    'Самарканд': ('в Самарканде', 'в Самарканд', 'Самарканда'),
    'Фергана': ('в Фергане', 'в Фергану', 'Ферганы'),
    'Бухара': ('в Бухаре', 'в Бухару', 'Бухары'),
    'Андижан': ('в Андижане', 'в Андижан', 'Андижана'),
    'Навои': ('в Навои', 'в Навои', 'Навои'),
    'Хива': ('в Хиве', 'в Хиву', 'Хивы'),
    'Бостанлыкский р-н': ('в Бостанлыкском районе', 'в Бостанлыкский район', 'Бостанлыкского района'),
    'Алматы': ('в Алматы', 'в Алматы', 'Алматы'),
    'Астана': ('в Астане', 'в Астану', 'Астаны'),
    'Шымкент': ('в Шымкенте', 'в Шымкент', 'Шымкента'),
    'Бишкек': ('в Бишкеке', 'в Бишкек', 'Бишкека'),
    'Ош': ('в Оше', 'в Ош', 'Оша'),
    'Казань': ('в Казани', 'в Казань', 'Казани'),
    'Новосибирск': ('в Новосибирске', 'в Новосибирск', 'Новосибирска'),
    'Москва': ('в Москве', 'в Москву', 'Москвы'),
}
TRANSIT = {'UZ': (1, 3), 'KG': (2, 4), 'KZ': (3, 6), 'RU': (7, 11)}     # days on the road from Tashkent
# «Цвет»: the field and how the client says it
COLORS = {
    'opt': [('Белый', 'белый'), ('Белый, бежевый', 'белый и бежевый'), ('Тёмно-синий', 'тёмно-синий'), ('Бежевый', 'бежевый')],
    'retail': [('Белый, серый', 'белый и серый'), ('Бежевый', 'бежевый'), ('Белый, бежевый', 'белый и бежевый'), ('Серый', 'серый')],
    'hotel': [('Белый', 'белый'), ('Белый', 'белый'), ('Белый, бежевый', 'белый и бежевый')],
    'export': [('Белый', 'белый'), ('Белый, бежевый', 'белый и бежевый'), ('Серый', 'серый')],
    'private': [('Белый', 'белый'), ('Бежевый', 'бежевый')],
}
# «Логотип»: how the client says it, the field
LOGOS = {
    'hotel': [('вышивка логотипа отеля', 'Вышивка логотипа отеля'), ('жаккардовый логотип отеля', 'Жаккард с логотипом отеля')],
    'private': [('без логотипа', 'Без логотипа'), ('вышивка названия гостевого дома', 'Вышивка названия')],
    'other': [('вышивка логотипа на бордюре', 'Вышивка на бордюре'), ('жаккардовый логотип на бордюре', 'Жаккард на бордюре'),
              ('без логотипа', 'Без логотипа'), ('без логотипа, только фирменная бирка', 'Бирка клиента')],
}
PURPOSE = {'opt': 'для оптовых продаж', 'retail': 'для наших магазинов', 'hotel': 'для номерного фонда',
           'private': 'для гостевого дома'}
SEG_TEXT = {'opt': 'оптовая компания', 'retail': 'розничная сеть', 'hotel': 'гостиница',
            'export': 'дистрибьютор', 'private': 'частный клиент'}

# contact: key, name, position, e-mail (None: no e-mail), Telegram, WhatsApp
COMPANIES = [
    dict(key='c01', name='ООО «Текстиль Савдо Опт»', short='Текстиль Савдо Опт', slug='tekstilsavdo', seg='opt', cc='UZ',
         city='Ташкент', agent='dk', is_old=True, director='Рахимов Азиз Бахтиёрович',
         addr='г. Ташкент, Чиланзарский р-н, ул. Бунёдкор, 21',
         contacts=[('u01', 'Азиз Рахимов', 'Директор', 'a.rahimov@example.com', True, False),
                   ('u02', 'Гульнора Абдуллаева', 'Главный бухгалтер', 'g.abdullaeva@example.org', False, False)]),
    dict(key='c02', name='ЧП «Нур Текстиль»', short='Нур Текстиль', slug='nurtekstil', seg='opt', cc='UZ',
         city='Наманган', agent='st', is_old=True, director='Каримов Бекзод Ильхомович',
         addr='г. Наманган, ул. Навои, 104',
         contacts=[('u03', 'Бекзод Каримов', 'Владелец', None, True, True)]),
    dict(key='c03', name='ООО «Самарканд Хоум Трейд»', short='Самарканд Хоум Трейд', slug='samarkandhome', seg='opt', cc='UZ',
         city='Самарканд', agent='dk', is_old=False, director='Алимов Жасур Рустамович',
         addr='г. Самарканд, ул. Регистанская, 37',
         contacts=[('u04', 'Жасур Алимов', 'Менеджер по закупкам', 'j.alimov@example.com', True, False),
                   ('u05', 'Зарина Махмудова', 'Бухгалтер', 'z.mahmudova@example.org', False, False)]),
    dict(key='c04', name='ООО «Фаргона Мато Савдо»', short='Фаргона Мато Савдо', slug='fargonamato', seg='opt', cc='UZ',
         city='Фергана', agent='st', is_old=False, director='Назаров Шерзод Абдуллаевич',
         addr='г. Фергана, ул. Мустакиллик, 12',
         contacts=[('u06', 'Шерзод Назаров', 'Директор', None, False, True)]),
    dict(key='c05', name='ЧП «Бухоро Уй Жихозлари»', short='Бухоро Уй Жихозлари', slug='buxorouy', seg='opt', cc='UZ',
         city='Бухара', agent='dk', is_old=False, director='Юлдашев Улугбек Тахирович',
         addr='г. Бухара, ул. Бахоуддина Накшбанда, 58',
         contacts=[('u07', 'Улугбек Юлдашев', 'Владелец', 'u.yuldashev@example.net', True, False)]),
    dict(key='c06', name='ООО «Андижон Текстиль Маркет»', short='Андижон Текстиль Маркет', slug='andijontekstil', seg='opt', cc='UZ',
         city='Андижан', agent='st', is_old=False, director='Исмоилов Фаррух Шавкатович',
         addr='г. Андижан, пр. Бабура, 77',
         contacts=[('u08', 'Фаррух Исмоилов', 'Коммерческий директор', 'f.ismoilov@example.com', True, True)]),
    dict(key='c07', name='ИП «Комфорт Текстиль»', short='Комфорт Текстиль', slug='komforttekstil', seg='opt', cc='UZ',
         city='Ташкент', agent='dk', is_old=False, director='Хасанов Отабек Маратович',
         addr='г. Ташкент, Юнусабадский р-н, ул. Амира Темура, 108',
         contacts=[('u09', 'Отабек Хасанов', 'Директор', None, True, False)]),
    dict(key='c08', name='ООО «Ипак Йули Савдо»', short='Ипак Йули Савдо', slug='ipakyuli', seg='opt', cc='UZ',
         city='Ташкент', agent='dk', is_old=False, director='Мирзаев Санжар Олимович',
         addr='г. Ташкент, Мирзо-Улугбекский р-н, ул. Буюк Ипак Йули, 15',
         contacts=[('u10', 'Санжар Мирзаев', 'Менеджер по закупкам', 's.mirzaev@example.com', True, False),
                   ('u11', 'Дилфуза Сабирова', 'Главный бухгалтер', 'd.sabirova@example.org', False, False)]),
    dict(key='c09', name='ООО «Уютный Дом Ритейл»', short='Уютный Дом', slug='uyutnydom', seg='retail', cc='UZ',
         city='Ташкент', agent='st', is_old=False, director='Ковалёв Сергей Николаевич',
         addr='г. Ташкент, Шайхантахурский р-н, ул. Навои, 30',
         contacts=[('u12', 'Ольга Петренко', 'Категорийный менеджер', 'o.petrenko@example.com', True, False),
                   ('u13', 'Сергей Ковалёв', 'Директор по закупкам', 's.kovalev@example.com', False, False)]),
    dict(key='c10', name='ООО «Мега Уй»', short='Мега Уй', slug='megauy', seg='retail', cc='UZ',
         city='Ташкент', agent='st', is_old=True, director='Ахмедов Темур Равшанович',
         addr='г. Ташкент, Сергелийский р-н, ул. Янги Сергели, 2',
         contacts=[('u14', 'Темур Ахмедов', 'Директор по закупкам', 't.ahmedov@example.com', True, False),
                   ('u15', 'Камола Иргашева', 'Категорийный менеджер', 'k.irgasheva@example.com', True, False)]),
    dict(key='c11', name='ООО «Мир Текстиля»', short='Мир Текстиля', slug='mirtekstilya', seg='retail', cc='UZ',
         city='Ташкент', agent='dk', is_old=False, director='Смирнова Ирина Викторовна',
         addr='г. Ташкент, Яккасарайский р-н, ул. Шота Руставели, 45',
         contacts=[('u16', 'Ирина Смирнова', 'Закупщик', 'i.smirnova@example.net', True, False)]),
    dict(key='c12', name='ООО «Оила Маркет»', short='Оила Маркет', slug='oilamarket', seg='retail', cc='UZ',
         city='Самарканд', agent='dk', is_old=False, director='Эргашев Ботир Хамидович',
         addr='г. Самарканд, ул. Дагбитская, 9',
         contacts=[('u17', 'Ботир Эргашев', 'Директор', None, True, False)]),
    dict(key='c13', name='ООО «Домашний Очаг»', short='Домашний Очаг', slug='domochag', seg='retail', cc='UZ',
         city='Наманган', agent='st', is_old=False, director='Саидов Нодир Зафарович',
         addr='г. Наманган, ул. Машраб, 16',
         contacts=[('u18', 'Нодир Саидов', 'Владелец', None, False, True)]),
    dict(key='c14', name='ООО «Зарафшон Савдо»', short='Зарафшон Савдо', slug='zarafshonsavdo', seg='retail', cc='UZ',
         city='Навои', agent='st', is_old=False, director='Холматов Анвар Каримович',
         addr='г. Навои, ул. Галаба, 40',
         contacts=[('u19', 'Анвар Холматов', 'Директор', 'a.holmatov@example.org', True, False)]),
    dict(key='c15', name='ООО «Сайхун Палас Отель»', short='Сайхун Палас', slug='saykhunpalace', seg='hotel', cc='UZ',
         city='Ташкент', agent='my', is_old=True, director='Волков Дмитрий Андреевич',
         addr='г. Ташкент, Мирабадский р-н, ул. Афросиаб, 4',
         contacts=[('u20', 'Севара Халилова', 'Хаускипер', 's.halilova@example.com', True, False),
                   ('u21', 'Дмитрий Волков', 'Генеральный менеджер', 'd.volkov@example.com', False, False)]),
    dict(key='c16', name='ООО «Чорсу Гарден Отель»', short='Чорсу Гарден', slug='chorsugarden', seg='hotel', cc='UZ',
         city='Ташкент', agent='my', is_old=True, director='Рашидов Акмаль Улугбекович',
         addr='г. Ташкент, Алмазарский р-н, ул. Кукча Дарвоза, 11',
         contacts=[('u22', 'Лола Азимова', 'Хаускипер', 'l.azimova@example.net', False, True),
                   ('u23', 'Акмаль Рашидов', 'Управляющий', 'a.rashidov@example.net', True, False)]),
    dict(key='c17', name='ООО «Зарафшан Резиденс»', short='Зарафшан Резиденс', slug='zarafshanresidence', seg='hotel', cc='UZ',
         city='Самарканд', agent='my', is_old=False, director='Шарипова Мохира Аслиддиновна',
         addr='г. Самарканд, ул. Университетский бульвар, 22',
         contacts=[('u24', 'Мохира Шарипова', 'Менеджер по закупкам', 'm.sharipova@example.com', False, False)]),
    dict(key='c18', name='ЧП «Хива Оазис»', short='Хива Оазис', slug='khivaoasis', seg='hotel', cc='UZ',
         city='Хива', agent='my', is_old=False, director='Нуриддинов Шухрат Бахромович',
         addr='г. Хива, ул. Ичан-Кала, 3',
         contacts=[('u25', 'Шухрат Нуриддинов', 'Владелец', None, True, True)]),
    dict(key='c19', name='ООО «Санаторий Чимган Тоглари»', short='Чимган Тоглари', slug='chimgantoglari', seg='hotel', cc='UZ',
         city='Бостанлыкский р-н', agent='am', is_old=False, director='Кузнецова Елена Петровна',
         addr='Ташкентская обл., Бостанлыкский р-н, пос. Чимган',
         contacts=[('u26', 'Елена Кузнецова', 'Заместитель директора по АХЧ', 'e.kuznetsova@example.com', False, False),
                   ('u27', 'Достон Умаров', 'Завхоз', None, True, False)]),
    dict(key='c20', name='ООО «Бахор Хостел Групп»', short='Бахор Хостел Групп', slug='bahorhostel', seg='hotel', cc='UZ',
         city='Бухара', agent='my', is_old=False, director='Каюмова Нигора Шерзодовна',
         addr='г. Бухара, ул. Ходжа Нурабад, 6',
         contacts=[('u28', 'Нигора Каюмова', 'Управляющая сетью хостелов', 'n.kayumova@example.org', True, False)]),
    dict(key='c21', name='ООО «Навруз Сити»', short='Навруз Сити', slug='navruzcity', seg='hotel', cc='UZ',
         city='Ташкент', agent='am', is_old=False, director='Соколов Андрей Игоревич',
         addr='г. Ташкент, Мирзо-Улугбекский р-н, ул. Паркентская, 51',
         contacts=[('u29', 'Андрей Соколов', 'Управляющий', 'a.sokolov@example.com', True, False)]),
    dict(key='c22', name='ООО «Уз Хотел Сервис»', short='Уз Хотел Сервис', slug='uzhotelservice', seg='hotel', cc='UZ',
         city='Ташкент', agent='my', is_old=False, director='Бакиев Фарход Тулкинович',
         addr='г. Ташкент, Учтепинский р-н, ул. Фархадская, 19',
         contacts=[('u30', 'Фарход Бакиев', 'Директор', 'f.bakiev@example.com', False, True)]),
    dict(key='c23', name='ТОО «Алатау Текстиль Трейд»', short='Алатау Текстиль Трейд', slug='alatautextile', seg='export', cc='KZ',
         city='Алматы', agent='am', is_old=True, director='Сейткали Ержан Болатович',
         addr='Казахстан, г. Алматы, пр. Райымбека, 212',
         contacts=[('u31', 'Ержан Сейткали', 'Директор', 'e.seitkali@example.com', False, True),
                   ('u32', 'Айгерим Нурланова', 'Менеджер по ВЭД', 'a.nurlanova@example.com', False, True)]),
    dict(key='c24', name='ТОО «Астана Хоум Декор»', short='Астана Хоум Декор', slug='astanahome', seg='export', cc='KZ',
         city='Астана', agent='am', is_old=False, director='Абенов Данияр Серикович',
         addr='Казахстан, г. Астана, ул. Сыганак, 18',
         contacts=[('u33', 'Данияр Абенов', 'Директор', None, False, True)]),
    dict(key='c25', name='ТОО «Шымкент Опт Текстиль»', short='Шымкент Опт Текстиль', slug='shymkentopt', seg='export', cc='KZ',
         city='Шымкент', agent='am', is_old=False, director='Жумабаева Асель Канатовна',
         addr='Казахстан, г. Шымкент, ул. Тауке хана, 33',
         contacts=[('u34', 'Асель Жумабаева', 'Менеджер по закупкам', 'a.zhumabaeva@example.net', False, True)]),
    dict(key='c26', name='ОсОО «Бишкек Текстиль Импорт»', short='Бишкек Текстиль Импорт', slug='bishkektextile', seg='export', cc='KG',
         city='Бишкек', agent='am', is_old=True, director='Осмонов Нурлан Бакирович',
         addr='Кыргызстан, г. Бишкек, ул. Ибраимова, 103',
         contacts=[('u35', 'Нурлан Осмонов', 'Директор', 'n.osmonov@example.com', False, True),
                   ('u36', 'Айжан Токтогулова', 'Бухгалтер', 'a.toktogulova@example.com', False, False)]),
    dict(key='c27', name='ОсОО «Ош Базар Трейд»', short='Ош Базар Трейд', slug='oshbazar', seg='export', cc='KG',
         city='Ош', agent='am', is_old=False, director='Мамытов Бакыт Асанович',
         addr='Кыргызстан, г. Ош, ул. Курманжан Датки, 210',
         contacts=[('u37', 'Бакыт Мамытов', 'Владелец', None, False, True)]),
    dict(key='c28', name='ООО «Волга Текстиль Опт»', short='Волга Текстиль Опт', slug='volgatextile', seg='export', cc='RU',
         city='Казань', agent='my', is_old=False, director='Павлов Виктор Сергеевич',
         addr='Россия, г. Казань, ул. Тэцевская, 4',
         contacts=[('u38', 'Наталья Лебедева', 'Менеджер по закупкам', 'n.lebedeva@example.com', False, True),
                   ('u39', 'Виктор Павлов', 'Директор', 'v.pavlov@example.com', False, False)]),
    dict(key='c29', name='ООО «Домашний Уют Сибирь»', short='Домашний Уют Сибирь', slug='uyutsibir', seg='export', cc='RU',
         city='Новосибирск', agent='am', is_old=False, director='Орлов Максим Валерьевич',
         addr='Россия, г. Новосибирск, ул. Станционная, 60',
         contacts=[('u40', 'Максим Орлов', 'Коммерческий директор', 'm.orlov@example.org', False, False)]),
    dict(key='c30', name='ООО «ТД Махра»', short='ТД Махра', slug='tdmahra', seg='export', cc='RU',
         city='Москва', agent='my', is_old=False, director='Белова Татьяна Олеговна',
         addr='Россия, г. Москва, ул. Дубининская, 57',
         contacts=[('u41', 'Татьяна Белова', 'Руководитель отдела закупок', 't.belova@example.com', False, True),
                   ('u42', 'Игорь Никитин', 'Логист', 'i.nikitin@example.com', False, False)]),
]

# contacts without a company: key, name, position, e-mail, Telegram, WhatsApp, country, city, agent who added them
LONE_CONTACTS = [
    ('u43', 'Шахноза Рахимова', None, None, True, False, 'UZ', 'Ташкент', 'dk'),
    ('u44', 'Канат Ибраев', None, None, False, True, 'KZ', 'Шымкент', 'am'),
    ('u45', 'Феруза Ташпулатова', 'Дизайнер интерьеров', 'f.tashpulatova@example.com', True, False, 'UZ', 'Ташкент', 'st'),
    ('u46', 'Мадина Хамидова', 'Интернет-магазин домашнего текстиля', 'm.hamidova@example.net', True, False, 'UZ', 'Ташкент', 'dk'),
    ('u47', 'Павел Григорьев', 'Частный покупатель', 'p.grigoriev@example.org', False, False, 'RU', 'Москва', 'am'),
    ('u48', 'Зульфия Мансурова', 'Организатор свадеб', None, True, False, 'UZ', 'Самарканд', 'dk'),
    ('u49', 'Тимур Ганиев', 'Владелец кафе', None, False, True, 'UZ', 'Ташкент', 'st'),
    ('u50', 'Светлана Иванова', 'Закупщик (салон красоты)', 's.ivanova@example.com', False, False, 'UZ', 'Ташкент', 'st'),
]

# deals: key, company, contacts, final stage, channel (telegram / whatsapp / email), days since created,
# days since the last stage change, products [(product, quantity, discount %)], extra.
# ask: what a deal without products is about; wait: the client's last question is so many days old and
# still unanswered («клиент ждёт ответа», older than the 3 days of the bot's reminders)
DEALS = [
    # won
    dict(key='W1', co='c10', ct=['u14', 'u15'], final='won', ch='telegram', age=86, last=31, created_by='head',
         label='Мега Уй — полотенца 50×90 и 70×140 для сети', prods=[('mt5090', 3000, 5), ('mt70140', 2000, 5)]),
    dict(key='W2', co='c15', ct=['u20', 'u21'], final='won', ch='email', age=80, last=24,
         label='Сайхун Палас — наборы «Люкс» и халаты для номеров', prods=[('hotel_lux', 120, 0), ('robe_vf', 240, 3)]),
    dict(key='W3', co='c23', ct=['u31', 'u32'], final='won', ch='whatsapp', mail=True, age=89, last=19,
         label='Алатау Текстиль — махровые полотенца, экспорт (USD)', prods=[('mt70140', 5000, 7), ('mt5090', 8000, 7)]),
    dict(key='W4', co='c01', ct=['u01'], final='won', ch='telegram', age=71, last=12, skip=['samples'],
         label='Текстиль Савдо Опт — вафельные и махровые полотенца', prods=[('vf4570', 10000, 5), ('mt3050', 6000, 5)]),
    dict(key='W5', co='c16', ct=['u22'], final='won', ch='email', age=62, last=8,
         label='Чорсу Гарден — полотенца и велюровые халаты для СПА', prods=[('mt70140', 400, 0), ('robe_vel', 150, 0)]),
    dict(key='W6', co='c26', ct=['u35', 'u36'], final='won', ch='whatsapp', mail=True, age=76, last=4,
         label='Бишкек Текстиль Импорт — махровые халаты, экспорт', prods=[('robe_mt', 1500, 5)]),
    # lost
    dict(key='L1', co='c25', ct=['u34'], final='lost', lost_at='kp', ch='whatsapp', age=58, last=33,
         reason='Цена', comment='Нашли поставщика из Турции дешевле на 12%', label='Шымкент Опт — полотенца 50×90',
         prods=[('mt5090', 6000, 0)]),
    dict(key='L2', co='c13', ct=['u18'], final='lost', lost_at='samples', ch='whatsapp', age=52, last=27,
         reason='Качество или образцы', comment='Не устроила плотность вафельного полотна',
         label='Домашний Очаг — вафельные полотенца 50×100', prods=[('vf50100', 4000, 0)]),
    dict(key='L3', co='c18', ct=['u25'], final='lost', lost_at='needs', ch='telegram', age=45, last=30,
         reason='Неактуально для клиента', comment='Ремонт номерного фонда перенесли на весну',
         label='Хива Оазис — наборы для номеров', prods=[('hotel_std', 60, 0)]),
    dict(key='L4', co='c27', ct=['u37'], final='lost', lost_at='agree', ch='whatsapp', age=40, last=9,
         reason='Сроки поставки', comment='Нужна поставка за 10 дней, производство не успевает',
         label='Ош Базар Трейд — полотенца 30×50 и кухонные наборы', prods=[('mt3050', 5000, 0), ('kitchen', 2000, 0)]),
    dict(key='L5', co='c07', ct=['u09'], final='lost', lost_at='first', ch='telegram', age=35, last=21,
         reason='Клиент не отвечает', comment=None, budget=25_000_000,
         label='Комфорт Текстиль — полотенца для магазина', prods=[],
         ask=dict(prod='махровые полотенца для магазина', qty='600 шт')),
    # open
    dict(key='N1', co=None, ct=['u43'], final='new', ch='telegram', age=0, last=0, channel_deal=True, prods=[],
         ask=dict(prod='махровые полотенца 50×90 и 70×140', qty='по 60 шт')),
    dict(key='N2', co=None, ct=['u44'], final='new', ch='whatsapp', age=1, last=1, channel_deal=True, prods=[],
         ask=dict(prod='полотенца 70×140 и коврики для ванной', qty='800 шт', purpose='для гостиницы')),
    dict(key='P1', co='c02', ct=['u03'], final='first', ch='telegram', age=2, last=2, budget=40_000_000,
         label='Нур Текстиль — новая партия махровых полотенец', prods=[],
         ask=dict(prod='махровые полотенца 30×50 и 50×90', qty='1 500 шт')),
    dict(key='P2', co='c17', ct=['u24'], final='first', ch='email', age=3, last=3, budget=0,
         label='Зарафшан Резиденс — текстиль для 80 номеров', prods=[],
         ask=dict(prod='полотенца, халаты и коврики', qty='на 80 номеров')),
    dict(key='P3', co='c28', ct=['u38'], final='first', ch='email', age=4, last=4, created_by='head', budget=0,
         label='Волга Текстиль Опт — пробная поставка в Казань', prods=[],
         ask=dict(prod='махровые полотенца 50×90 и 70×140', qty='2 000 шт для пробной партии')),
    dict(key='P4', co='c12', ct=['u17'], final='first', ch='telegram', age=6, last=6, budget=15_000_000, wait=5,
         label='Оила Маркет — полотенца для новых магазинов', prods=[],
         ask=dict(prod='махровые полотенца и кухонные наборы', qty='на три магазина', purpose='для новых магазинов')),
    dict(key='V1', co='c03', ct=['u04'], final='needs', ch='telegram', age=9, last=3,
         label='Самарканд Хоум Трейд — махровые полотенца', prods=[('mt5090', 2000, 0), ('mt70140', 1000, 0)]),
    dict(key='V2', co='c21', ct=['u29'], final='needs', ch='email', age=8, last=4,
         label='Навруз Сити — наборы для гостиницы и ресторана', prods=[('hotel_std', 200, 0)]),
    dict(key='V3', co='c24', ct=['u33'], final='needs', ch='whatsapp', age=12, last=5,
         label='Астана Хоум Декор — полотенца 70×140, экспорт', prods=[('mt70140', 3000, 0)]),
    dict(key='V4', co='c06', ct=['u08'], final='needs', ch='telegram', age=10, last=2,
         label='Андижон Текстиль Маркет — вафельные полотенца', prods=[('vf4570', 5000, 0)]),
    dict(key='K1', co='c11', ct=['u16'], final='kp', ch='telegram', mail=True, age=15, last=5,
         label='Мир Текстиля — полотенца трёх размеров', prods=[('mt3050', 3000, 0), ('mt5090', 3000, 0), ('mt70140', 1500, 0)]),
    dict(key='K2', co='c22', ct=['u30'], final='kp', ch='email', age=18, last=7,
         label='Уз Хотел Сервис — простыни и полотенца для прачечной', prods=[('sheet_bz', 1200, 0), ('mt5090', 2000, 0)]),
    dict(key='K3', co='c29', ct=['u40'], final='kp', ch='email', age=20, last=9, wait=6,
         label='Домашний Уют Сибирь — халаты и банные полотенца', prods=[('robe_mt', 800, 0), ('mt100150', 1000, 0)]),
    dict(key='K4', co='c04', ct=['u06'], final='kp', ch='whatsapp', age=14, last=4,
         label='Фаргона Мато Савдо — кухонные наборы и вафельные полотенца', prods=[('kitchen', 3000, 0), ('vf50100', 3000, 0)]),
    dict(key='K5', co=None, ct=['u45'], final='kp', ch='telegram', mail=True, age=11, last=3,
         label='Ф. Ташпулатова — текстиль для гостевого дома (дизайн-проект)', prods=[('robe_vel', 20, 0), ('mt70140', 40, 0), ('mat', 20, 0)]),
    dict(key='S1', co='c30', ct=['u41', 'u42'], final='samples', ch='whatsapp', mail=True, age=25, last=6,
         label='ТД Махра — полотенца 50×90 и 70×140, Москва', prods=[('mt5090', 10000, 5), ('mt70140', 6000, 5)]),
    dict(key='S2', co='c19', ct=['u26', 'u27'], final='samples', ch='email', age=22, last=4, created_by='head',
         label='Санаторий Чимган Тоглари — наборы и халаты', prods=[('hotel_std', 150, 0), ('robe_vf', 150, 0)]),
    dict(key='S3', co='c09', ct=['u12', 'u13'], final='samples', ch='telegram', mail=True, age=28, last=8, wait=6,
         label='Уютный Дом — постельное бельё и полотенца для сети', prods=[('bedset', 500, 0), ('mt70140', 1500, 0)]),
    dict(key='A1', co='c20', ct=['u28'], final='agree', ch='telegram', mail=True, age=30, last=5,
         label='Бахор Хостел Групп — простыни и полотенца для 4 хостелов', prods=[('sheet_bz', 400, 0), ('mt70140', 500, 0), ('mt5090', 500, 0)]),
    dict(key='A2', co='c08', ct=['u10', 'u11'], final='agree', ch='telegram', mail=True, age=33, last=3, skip=['samples'],
         label='Ипак Йули Савдо — полотенца 50×90 и для ног', prods=[('mt5090', 4000, 4), ('mtfoot', 2000, 4)]),
    dict(key='A3', co='c23', ct=['u31', 'u32'], final='agree', ch='whatsapp', mail=True, age=16, last=2, repeat_of='W3',
         skip=['samples'], label='Алатау Текстиль — повторный заказ 70×140 (USD)', prods=[('mt70140', 6000, 7)]),
    dict(key='A4', co='c14', ct=['u19'], final='agree', ch='telegram', mail=True, age=27, last=6,
         label='Зарафшон Савдо — вафельные полотенца и кухонные наборы', prods=[('vf4570', 6000, 3), ('kitchen', 1000, 3)]),
    dict(key='Pr1', co='c05', ct=['u07'], final='prepay', ch='telegram', mail=True, age=38, last=4,
         label='Бухоро Уй Жихозлари — полотенца 30×50 и 50×100', prods=[('mt3050', 4000, 3), ('vf50100', 3000, 3)]),
    dict(key='Pr2', co='c15', ct=['u20'], final='prepay', ch='email', age=20, last=2, repeat_of='W2', skip=['samples'],
         label='Сайхун Палас — дозаказ махровых халатов', prods=[('robe_mt', 200, 0)]),
    dict(key='Pr3', co='c10', ct=['u14'], final='prepay', ch='telegram', mail=True, age=26, last=1, repeat_of='W1',
         skip=['samples'], label='Мега Уй — банные полотенца 100×150, повторный заказ', prods=[('mt100150', 2500, 5)]),
    dict(key='Pd1', co='c01', ct=['u01', 'u02'], final='prod', ch='telegram', mail=True, age=10, last=2, repeat_of='W4',
         skip=['needs', 'kp', 'samples'], label='Текстиль Савдо Опт — вафельные 45×70, повтор', prods=[('vf4570', 8000, 5)]),
    dict(key='Pd2', co='c26', ct=['u35'], final='prod', ch='whatsapp', mail=True, age=45, last=9, created_by='head', wait=8,
         label='Бишкек Текстиль Импорт — полотенца 50×90 и коврики', prods=[('mt5090', 5000, 6), ('mat', 1000, 6)]),
    dict(key='Pd3', co='c16', ct=['u23'], final='prod', ch='telegram', age=7, last=1, repeat_of='W5',
         skip=['needs', 'kp', 'samples'], label='Чорсу Гарден — дозаказ велюровых халатов', prods=[('robe_vel', 80, 0)]),
    dict(key='Sh1', co='c02', ct=['u03'], final='ship', ch='telegram', age=48, last=2,
         label='Нур Текстиль — махровые полотенца 30×50 и 50×90', prods=[('mt3050', 5000, 4), ('mt5090', 2500, 4)]),
    dict(key='Sh2', co='c22', ct=['u30'], final='ship', ch='email', age=55, last=1,
         label='Уз Хотел Сервис — бязевые простыни и наборы «Стандарт»', prods=[('sheet_bz', 800, 3), ('hotel_std', 300, 3)]),
]

# the open task of an open deal: overdue / due today / later
DUE = {'P1': 'today', 'P2': 'future', 'P3': 'future', 'P4': 'overdue', 'V1': 'future', 'V2': 'today',
       'V3': 'future', 'V4': 'future', 'K1': 'today', 'K2': 'overdue', 'K3': 'overdue', 'K4': 'future',
       'K5': 'future', 'S1': 'future', 'S2': 'today', 'S3': 'overdue', 'A1': 'future', 'A2': 'today',
       'A3': 'future', 'A4': 'overdue', 'Pr1': 'future', 'Pr2': 'today', 'Pr3': 'future', 'Pd1': 'future',
       'Pd2': 'future', 'Pd3': 'future', 'Sh1': 'today', 'Sh2': 'future', 'N1': 'today', 'N2': 'future'}

# the question a waiting client asked last (no answer yet), per stage
WAIT_QUESTION = {
    'first': ['А для сети из трёх магазинов будет скидка? И доставка {v_city} — за чей счёт?',
              'Подскажите, можно ли первую партию взять на реализацию, а дальше по предоплате?'],
    'kp': ['Спасибо за предложение. Подскажите, возможна ли отсрочка платежа 30 дней и сколько стоит доставка {do_city}?',
           'Добрый день! КП изучили. Если возьмём {more} шт, какой будет цена? И можно ли оплату 30/70?'],
    'samples': ['Образцы получили, спасибо. Если увеличим заказ до {more} шт, срок изготовления останется прежним?',
                'Образцы посмотрели. А есть такое же полотенце плотнее, 550 г/м²? Сколько будет стоить?'],
    'prod': ['{agent}, а можно добавить к заказу ещё 300 ковриков? Успеете к {deadline}?',
             'Добрый день! Можно в эту же партию добавить 500 полотенец 30×50? Цена та же?'],
}


# ======================================================================================== the generator

class Gen:
    def __init__(self, now, seed, mailboxes, passwords, bases=None):
        self.now = now
        self.today = now.date()
        self.seed = seed
        # content (names, numbers, texts) and time are drawn apart: running at another moment changes the times only
        self.rng = random.Random(f'parisa-mock/{seed}')
        self.trng = random.Random(f'parisa-mock-time/{seed}')
        self.inbox, self.sent_box, self.spam_box, self.trash_box = mailboxes
        self.passwords = passwords
        self.bases = bases or {}          # table -> the mock ids start after this number
        self.rows = {t: [] for t in SEEDED_COLUMNS}
        self.events = []          # filled, then numbered by time
        self.tasks = []
        self.emails = []
        self.recordings = []
        self.phone_n = 1000
        self.pace_n = {}          # answers made so far, per manager (Gen.pace)
        self.used = {}            # how often each wording was used (Gen.pick)
        self.inn_n = {'UZ': 1001, 'KZ': 2001, 'KG': 3001, 'RU': 4001}
        self.deals = copy.deepcopy(DEALS)
        for c in COMPANIES:
            if c['city'] not in CITY:
                raise SystemExit(f"internal error: no case forms of the city {c['city']}")

    def nid(self, table, n):
        """The id of the n-th mock row of a table (1, 2, ...): right above what the table ever used."""
        return self.bases.get(table, 0) + n

    # ---------------------------------------------------------------- time
    def days_ago(self, days):
        return self.today - dt.timedelta(days=days)

    def workday(self, day):
        if day.weekday() == 6:            # Sunday: the Saturday before
            day = day - dt.timedelta(days=1)
        return day

    def at_work(self, day, lo=9 * 60 + 5, hi=18 * 60 + 20):
        m = self.trng.randint(lo, hi)
        t = dt.datetime.combine(day, dt.time(m // 60, m % 60, self.trng.randint(0, 59)))
        return min(t, self.now - dt.timedelta(minutes=self.trng.randint(25, 70)))

    def work_segments(self, a, b):
        """The working time inside (a, b): 09:00-18:30, Monday to Saturday."""
        segs = []
        day = a.date()
        while day <= b.date():
            if day.weekday() != 6:
                s = max(a, dt.datetime.combine(day, dt.time(9, 0)))
                e = min(b, dt.datetime.combine(day, dt.time(18, 30)))
                if e > s:
                    segs.append((s, e))
            day += dt.timedelta(days=1)
        return segs

    def spread(self, a, b, n, even=False):
        """n increasing moments strictly inside (a, b), in working hours when there are enough of them.
        even: about evenly apart (stage entries), else at random (what happened in a stage)."""
        if n <= 0:
            return []
        rng = self.trng
        segs = self.work_segments(a + dt.timedelta(minutes=1), b - dt.timedelta(minutes=1))
        total = sum((e - s).total_seconds() for s, e in segs)
        if total < n * 25 * 60:
            step = (b - a).total_seconds() / (n + 1)
            return [sec(a + dt.timedelta(seconds=step * (i + 1))) for i in range(n)]
        if even:
            pts = [(i + 0.5 + rng.uniform(-0.3, 0.3)) / n * total for i in range(n)]
        else:
            pts = sorted(rng.uniform(0, total) for _ in range(n))
        gap = min(total / (n + 1), 40 * 60)
        for i in range(1, n):
            pts[i] = max(pts[i], pts[i - 1] + gap)
        if pts[-1] >= total:
            scale = (total - 1) / (pts[-1] + 1)
            pts = [p * scale for p in pts]
        times = []
        for p in pts:
            left = p
            for s, e in segs:
                length = (e - s).total_seconds()
                if left <= length:
                    times.append(sec(s + dt.timedelta(seconds=left)))
                    break
                left -= length
            else:
                times.append(sec(segs[-1][1]))
        for i in range(1, n):          # whole seconds may tie: keep them strictly increasing
            if times[i] <= times[i - 1]:
                times[i] = times[i - 1] + dt.timedelta(seconds=1)
        return times

    # ---------------------------------------------------------------- numbers that cannot reach anybody
    def phone(self, cc):
        self.phone_n += 1
        n = self.phone_n
        if cc == 'UZ':
            return f'+99800000{n:04d}'       # «+998 00 000 NN NN»: the operator code 00 does not exist
        if cc == 'KG':
            return f'+99600000{n:04d}'       # «+996 000 00 NN NN»
        return f'+7000000{n:04d}'            # «+7 000 000 NN NN» (Russia, Kazakhstan): no such code

    def requisites(self, cc):
        n = self.inn_n[cc]
        self.inn_n[cc] += 1
        bank, mfo = self.rng.choice(BANKS[cc])
        if cc == 'UZ':   # 9 digits; legal entities have 2… / 3…, «99…» is never given out
            return f'99{n:07d}', f'20208000{n:012d}', bank, mfo
        if cc == 'KZ':   # БИН, 12 digits: month 13 does not exist
            return f'9913{n:08d}', f'KZ00999{n:013d}', bank, mfo
        if cc == 'KG':   # 14 digits, the date 31.13 does not exist
            return f'03113201{n:06d}', f'1299{n:012d}', bank, mfo
        return f'00{n:08d}', f'40702810{n:012d}', bank, mfo   # Russia: region 00 does not exist

    # ---------------------------------------------------------------- rows
    def add(self, table, row):
        self.rows[table].append(row)
        return row

    def event(self, etype, at, deal=None, by=None, to=None, after=None, before=None, field_of=None, task=None,
              outgoing=True, tg_message_id=None, external_id=None, duration=None, source='web', group=None,
              company_id=None, contact_id=None):
        at = sec(at)
        if at > self.now:
            raise SystemExit(f'internal error: an event in the future ({at}, type {etype})')
        e = dict(type=etype, created_at=at, deal=deal, by=by, to=to, after=after, before=before, field_of=field_of,
                 task=task, outgoing=outgoing, tg_message_id=tg_message_id, external_id=external_id,
                 duration=duration, source=source, group=group, company_id=company_id, contact_id=contact_id)
        self.events.append(e)
        return e

    # ---------------------------------------------------------------- texts
    def fmt(self, d, who, template):
        """A template of the deal's context, its past-tense verbs agreeing with the speaker («отправил((|а))»)."""
        text = template.format_map(d['ctx'])
        female = bool(who and who.get('female'))
        text = GENDER.sub(lambda m: m.group(2) if female else m.group(1), text)
        return re.sub(r'(?<=\.)\.(?!\.)', '', text)        # «200 компл.» at the end of a sentence: one full stop

    def pick(self, d, variants):
        """
        One of the wordings for this deal: among those used least so far by the deals built before (so the
        wordings of a step are dealt out evenly over the deals), at random between them (the deal's generator:
        one draw, the same on every run).
        """
        # one counter per step (its first wording names it; a variant added for some deals only joins it)
        used = self.used.setdefault(str(variants[0])[:60], {})
        names = [str(v)[:80] for v in variants]
        low = min(used.get(x, 0) for x in names)
        k = d['crng'].choice([j for j, x in enumerate(names) if used.get(x, 0) == low])
        used[names[k]] = used.get(names[k], 0) + 1
        return variants[k]

    def cl(self, d, *variants):
        """What the client writes: one of the variants, chosen per deal."""
        return self.fmt(d, d['main'], self.pick(d, variants))

    def mg(self, d, *variants):
        """What the manager writes."""
        return self.fmt(d, d['agent'], self.pick(d, variants))

    def pair(self, d, pairs):
        """A client's message and the manager's answer that belongs to it."""
        a, b = self.pick(d, pairs)
        return self.fmt(d, d['main'], a), self.fmt(d, d['agent'], b)

    # ================================================================ build everything
    def build(self):
        now = self.now
        start = self.now - dt.timedelta(days=96)
        base = dt.datetime.combine(self.workday((start - dt.timedelta(days=4)).date()), dt.time(10, 0))

        # groups
        self.groups = {}
        for i, (key, name) in enumerate(GROUPS, start=1):
            self.groups[key] = dict(id=self.nid('group', i), name=name)
        # staff
        self.staff = {}
        staff_rows = []
        for i, (key, name, email, tail, role, group, perms, title, goal) in enumerate(STAFF, start=1):
            u = dict(id=self.nid('user', i), n=i, key=key, username=name, email=email, role=role, group=group,
                     title=title, goal=goal, phone=f'+99800000{tail:04d}', female=name.split()[0] in FEMALE)
            self.staff[key] = u
            staff_rows.append((u, perms))
        for g_key, g in self.groups.items():
            goals = [u['goal'] for u in self.staff.values() if u['group'] == g_key]
            self.add('group', dict(id=g['id'], name=g['name'], created_at=base,
                                   objectives=self.objectives(sum(goals))))

        for u, perms in staff_rows:
            pw = self.passwords[u['email']]
            row = dict(id=u['id'], username=u['username'], email=u['email'], phone=u['phone'], password=pw['hash'],
                       role=u['role'], permissions=perms, updated_at=base + dt.timedelta(minutes=u['n']),
                       deleted_at=None, created_at=base + dt.timedelta(minutes=u['n']),
                       group_id=self.groups[u['group']]['id'] if u['group'] else None, company_id=None,
                       created_by=ADMIN_ID, updated_by=None, tg_id=None,
                       objectives=self.objectives(u['goal']), wa_id=None, avatar=None,
                       token_version=pw['tv'])
            self.add('user', row)

        # pipeline
        self.collection_id = self.nid('collection', 1)
        self.add('collection', dict(id=self.collection_id, name='Воронка', is_active=True, created_at=base))
        self.stage = {}
        for i, (key, name, kind, color, descr) in enumerate(STAGES):
            s = dict(id=self.nid('deal_stage', i + 1), key=key, name=name, kind=kind, color=color, order=i,
                     description=descr)
            self.stage[key] = s
            self.add('deal_stage', dict(id=s['id'], name=name, order=i, description=descr, created_at=base,
                                        color=color, collection_id=self.collection_id, kind=kind))
        self.add('setting', dict(id=self.nid('setting', 1), default_stage_id=self.stage['first']['id'],
                                 defaultAgentId=None, mail_signature=Raw('(SELECT mail_signature FROM seed_carry)')))
        # task types
        self.task_type = {}
        for i, name in enumerate(TASK_TYPES, start=1):
            self.task_type[name] = dict(id=self.nid('task_type', i), name=name)
            self.add('task_type', dict(id=self.task_type[name]['id'], name=name))
        # custom fields
        self.filler = {}
        for i, (key, target, field, required) in enumerate(FILLERS, start=1):
            self.filler[key] = self.nid('filler', i)
            self.add('filler', dict(id=self.filler[key], target=target, field=field, created_at=base,
                                    is_required=required))
        # products
        self.product = {}
        pf_n = 0
        for i, (key, name, sku, unit, price, comp, usd_price, gsm, size, short, phrase) in enumerate(PRODUCTS, start=1):
            pid = self.nid('product', i)
            self.product[key] = dict(id=pid, name=name, price=price, gsm=gsm, size=size, short=short, usd=usd_price,
                                     unit=unit, kind=phrase[0], kind_size=phrase[1])
            created = base + dt.timedelta(hours=1, minutes=i)
            self.add('product', dict(id=pid, name=name, deleted_at=None, created_at=created,
                                     created_by=self.staff['head']['id'], updated_by=None, sku=sku, unit=unit,
                                     price=Decimal(price)))
            for fkey, value in (('p_comp', comp), ('p_usd', usd_price)):
                pf_n += 1
                self.add('product_filler', dict(id=self.nid('product_filler', pf_n), value=value, created_at=created,
                                                product_id=pid, filler_id=self.filler[fkey]))

        # when each deal began: its contacts and company are older than it
        rng = self.trng
        for d in sorted(self.deals, key=lambda x: (-x['age'], x['key'])):
            day = self.workday(self.days_ago(d['age']))
            d['t0'] = sec(self.at_work(day) if d['age'] > 0 else now - dt.timedelta(minutes=rng.randint(90, 200)))
        self.build_clients(base)
        self.build_deals()
        self.build_loose_tasks_and_notes()
        self.build_mail_outside_deals()
        self.fix_waiting_clients()
        self.finish()

    def objectives(self, monthly):
        return {'monthly': int(monthly), 'quarterly': int(monthly * 3), 'yearly': int(monthly * 12)}

    # ---------------------------------------------------------------- companies and contacts
    def build_clients(self, base):
        first_deal_age = {}
        for d in self.deals:
            if d['co']:
                first_deal_age[d['co']] = max(first_deal_age.get(d['co'], 0), d['age'])
        self.company = {}
        self.contact = {}
        companies = sorted(COMPANIES, key=lambda c: -first_deal_age.get(c['key'], 1))
        for n, c in enumerate(companies, start=1):
            cid = self.nid('company', n)
            age = first_deal_age.get(c['key'], 40) + self.trng.randint(1, 3)
            if c['is_old']:
                age = max(age, 92)
            created = self.at_work(self.workday(self.days_ago(age)))
            agent = self.staff[c['agent']]
            inn, account, bank, mfo = self.requisites(c['cc'])
            phone = self.phone(c['cc'])
            co = dict(id=cid, key=c['key'], name=c['name'], short=c['short'], seg=c['seg'], cc=c['cc'], city=c['city'],
                      agent=agent, created_at=created, phone=phone, email=f"info.{c['slug']}@example.com",
                      is_old=c['is_old'], inn=inn, contacts=[])
            self.company[c['key']] = co
            row = dict(id=cid, name=c['name'], email=co['email'], phone=phone, updated_at=created, deleted_at=None,
                       created_at=created, created_by=agent['id'], updated_by=None, is_old=c['is_old'], inn=inn,
                       legal_address=c['addr'], bank_account=account, bank_name=bank, mfo=mfo, oked=OKED[c['seg']],
                       director=c['director'], primary_contact_id=None)
            co['row'] = row
            self.add('company', row)
            for fkey, value in (('c_country', COUNTRY[c['cc']]), ('c_city', c['city']), ('c_type', SEGMENT_TYPE[c['seg']])):
                self.add('company_filler', dict(id=None, value=value, created_at=created, company_id=cid,
                                                filler_id=self.filler[fkey]))
            for k, (key, name, pos, email, tg, wa) in enumerate(c['contacts']):
                self.contact[key] = dict(key=key, username=name, position=pos, email=email, tg=tg, wa=wa, cc=c['cc'],
                                         city=c['city'], company=co, created_at=created + dt.timedelta(minutes=3 + 2 * k),
                                         created_by=agent, female=name.split()[0] in FEMALE)
                co['contacts'].append(self.contact[key])
        for key, name, pos, email, tg, wa, cc, city, agent in LONE_CONTACTS:
            starts = [d['t0'] for d in self.deals if key in d['ct']]
            if starts:   # the client wrote, the contact was made, then the deal (a minute later)
                created = min(starts) - dt.timedelta(minutes=1)
            else:
                created = self.at_work(self.workday(self.days_ago(self.trng.randint(12, 60))))
            self.contact[key] = dict(key=key, username=name, position=pos, email=email, tg=tg, wa=wa, cc=cc, city=city,
                                     company=None, created_at=sec(created), created_by=self.staff[agent],
                                     female=name.split()[0] in FEMALE)
        # contacts are numbered in the order they were created, after the staff
        ordered = sorted(self.contact.values(), key=lambda u: (u['created_at'], u['key']))
        n = len(STAFF)
        uf = 0
        for u in ordered:
            n += 1
            u['id'] = self.nid('user', n)
            u['role'] = 'ctr_agent'
            u['phone'] = self.phone(u['cc'])
            digits = u['phone'].lstrip('+')
            u['tg_id'] = TG_ID_BASE + n if u['tg'] else None
            u['wa_id'] = f'{digits}@s.whatsapp.net' if u['wa'] else None
            self.add('user', dict(id=u['id'], username=u['username'], email=u['email'], phone=u['phone'], password=None,
                                  role='ctr_agent', permissions=None, updated_at=u['created_at'], deleted_at=None,
                                  created_at=u['created_at'], group_id=None,
                                  company_id=u['company']['id'] if u['company'] else None,
                                  created_by=u['created_by']['id'], updated_by=None, tg_id=u['tg_id'],
                                  objectives=self.objectives(0), wa_id=u['wa_id'], avatar=None, token_version=0))
            if u['position']:
                uf += 1
                self.add('user_filler', dict(id=self.nid('user_filler', uf), value=u['position'],
                                             created_at=u['created_at'], user_id=u['id'],
                                             filler_id=self.filler['u_position']))
        for co in self.company.values():
            if co['contacts']:
                co['row']['primary_contact_id'] = co['contacts'][0]['id']
        for n, row in enumerate(self.rows['company_filler'], start=1):
            row['id'] = self.nid('company_filler', n)

    # ---------------------------------------------------------------- deals
    def build_deals(self):
        self.deal = {}
        # numbers (display_id) go by creation, as the API gives them
        specs = sorted(self.deals, key=lambda d: (d['t0'], d['key']))
        for n, d in enumerate(specs, start=1):
            d['no'] = n
            d['id'] = self.nid('deal', n)
            # the texts of a deal are drawn from its own generator: one deal's wording never shifts another's
            d['crng'] = random.Random(f"parisa-mock/{self.seed}/deal/{d['key']}")
            self.deal[d['key']] = d
        for d in specs:
            # the times of each deal come from its own generator: the moment of the run shapes the current stage
            # of a deal (its window ends now), and that must not move the times (and the order) of the others
            self.trng = random.Random(f"parisa-mock-time/{self.seed}/deal/{d['key']}")
            self.build_deal(d)
        self.trng = random.Random(f'parisa-mock-time/{self.seed}/rest')

    def path_of(self, d):
        final = d['final']
        skip = set(d.get('skip', []))
        if final == 'new':
            return ['new']
        if d.get('channel_deal'):
            start = ['new']
        else:
            start = []
        if final == 'lost':
            upto = FLOW[:FLOW.index(d['lost_at']) + 1]
            path = start + [s for s in upto if s not in skip or s == d['lost_at']] + ['lost']
        else:
            upto = FLOW[:FLOW.index(final) + 1]
            path = start + [s for s in upto if s not in skip or s == final]
        return path

    def build_deal(self, d):
        now = self.now
        agent = self.staff[self.company[d['co']]['agent']['key']] if d['co'] else self.contact[d['ct'][0]]['created_by']
        d['agent'] = agent
        creator = self.staff[d['created_by']] if d.get('created_by') else agent
        company = self.company[d['co']] if d['co'] else None
        contacts = [self.contact[k] for k in d['ct']]
        main = contacts[0]
        path = self.path_of(d)
        k = len(path) - 1
        t0 = d['t0']
        # stage entries
        if k == 0:
            times = [t0]
        else:
            last_day = self.workday(self.days_ago(d['last']))
            tk = self.at_work(last_day)
            if tk <= t0 + dt.timedelta(hours=2 * k):
                tk = min(now - dt.timedelta(minutes=30), t0 + dt.timedelta(hours=3 * k + 2))
            inner = self.spread(t0, sec(tk), k - 1, even=True)
            times = [t0] + inner + [sec(tk)]
        if any(times[j] >= times[j + 1] for j in range(len(times) - 1)) or times[-1] > now:
            raise SystemExit(f"internal error: the stages of deal {d['key']} are not in time order")
        d['path'], d['times'] = path, times
        closed = path[-1] in ('won', 'lost')
        d['closed_at'] = times[-1] if closed else None
        d['last_stage_change'] = times[-1] if k > 0 else None
        d['company'], d['contacts'], d['main'], d['creator'] = company, contacts, main, creator

        # products: list prices at creation; the discount from «Согласование» on
        lines = []
        for pkey, qty, disc in d['prods']:
            p = self.product[pkey]
            final_price = round_price(p['price'] * (100 - disc) / 100) if disc and 'agree' in path else p['price']
            lines.append(dict(product=p, qty=qty, list_price=p['price'], price=final_price, disc=disc))
        d['lines'] = lines
        list_total = sum(l['qty'] * l['list_price'] for l in lines)
        final_total = sum(l['qty'] * l['price'] for l in lines)
        budget0 = Decimal(list_total if lines else d.get('budget', 0) or 0)
        d['budget'] = Decimal(final_total if lines else d.get('budget', 0) or 0)
        d['ctx'] = self.context(d)

        if d.get('channel_deal'):
            d['label'] = ' · '.join(x for x in [main['username'], main['phone'], company['name'] if company else None] if x)

        repeat = self.deal[d['repeat_of']]['id'] if d.get('repeat_of') else None
        self.add('deal', dict(id=d['id'], label=d['label'], display_id=d['no'], budget=d['budget'], created_at=t0,
                              stage_id=self.stage[path[-1]]['id'], agent_id=agent['id'], created_by=creator['id'],
                              company_id=company['id'] if company else None, closed_at=d['closed_at'],
                              last_stage_change=d['last_stage_change'], deleted_at=None, deleted_by=None,
                              repeat_of_id=repeat, lost_reason=d.get('reason') if path[-1] == 'lost' else None,
                              lost_comment=d.get('comment') if path[-1] == 'lost' else None))
        for c in contacts:
            self.add('deal_user', {'dealId': d['id'], 'userId': c['id']})
        for l in lines:
            self.add('deal_product', dict(id=None, quantity=Decimal(l['qty']), price=Decimal(l['price']),
                                          deal_id=d['id'], product_id=l['product']['id']))
        self.deal_fillers(d)

        # stage history
        for i, s in enumerate(path):
            nxt = times[i + 1] if i < k else None
            self.add('deal_stage_record', dict(
                id=None, moved_after_minutes=int((nxt - times[i]).total_seconds() // 60) if nxt else None,
                created_at=times[i], deal_id=d['id'], stage_id=self.stage[s]['id'],
                from_stage_id=self.stage[path[i - 1]]['id'] if i else None,
                moved_by=(creator if i == 0 else agent)['id']))

        # «сделка создана», its contacts, company and products (DealService.create)
        src = d['ch'] if d.get('channel_deal') else 'web'
        snap = self.deal_snapshot(d, budget0, path[0])
        self.event(E_NEW_DEAL, t0, deal=d, by=creator, to=agent, after={'data': snap}, source=src)
        for c in contacts:
            self.event(E_NEW_CONTACT, t0, deal=d, by=creator, after={'data': self.contact_snapshot(c)}, source=src)
        if company:
            self.event(E_NEW_COMPANY, t0, deal=d, by=creator, after={'data': self.company_snapshot(company)}, source=src)
        for l in lines:
            self.event(E_PRODUCT, t0, deal=d, by=creator, source=src,
                       after={'data': {'product': {'id': l['product']['id'], 'name': l['product']['name']},
                                       'price': l['list_price'], 'quantity': l['qty']}})

        # what happened in each stage
        for i, s in enumerate(path):
            a = times[i]
            b = times[i + 1] if i < k else (now - dt.timedelta(minutes=self.trng.randint(10, 25)) if not closed
                                            else times[i] + dt.timedelta(hours=2))
            b = sec(min(b, now - dt.timedelta(minutes=1)))
            if d.get('wait') and i == k:
                # «клиент ждёт ответа»: the last question is older than the 3 days the CRM bot looks at
                b = sec(max(a + dt.timedelta(hours=3), now - dt.timedelta(days=d['wait'], hours=2)))
            if i > 0:
                prev = self.stage[path[i - 1]]
                self.event(E_STAGE, a, deal=d, by=agent, after={'data': {'stage': self.stage_snapshot(self.stage[s])}},
                           before={'data': {'stage': self.stage_snapshot(prev)}})
            current = (i == k)
            d['in_current'] = current
            self.stage_story(d, s, a, b, current, i)
        for row in d.get('filler_rows', []):
            row['created_at'] = d.get('tz_at', row['created_at'])

    # ---------------------------------------------------------------- snapshots of the history
    def stage_snapshot(self, s):
        return {'id': s['id'], 'name': s['name'], 'color': s['color'], 'kind': s['kind'], 'order': s['order'],
                'description': s['description'], 'created_at': iso(self.rows['deal_stage'][0]['created_at'])}

    def deal_snapshot(self, d, budget, stage_key):
        s = self.stage[stage_key]
        return {
            'id': d['id'], 'label': d['label'], 'display_id': d['no'], 'budget': dec_text(budget),
            'created_at': iso(d['t0']), 'closed_at': None, 'last_stage_change': None, 'deleted_at': None,
            'lost_reason': None, 'lost_comment': None,
            'stage': {'id': s['id'], 'name': s['name'], 'color': s['color']},
            'agent': person(d['agent']), 'created_by': person(d['creator']),
            'company': {'id': d['company']['id'], 'name': d['company']['name']} if d['company'] else None,
            'ctr_agents': [person(c) for c in d['contacts']],
            'products': [{'product': {'id': l['product']['id'], 'name': l['product']['name']},
                          'quantity': l['qty'], 'price': l['list_price']} for l in d['lines']],
        }

    def contact_snapshot(self, c):
        snap = {'id': c['id'], 'username': c['username'], 'email': c['email'], 'phone': c['phone'], 'role': 'ctr_agent',
                'tg_id': str(c['tg_id']) if c['tg_id'] else None, 'wa_id': c['wa_id'], 'avatar': None,
                'created_at': iso(c['created_at']), 'updated_at': iso(c['created_at']), 'deleted_at': None}
        snap['company'] = {'id': c['company']['id'], 'name': c['company']['name']} if c['company'] else None
        return snap

    def company_snapshot(self, co):
        r = co['row']
        return {'id': r['id'], 'name': r['name'], 'email': r['email'], 'phone': r['phone'], 'is_old': r['is_old'],
                'inn': r['inn'], 'legal_address': r['legal_address'], 'bank_account': r['bank_account'],
                'bank_name': r['bank_name'], 'mfo': r['mfo'], 'oked': r['oked'], 'director': r['director'],
                'created_at': iso(r['created_at']), 'updated_at': iso(r['updated_at']), 'deleted_at': None}

    def task_snapshot(self, t):
        typ = self.task_type[t['type']]
        return {'data': {
            'id': t['id'], 'label': t['label'], 'result': t['result'],
            'closed_at': iso(t['closed_at']) if t['closed_at'] else None,
            'start_time': iso(t['start']), 'end_time': iso(t['end']), 'allDay': t['all_day'],
            'created_at': iso(t['created_at']),
            'type': {'id': typ['id'], 'name': typ['name']},
            'agent': person(t['agent']),
            'group': {'id': t['group']['id'], 'name': t['group']['name']} if t['group'] else None,
            'created_by': person(t['creator']),
            'deal': {'id': t['deal']['id'], 'label': t['deal']['label'], 'display_id': t['deal']['no']} if t['deal'] else None,
            'company': {'id': t['company']['id'], 'name': t['company']['name']} if t['company'] else None,
            'ctr_agent': person(t['contact']) if t['contact'] else None,
        }}

    # ---------------------------------------------------------------- custom fields of a deal
    def deal_fillers(self, d):
        """The fields say what the client asked for in the feed: the same colour, logo, sizes, density, amount."""
        if d['path'][-1] in ('new', 'first') or not d['lines']:
            return
        c = d['ctx']
        values = {
            'd_gsm': c['gsm_field'],
            'd_size': ', '.join(dict.fromkeys(l['product']['size'] for l in d['lines'])),
            'd_color': c['color_field'],
            'd_qty': (money(sum(l['qty'] for l in d['lines'])) if all(l['product']['unit'] == 'шт' for l in d['lines'])
                      else self.qty_phrase(d['lines'])),
            'd_logo': c['logo_field'],
            'd_country': COUNTRY[c['cc']],
            'd_deadline': c['deadline'],
        }
        if c['export']:
            values['d_currency'] = f"USD ({c['final_total']})"
        filled = d['times'][d['path'].index('needs')] if 'needs' in d['path'] else d['t0']
        d['filler_rows'] = []
        for key, value in values.items():
            d['filler_rows'].append(self.add('deal_filler', dict(id=None, value=value, created_at=filled, deal_id=d['id'],
                                                                 filler_id=self.filler[key])))

    # ---------------------------------------------------------------- the deal's own facts, used by its texts
    def prod_phrase(self, lines):
        """«махровые полотенца 50×90 и 70×140, коврики для ванной 50×70»."""
        groups = {}
        for l in lines:
            p = l['product']
            groups.setdefault(p['kind'], [])
            if p['kind_size']:
                groups[p['kind']].append(p['kind_size'])
        parts = [kind + (' ' + and_join(sizes) if sizes else '') for kind, sizes in groups.items()]
        if any(' и ' in p for p in parts):
            return ', '.join(parts)
        return and_join(parts)

    def qty_phrase(self, lines):
        """«5 000 шт», «500 компл. и 1 500 шт»."""
        by_unit = {}
        for l in lines:
            by_unit[l['product']['unit']] = by_unit.get(l['product']['unit'], 0) + l['qty']
        return and_join([f'{money(n)} {unit}' for unit, n in sorted(by_unit.items(), key=lambda x: x[0] != 'компл.')])

    def deadline_of(self, d, r, transit, ready):
        """«Срок поставки»: agreed during the deal; for a shipped deal a few days after the goods arrived,
        in the past for a closed deal, in the future for an open one."""
        today = self.today
        entry = dict(zip(d['path'], d['times']))
        final = d['path'][-1]
        closed = final in ('won', 'lost')
        if 'ship' in entry:
            day = entry['ship'].date() + dt.timedelta(days=transit + r.randint(1, 4))
        elif final == 'prod':
            day = ready + dt.timedelta(days=transit + r.randint(2, 6))
        elif final == 'prepay':
            day = today + dt.timedelta(days=r.randint(24, 32))
        elif d.get('reason') == 'Сроки поставки':
            day = entry[d['lost_at']].date() + dt.timedelta(days=10)
        else:
            agreed = entry.get('needs', d['times'][-1] if not closed else d['t0']).date()
            day = agreed + dt.timedelta(days=r.randint(35, 55))
        if final == 'lost':
            day = min(day, entry['lost'].date() + dt.timedelta(days=r.randint(7, 25)))
        if closed:
            day = min(day, today - dt.timedelta(days=1 + r.randint(0, 3)))
            if 'ship' in entry:
                day = max(day, entry['ship'].date() + dt.timedelta(days=1))
        else:
            soonest = {'ship': 1, 'prod': 7, 'prepay': 21}.get(final, 25)
            day = max(day, today + dt.timedelta(days=soonest))
        if day.weekday() == 6:
            day += dt.timedelta(days=1)
        return day

    def context(self, d):
        r = d['crng']
        main = d['main']
        co = d['company']
        seg = co['seg'] if co else 'private'
        cc = co['cc'] if co else main['cc']
        city = co['city'] if co else main['city']
        where, where_to, of = CITY[city]
        ask = d.get('ask') or {}
        lines = d['lines']
        export = cc != 'UZ'
        if lines:
            prod = self.prod_phrase(lines)
            qty = self.qty_phrase(lines)
            lines_txt = ', '.join(f"{l['product']['short']} — {money(l['qty'])} {l['product']['unit']}" for l in lines)
            gsms = sorted({l['product']['gsm'] for l in lines}, key=int)
            gsm = and_join(gsms) + ' г/м²'
            first = lines[0]['product']
            first_item = first['kind'] + (' ' + first['kind_size'] if first['kind_size'] else '')
            first_price = f"{usd(first['usd'])} $" if export else f"{money(first['price'])} сум"
            price_hint = f"{first_item} — {first_price} за {'комплект' if first['unit'] == 'компл.' else 'штуку'}"
        else:
            prod, qty = ask['prod'], ask['qty']
            lines_txt = f'{prod}, {qty}'
            gsms = ['450', '500']
            gsm = '450–500 г/м²'
            first_item = prod
            first_price = 'от 3,30 $' if export else 'от 42 000 сум'
            price_hint = ('махровые полотенца 50×90 — от 3,30 $, 70×140 — от 6,70 $ за штуку' if export else
                          'махровые полотенца 50×90 — от 42 000 сум, 70×140 — от 85 000 сум за штуку')
        color_field, color = r.choice(COLORS[seg])
        logo, logo_field = r.choice(LOGOS[seg if seg in LOGOS else 'other'])
        if d.get('repeat_of'):
            # a repeat order: the same colour and logo as the order it repeats
            before = self.deal[d['repeat_of']]['ctx']
            color_field, color, logo, logo_field = before['color_field'], before['color'], before['logo'], before['logo_field']
        purpose = ask.get('purpose') or (f'для наших покупателей {IN_COUNTRY[cc]}' if seg == 'export' else PURPOSE[seg])
        lo, hi = TRANSIT[cc]
        transit = r.randint(lo, hi)
        entry = dict(zip(d['path'], d['times']))
        if 'ship' in entry and 'won' in entry:
            # the goods arrived before the client confirmed and paid the rest
            transit = max(1, min(transit, (entry['won'].date() - entry['ship'].date()).days - 1))
        ready_days = r.randint(5, 12)
        if 'ship' in entry:
            ready = entry['ship'].date()
        else:
            ready = self.today + dt.timedelta(days=ready_days)
        deadline = self.deadline_of(d, r, transit, ready)
        list_usd = sum(Decimal(l['product']['usd']) * l['qty'] for l in lines)
        final_usd = sum(Decimal(l['product']['usd']) * l['qty'] * (100 - (l['disc'] if l['price'] != l['list_price'] else 0)) / 100
                        for l in lines)
        total = f'{usd(list_usd)} $' if export else f"{money(sum(l['qty'] * l['list_price'] for l in lines))} сум"
        final_total = f'{usd(final_usd)} $' if export else f"{money(d['budget'])} сум"
        half = f'{usd(final_usd / 2)} $' if export else f"{money(d['budget'] / 2)} сум"
        year = d['t0'].year
        return dict(first=main['username'].split()[0], client=main['username'],
                    co=co['short'] if co else main['username'],
                    agent=d['agent']['username'].split()[0], agent_full=d['agent']['username'],
                    prod=prod, qty=qty, lines=lines_txt, gsm=gsm, gsm_field=', '.join(gsms),
                    first_item=first_item, first_price=first_price,
                    color=color, color_field=color_field, logo=logo, logo_field=logo_field,
                    city=city, in_city=where, v_city=where_to, do_city='до ' + of, seg=SEG_TEXT[seg], seg_key=seg,
                    cc=cc, export=export, purpose=purpose, transit=plural(transit, 'день', 'дня', 'дней'), transit_days=transit,
                    ready=ready.strftime('%d.%m.%Y'), ready_h=human_date(ready, year),
                    deadline=deadline.strftime('%d.%m.%Y'), deadline_h=human_date(deadline, year),
                    price_hint=price_hint, total=total, final_total=final_total, half=half,
                    kp_no=f'{r.randint(100, 999)}/{self.today.year % 100}',
                    contract=f'{r.randint(10, 99)}-{self.today.year}', invoice=f'{r.randint(1000, 9999)}',
                    ttn=f'{r.randint(100000, 999999)}', waybill=f'{r.randint(10000, 99999)}',
                    pallets=plural(r.randint(2, 12), 'паллета', 'паллеты', 'паллет'),
                    sample=self.prod_phrase(lines[:2]) if lines else 'полотенца',
                    more=money(int(sum(l['qty'] for l in lines) * 1.2 // 100 * 100)) if lines else '2 000',
                    disc_ask='', disc='')

    def kp_rows(self, d):
        c = d['ctx']
        rows = []
        for l in d['lines']:
            p = l['product']
            price = f"{usd(p['usd'])} $" if c['export'] else f"{money(l['list_price'])} сум"
            rows.append(f"{p['name']} — {money(l['qty'])} {p['unit']} × {price}")
        return rows

    def kp_subject(self, d):
        return f"Коммерческое предложение Parisa Home № {d['ctx']['kp_no']}"

    def kp_act(self, d):
        """The offer: by e-mail when the client has an address, else as a message."""
        c = d['ctx']
        rows = self.kp_rows(d)
        delivery = ('Доставка {do_city} — за счёт покупателя, поможем с перевозчиком.' if c['export'] else
                    'Доставка {do_city} — за наш счёт.').format_map(c)
        body = (f"<p>Добрый день, {c['first']}!</p><p>Направляем коммерческое предложение:</p>"
                '<ul>' + ''.join(f'<li>{x}</li>' for x in rows) + '</ul>'
                f"<p>Итого: {c['total']}. Срок изготовления — 14–18 рабочих дней. Оплата: 50% предоплата, "
                f"50% перед отгрузкой. {delivery}</p>"
                f"<p>С уважением,<br>{c['agent_full']}<br>Parisa Home</p>")
        text = (f"Направляю коммерческое предложение № {c['kp_no']}:\n" + '\n'.join('• ' + x for x in rows) +
                f"\nИтого: {c['total']}. Срок изготовления — 14–18 рабочих дней, оплата 50% предоплата и 50% перед отгрузкой. "
                + delivery)
        return ('mail_or_msg', 'out', self.kp_subject(d), body, text)

    # ---------------------------------------------------------------- one stage of a deal
    def stage_story(self, d, s, a, b, current, i):
        """
        What happened while the deal was in stage s (from a till b). current: the deal is in it now.
        Acts, in their order: ('burst', [item ...]) messages in a row (the manager answers a client at his pace),
        ('mail_or_msg', 'out', subject, html, text) an offer / a contract by e-mail when the client has an address,
        ('call', 'in' / 'out', seconds), ('note', author, text[, 'tz']), ('internal', from, to, text), ('discount',),
        ('lost_reason', text), ('task', type, label, result) — result None: the open task of the current stage.
        When (place()): plain acts spread over the stage in working hours; ('@start', act) right when the deal
        entered the stage, ('@soon', act) a few minutes after the act before, ('@next', act, lo, hi) lo-hi minutes
        after the act before, ('@at', act, moment) like a plain act but not before the moment, ('@end', act) just
        before the deal left the stage. Every text has several wordings
        and the deal's own facts; the wording is drawn from the deal's generator (the same run day: the same text).
        """
        c = d['ctx']
        agent = d['agent']
        r = d['crng']
        acts = []
        path = d['path']
        lost_next = (path[-1] == 'lost' and i == len(path) - 2)
        nxt = path[i + 1] if i + 1 < len(path) else None
        by_mail = bool(d['ch'] == 'email' and d['main']['email'])
        waits = current and d.get('wait')
        repeat = bool(d.get('repeat_of'))
        multi = len(d['lines']) > 1
        white = c['color_field'] == 'Белый'
        cl, mg, pair = (lambda *v: self.cl(d, *v)), (lambda *v: self.mg(d, *v)), (lambda p: self.pair(d, p))

        def done(typ, label, results):
            """The stage's task: open while the deal is in the stage, else closed with one of the results."""
            result = r.choice(results)
            if current and path[-1] not in ('won', 'lost'):
                return ('task', typ, label, None)
            return ('@end', ('task', typ, label, self.fmt(d, agent, result)))

        if s == 'new':
            asks = ['Здравствуйте! Интересуют {prod}, нужно примерно {qty}. Подскажите цены и сроки?',
                    'Добрый день! Сколько стоят {prod}? Нужно {qty}, доставка {v_city}.',
                    'Здравствуйте, увидел((|а)) ваш каталог в Instagram. Есть {prod}? Нужно {qty}, мы {in_city}.',
                    'Добрый день! Вы сами шьёте? Хотим заказать {prod} {purpose}, нужно {qty}. Какие цены?']
            if c['cc'] == 'UZ':
                asks.append('Ассалому алайкум! Вы сами шьёте? Хотим заказать {prod} {purpose}, нужно {qty}. Какие цены?')
            ask = cl(*asks)
            hello = mg('Здравствуйте, {first}! Меня зовут {agent}, Parisa Home. Да, шьём сами. Подскажите плотность и цвет — подготовлю расчёт.',
                       'Добрый день, {first}! Спасибо за обращение. Уточните, пожалуйста, плотность, цвет и нужен ли логотип — пришлю цены сегодня.',
                       '{first}, здравствуйте! Это {agent}, менеджер Parisa Home. Сошьём за 2–3 недели. Какие цвет и плотность нужны?')
            emb = '0,30 $' if c['export'] else '3 500 сум'
            detail, ok = pair([('Белые, плотность 450–500. Логотип не нужен.', 'Принято! Посчитаю {prod} и через час пришлю расчёт.'),
                               ('Цвет белый или бежевый. Какая плотность у вас самая ходовая?',
                                'Самая ходовая — 450 г/м². Пришлю расчёт по двум вариантам сегодня.'),
                               ('Белые, с вышивкой названия. Сколько будет стоить вышивка?',
                                f'Вышивка — от {emb} за изделие, зависит от размера. Посчитаю всё вместе и пришлю.'),
                               ('Цвет — светло-серый, плотность любая, лишь бы не линяли. Сроки какие?',
                                'Не линяют, красим стойкими красителями. Изготовление — 2–3 недели, расчёт пришлю сегодня.'),
                               ('Бежевые. Доставка {v_city} возможна?',
                                'Да, доставляем {v_city} — посчитаю с доставкой и пришлю сегодня.')])
            acts.append(('@start', ('burst', [item('in', ask, subj=f"Запрос цен: {c['prod']}" if by_mail else None),
                                              item('out', hello), item('in', detail), item('out', ok)])))
            if current:
                acts.append(('task', 'Связаться', 'Разобрать обращение и выяснить потребность', None))

        elif s == 'first':
            if repeat:
                note = mg('Повторный заказ: {lines}, плотность {gsm}. Цвет — {color}, {logo}, как в прошлой партии. Срок — до {deadline}.',
                          'Клиент повторяет заказ: {lines}; {gsm}; цвет и логотип те же ({color}, {logo}). Поставка до {deadline} {v_city}.')
            else:
                note = mg('Первый разговор: {seg} {in_city}. Интересуют {prod}, ориентировочно {qty}. Договорились уточнить ТЗ.',
                          'Клиент — {seg}. Нужны {prod}, ориентировочно {qty}. Жду ТЗ по плотности и цвету.',
                          'Звонок: {seg}, закупают {prod} {purpose}. Следующий шаг — потребность и расчёт.',
                          'Знакомство: {co}, {seg} {in_city}. Обсудили {prod}, объём — {qty}. Цены отправлены.',
                          'Созвонились с клиентом ({co}). Интерес: {prod}, {qty}. Ждём ТЗ и сроки.')
            topic = done('Связаться', 'Обсудить потребность и объёмы',
                         ['Клиент описал потребность, готовим расчёт', 'Получили ТЗ, считаем', 'Обсудили объёмы, ждём ТЗ',
                          'Созвонились, потребность ясна', 'Договорились о ТЗ, клиент пришлёт детали'])
            if lost_next:    # the client went silent
                acts += [('call', 'out', r.randint(40, 90)),
                         ('@next', ('burst', [item('out', mg('{first}, добрый день! Отправил((|а)) цены, удобно ли сейчас обсудить объёмы?',
                                                             '{first}, здравствуйте! Как и обещал((|а)), цены: {price_hint}. Когда удобно созвониться?',
                                                             'Добрый день, {first}! Это {agent}, Parisa Home. Цены для вас: {price_hint}. Жду обратной связи.'))]), 5, 60),
                         ('burst', [item('out', mg('{first}, напомню о себе: подготовили для вас специальные цены на {prod}.',
                                                   '{first}, добрый день! Предложение по {qty} ещё в силе, жду вашего ответа.',
                                                   '{first}, вы успели посмотреть цены? Готов((|а)) созвониться в любое удобное время.'))]),
                         ('note', agent, mg('Клиент не берёт трубку, на сообщения не отвечает две недели.',
                                            'Две недели без ответа: звонки и сообщения не принимает.',
                                            'Три звонка без ответа, сообщения не читает. Закрываем.')),
                         ('@end', ('task', 'Связаться', 'Дозвониться до клиента', 'Клиент не выходит на связь, закрываем сделку'))]
            elif by_mail:
                who = d['company']['short'] if d['company'] else c['first']
                req = cl('Добрый день! Нас интересуют {prod} {purpose}. Пришлите, пожалуйста, прайс и условия поставки {v_city}.',
                         'Здравствуйте! Планируем закупку: {prod}, ориентировочно {qty}. Просим направить коммерческое предложение с доставкой {v_city}.',
                         'Добрый день. Ищем поставщика текстиля {purpose}: нужны {prod}, ориентировочно {qty}. Какие у вас цены и сроки изготовления?',
                         'Здравствуйте! Мы — {seg} {in_city}. Рассматриваем {prod}, объём — {qty}. Пришлите каталог и цены, пожалуйста.',
                         'Добрый день! Коллеги порекомендовали Parisa Home. Нужны {prod} ({qty}) {purpose}. Подскажите цены и сроки.')
                reply = mg('Добрый день, {first}! Спасибо за запрос. Позвоню вам в течение часа, уточню детали и пришлю предложение.',
                           'Здравствуйте, {first}! Получил((|а)) ваш запрос, спасибо. Наберу вас в течение часа — обсудим объёмы и сроки.',
                           'Добрый день! Благодарим за интерес к Parisa Home. Наберу вас в течение часа — обсудим объёмы и сроки.',
                           '{first}, добрый день! Меня зовут {agent}, я буду вести ваш запрос. Перезвоню в ближайший час, чтобы уточнить детали.',
                           'Здравствуйте, {first}! Спасибо, что обратились. Такие изделия шьём постоянно — скоро позвоню и всё расскажу.')
                acts.append(('@start', ('burst', [item('in', req, subj=f'Запрос коммерческого предложения — {who}'),
                                                  item('out', reply)])))
                acts.append(('@next', ('call', 'out', r.randint(150, 420)), 12, 55))
                acts.append(('@next', ('note', agent, note, 'tz' if repeat else None), 3, 25))
                if waits:
                    acts.append(('burst', [item('in', self.fmt(d, d['main'], r.choice(WAIT_QUESTION['first'])))]))
                acts.append(topic)
            else:
                if repeat:
                    sent = mg('{first}, рад((|а)) снова работать с вами! Как договорились: {price_hint}, условия как в прошлый раз.',
                              '{first}, спасибо, что снова к нам! По повторному заказу: {price_hint}. Цвет и логотип — как в прошлой партии.')
                else:
                    sent = mg('{first}, добрый день! Спасибо за разговор. Как договорились, цены: {price_hint}.',
                              '{first}, ещё раз здравствуйте! Как обещал((|а)): {price_hint}, при объёме {qty} — скидка.',
                              'По нашему разговору, {first}: {price_hint}. Цены действуют до конца месяца.',
                              '{first}, высылаю, как договорились: {price_hint}. Под {qty} посчитаю отдельно, когда пришлёте ТЗ.',
                              '{first}, это {agent} из Parisa Home — пишу, как обещал((|а)). Цены: {price_hint}. Изготовление — 2–3 недели.',
                              '{first}, рад((|а)) знакомству! Ориентир по ценам: {price_hint}. Пришлите плотность, цвет и размеры — сделаю точный расчёт.')
                items = [item('out', sent)]
                if waits:
                    items.append(item('in', self.fmt(d, d['main'], r.choice(WAIT_QUESTION['first']))))
                else:
                    got, ack = pair([('Спасибо, посмотрю и вернусь с вопросами.', 'Хорошо, {first}, жду. Если будут вопросы — пишите.'),
                                     ('Получил((|а)), спасибо. Обсужу с руководством и отпишусь.', 'Договорились! На связи.'),
                                     ('Хорошо, изучим. Завтра скажу по объёму.', 'Отлично, буду ждать, {first}.'),
                                     ('Спасибо! А образцы можно посмотреть?', 'Конечно, отправим образцы {v_city}, как только определимся с размерами.'),
                                     ('Цены понятны. ТЗ на {prod} пришлю до конца недели.', 'Отлично, {first}! Жду ТЗ.'),
                                     ('А на {qty} какая будет скидка?', 'Зависит от плотности и логотипа — как пришлёте ТЗ, посчитаю со скидкой.'),
                                     ('Принято. Сколько по времени шьёте партию на {qty}?', 'Обычно 14–18 рабочих дней, точнее скажу после ТЗ.'),
                                     ('Спасибо, {agent}. Покажу директору, вернёмся с ТЗ.', 'Хорошо, на связи. Если понадобятся образцы — отправлю.')])
                    items += [item('in', got), item('out', ack)]
                acts.append(('call', 'out', r.randint(120, 360)))
                acts.append(('@next', ('note', agent, note, 'tz' if repeat else None), 2, 20))
                acts.append(('@next', ('burst', items), 5, 45))
                acts.append(topic)

        elif s == 'needs':
            tz = cl('Нужны {prod}, всего {qty}. Плотность {gsm}, цвет — {color}, {logo}.',
                    'По ТЗ: {lines}. Плотность {gsm}, цвет — {color}, {logo}.',
                    'Отправляю потребность: {lines}. Цвет — {color}, плотность — {gsm}, {logo}.',
                    'Определились: {lines}. Цвет — {color}, {logo}, плотность {gsm}.',
                    'Наше ТЗ: {lines}; плотность {gsm}; цвет — {color}; {logo}.')
            ask = mg('Принято: {qty}. Какой срок поставки нужен и куда доставляем?',
                     'Спасибо, {first}! Подскажите срок поставки и адрес доставки.',
                     'Записал((|а)). К какой дате нужен товар и куда везём?',
                     'Отлично, {qty} — записал((|а)). К какому числу нужна поставка и на какой склад?',
                     '{first}, понял((|а)): {color}, {gsm}. Какие сроки и куда доставить?',
                     'Спасибо за ТЗ, {first}! Уточните, пожалуйста, желаемую дату поставки и город доставки.')
            when = cl('До {deadline}, доставка {v_city}.',
                      'Нужно успеть до {deadline}. Везти {v_city}, на наш склад.',
                      'Крайний срок — {deadline}, доставка {do_city}.',
                      'Хотим получить к {deadline_h}. Склад {in_city}.',
                      'Желательно до {deadline_h}, доставка {v_city}, адрес склада пришлю.')
            if d.get('reason') == 'Сроки поставки':
                ok = mg('Срок плотный: шьём 14–18 рабочих дней. Посчитаю и уточню у производства, что можно сделать.',
                        '{first}, к {deadline_h} будет непросто: производство — 14–18 рабочих дней. Посчитаю и вернусь с ответом.')
            else:
                ok = mg('Отлично, до {deadline} успеваем. Подготовлю КП и пришлю.',
                        'Принято: {prod} к {deadline}. Посчитаю с доставкой {v_city}.',
                        'Хорошо, {first}. Расчёт с доставкой пришлю завтра до обеда.',
                        'Успеваем, {first}: производство 14–18 рабочих дней плюс дорога. КП пришлю в течение дня.',
                        'Записал((|а)): к {deadline_h}, {v_city}. Готовлю коммерческое предложение.')
            acts.append(('burst', [item('in', tz), item('out', ask), item('in', when), item('out', ok)]))
            acts.append(('@next', ('note', agent, mg('Потребность: {lines}; {gsm}; цвет — {color}; {logo}. Срок — до {deadline}, доставка {v_city}.',
                                                     'ТЗ клиента: {lines}. Плотность {gsm}, цвет — {color}, {logo}. Поставка до {deadline} {v_city}.',
                                                     'Зафиксировал((|а)) ТЗ: {lines}, {gsm}, {color}, {logo}. Срок — {deadline}, город доставки — {city}.'),
                                    'tz'), 5, 60))
            call = r.random() < 0.75
            kp_done = done('Отправить КП', 'Подготовить и отправить КП',
                           ['КП отправлено клиенту', 'КП отправлено, клиент изучает', 'Отправил((|а)) КП № {kp_no}'])
            if lost_next:
                acts.append(('burst', [item('in', cl('Ремонт номерного фонда перенесли на весну, сейчас закупку не планируем. Вернёмся к разговору позже.',
                                                     'Руководство решило отложить обновление номеров до весны. Пока закупку снимаем, извините.')),
                                       item('out', mg('Понял((|а)), {first}. Напишу вам в феврале — к весне подготовим новые цены.',
                                                      'Жаль, но понимаю. {first}, весной напомню о себе — сохраню ваше ТЗ.'))]))
                acts.append(('@end', ('task', 'Отправить КП', 'Подготовить и отправить КП', 'Не потребовалось: клиент отложил закупку')))
            else:
                if call:
                    acts.append(('call', 'out', r.randint(180, 540)))
                if not current and nxt == 'kp':
                    acts.append(('@end', self.kp_act(d)))
                acts.append(kp_done)

        elif s == 'kp':
            kp_subject = self.kp_subject(d)
            if 'needs' not in path:
                acts.append(('@soon', self.kp_act(d)))
            got, ack = pair([('Спасибо, получили. Изучим и вернёмся с ответом до конца недели.',
                              'Хорошо, {first}. Если появятся вопросы по КП — пишите.'),
                             ('КП получил((|а)). Цены в целом подходят, обсудим внутри и вернусь.',
                              'Отлично! Жду решения, при необходимости подготовлю договор.'),
                             ('Спасибо! А если возьмём {more} шт, цена будет ниже?',
                              'Да, от {more} шт дадим дополнительную скидку — уточню размер у руководителя.'),
                             ('Итого {total} — немного выше, чем мы планировали. Обсудим и вернёмся.',
                              'Понимаю, {first}. Если объём вырастет, сможем пересмотреть цену.'),
                             ('Спасибо за быстрый расчёт! Можно ли оплату разбить на три части?',
                              'Обычно работаем 50/50, но обсудим — предложу вариант после согласования с руководителем.'),
                             ('КП получили, передали директору. Решение будет на следующей неделе.',
                              'Хорошо, {first}, спасибо. Напомню о себе в начале недели.')]
                            + ([('Цена на {first_item} устраивает, по остальным позициям думаем.',
                                 'Понял((|а)), {first}. Если нужно, подберу варианты подешевле.')] if multi else []))
            result = r.choice({'samples': ['Клиент сравнивает с другим поставщиком, просит образцы',
                                           'Клиент хочет посмотреть образцы перед заказом', 'Попросили образцы: {sample}'],
                               'agree': ['Цены устраивают, клиент готов обсуждать договор',
                                         'Договорились: готовим договор', 'КП принято, переходим к договору']}.get(nxt, ['Клиент изучает КП']))
            if waits:
                acts.append(('burst', [item('in', self.fmt(d, d['main'], r.choice(WAIT_QUESTION['kp'])),
                                            subj='Re: ' + kp_subject, mail=True)]))
                acts.append(('task', 'Связаться', 'Ответить на вопросы по КП (отсрочка, доставка)', None))
            elif lost_next:
                acts.append(('burst', [item('in', cl('Спасибо за предложение, но мы нашли поставщика дешевле. Будем рады сотрудничать в будущем.',
                                                     'Добрый день! Сравнили предложения: у турецкого поставщика цена ниже, работаем с ними. Спасибо за расчёт.'),
                                            subj='Re: ' + kp_subject, mail=True),
                                       item('out', mg('Жаль, {first}. Если условия поставщика изменятся — мы готовы вернуться к разговору.',
                                                      'Понимаю. Если будет нужна быстрая поставка из Узбекистана — пишите, {first}.'),
                                            mail=True)]))
                acts.append(('@end', ('task', 'Звонок', 'Перезвонить по КП', 'Клиент выбрал поставщика из Турции, цена ниже на 12%')))
            else:
                acts.append(('burst', [item('in', got, subj='Re: ' + kp_subject, mail=True), item('out', ack, mail=True)]))
                acts.append(('call', 'out', r.randint(120, 300)))
                if current:
                    acts.append(('task', 'Звонок', 'Перезвонить по КП', None))
                else:
                    acts.append(('@end', ('task', 'Звонок', 'Перезвонить по КП', self.fmt(d, agent, result))))

        elif s == 'samples':
            acts.append(('@next', ('task', 'Отправить образцы', self.fmt(d, agent, 'Отправить образцы: {sample}'),
                                   self.fmt(d, agent, r.choice(['Образцы переданы курьеру, накладная № {waybill}',
                                                                'Отправили курьером, накладная № {waybill}']))), 25, 110))
            acts.append(('@next', ('burst', [item('out', mg('Образцы ({sample}) отправили курьером, будут у вас через 2–3 дня.',
                                                            '{first}, образцы ({sample}) передали в доставку, накладная № {waybill}.',
                                                            'Отправил((|а)) образцы: {sample}. Как получите — дайте знать.',
                                                            '{first}, добрый день! Курьер везёт вам образцы {v_city}: {sample}. Накладная № {waybill}.',
                                                            'Образцы в пути, накладная № {waybill}. Плотность {gsm} — как в КП.'))]), 2, 15))
            if lost_next:
                acts.append(('burst', [item('in', cl('Образцы посмотрели — плотность вафельного полотна ниже, чем нам нужно. Пока не готовы заказывать.')),
                                       item('out', mg('Понял((|а)), спасибо за обратную связь. Можем предложить полотно 280 г/м² — пришлю образец.'))]))
                acts.append(('@end', ('task', 'Звонок', 'Узнать оценку образцов', 'Образцы не подошли по плотности')))
            elif waits:
                acts.append(('burst', [item('in', self.fmt(d, d['main'], r.choice(WAIT_QUESTION['samples'])))]))
                acts.append(('task', 'Звонок', 'Узнать оценку образцов', None))
            elif current:
                got, ack = pair([('Образцы получили, передали на проверку в отдел качества.', 'Спасибо! Жду обратную связь.'),
                                 ('Получили, спасибо. Покажем директору и дадим ответ.',
                                  'Хорошо, {first}. Если нужно, пришлём ещё образец другого цвета.'),
                                 ('Образцы у нас, {agent}. Тестируем стирку, к концу недели скажем.', 'Отлично, жду ваших результатов.'),
                                 ('Курьер привёз, спасибо. Смотрим.', 'Хорошо, {first}! Если будут вопросы по образцам — звоните.')])
                acts.append(('burst', [item('in', got), item('out', ack)]))
                acts.append(('task', 'Звонок', 'Узнать оценку образцов', None))
            else:
                if white:
                    fb, ans = pair([('Образцы получили. Плотность и мягкость устраивают, белый ровный — берём.', 'Отлично! Готовлю договор.'),
                                    ('Посмотрели образцы: {gsm} — то, что нужно. Готовы обсуждать договор.',
                                     'Спасибо, {first}! Сегодня пришлю проект договора.'),
                                    ('Образцы понравились, после стирки не садятся. Давайте договор.',
                                     'Рад((|а)), что подошли! Договор пришлю сегодня.')])
                else:
                    fb, ans = pair([('Образцы получили. Плотность и мягкость устраивают, по цвету — нужен оттенок чуть светлее.',
                                     'Отлично! Оттенок подберём по вашему образцу ткани.'),
                                    ('Качество хорошее. Цвет ({color}) чуть темнее, чем в каталоге, — можно подобрать по нашему образцу?',
                                     'Да, пришлите образец цвета — подберём краситель в партии.'),
                                    ('Посмотрели {sample}: всё устраивает, цвет совпал. Готовы к договору.',
                                     'Спасибо, {first}! Готовлю договор.')])
                acts.append(('burst', [item('in', fb), item('out', ans)]))
                acts.append(('@next', ('note', agent, mg('Клиент одобрил образцы, переходим к согласованию цены и договора.',
                                                         'Образцы одобрены, следующий шаг — договор.',
                                                         'Образцы ({sample}) клиенту подошли. Готовлю договор.')), 5, 50))
                acts.append(('@end', ('task', 'Звонок', 'Узнать оценку образцов',
                                      self.fmt(d, agent, r.choice(['Образцы одобрены, готовим договор', 'Клиенту всё подошло',
                                                                   'Образцы приняты, по цвету договорились'])))))

        elif s == 'agree':
            discounts = [l['disc'] for l in d['lines'] if l['disc']]
            disc = max(discounts) if discounts else 0
            c['disc'], c['disc_ask'] = f'{disc}%', f'{disc + 3}%'
            contract = ('mail_or_msg', 'out', f"Договор поставки № {c['contract']} — проект",
                        f"<p>Добрый день, {c['first']}!</p><p>Направляем проект договора поставки № {c['contract']}: "
                        f"спецификация, срок поставки — до {c['deadline']}, оплата 50/50. Просим проверить реквизиты и подтвердить.</p>"
                        f"<p>С уважением,<br>{c['agent_full']}<br>Parisa Home</p>",
                        f"Проект договора № {c['contract']} готов: спецификация, срок поставки — до {c['deadline']}, оплата 50/50. "
                        f"Подпишем при встрече или через курьера?")
            if lost_next:     # the client needs the goods sooner than they can be made
                acts.append(('burst', [item('in', cl('{agent}, образцы устраивают. Но товар нужен к {deadline_h}, иначе не успеваем к сезону. Сможете?',
                                                     'Добрый день! Готовы заказывать, но только если получим всё к {deadline_h}. Успеете?')),
                                       item('out', mg('{first}, быстрее 14 рабочих дней не сошьём: к {deadline_h} никак не успеть. Можем отгрузить частями — первую партию через две недели.',
                                                      'К {deadline_h}, к сожалению, не успеем: производство — минимум 14 рабочих дней. Могу предложить отгрузку двумя партиями.'))]))
                acts.append(('burst', [item('in', cl('Частями нам не подходит, нужна вся партия сразу. К сожалению, в этот раз отказываемся.',
                                                     'Двумя партиями не получится. Жаль, но в этот раз закажем у другого поставщика.')),
                                       item('out', mg('Понимаю, {first}. Жаль, что не совпали по срокам — будем рады поработать в следующий раз.',
                                                      'Очень жаль, {first}. В следующий раз начнём заранее — напишите, как будет новая закупка.'))]))
                acts.append(('@end', ('task', 'Подготовить договор', 'Подготовить договор поставки',
                                      'Клиент отказался: не устроил срок производства')))
            else:
                if disc:
                    ask = cl('Готовы разместить заказ, если сделаете скидку {disc_ask}. Объём серьёзный.',
                             'Цены нас устраивают, но при объёме {qty} просим скидку {disc_ask}.',
                             'Договор готовы подписать. Какая скидка будет на {qty}? Рассчитываем на {disc_ask}.',
                             '{agent}, по образцам всё устраивает. Если дадите {disc_ask}, подпишем на этой неделе.')
                    acts.append(('burst', [item('in', ask),
                                           item('out', mg('Принято, {first}. Согласую с руководителем и вернусь сегодня.',
                                                          'Понял((|а)) вас. Уточню у руководителя, что можем сделать, и напишу.',
                                                          '{first}, {disc_ask} — много, но попробую согласовать. Вернусь с ответом сегодня-завтра.',
                                                          'Хорошо, {first}, вынесу вопрос на руководителя. Думаю, договоримся.'))]))
                    head = self.staff['head']
                    acts.append(('@next', ('internal', head, agent,
                                           self.fmt(d, head, r.choice(['{agent}, согласовываю скидку {disc} при этом объёме. Больше не даём.',
                                                                       '{agent}, даём {disc} — объём хороший, дальше не двигаемся.',
                                                                       '{agent}, ок на {disc}. Предоплата 50% — обязательно.']))), 20, 180))
                    acts.append(('@next', ('discount',), 5, 60))
                    acts.append(('@next', ('burst', [item('out', mg('Согласовали скидку {disc}. Итоговая сумма — {final_total}. Направляю проект договора.',
                                                                    '{first}, руководитель одобрил {disc}. Итого {final_total}, проект договора отправлю сегодня.',
                                                                    '{first}, по скидке: {disc} — максимум, что можем. С ней сумма — {final_total}. Договор пришлю в течение часа.',
                                                                    'Хорошие новости: скидка {disc}, итог — {final_total}. Готовлю договор.'))]), 1, 15))
                else:
                    if c['export']:
                        answers = ('По этой позиции цена уже минимальная, но можем взять доставку {v_city} на себя. Направляю проект договора.',
                                   '{first}, цена и так на минимуме, зато доставку {v_city} сделаем за наш счёт. Готовлю договор.',
                                   'Скидку дать не можем — цена для такого объёма уже специальная. Договор пришлю сегодня.')
                    else:
                        answers = ('Цена уже минимальная, а доставка {v_city} и так за наш счёт. Направляю проект договора.',
                                   '{first}, по цене двигаться некуда, зато сошьём бирки с вашим названием бесплатно. Готовлю договор.',
                                   'Скидку дать не можем — цена для такого объёма уже специальная. Договор пришлю сегодня.')
                    acts.append(('burst', [item('in', cl('Готовы разместить заказ, если сделаете скидку. Объём серьёзный.',
                                                         'Цены нас устраивают. Можно ли ещё немного уступить?',
                                                         'Давайте двигаться к договору. Скидку на {qty} дадите?',
                                                         'Всё устраивает. Есть ли бонус за быструю оплату?')),
                                           item('out', mg(*answers))]))
                acts.append(('@next', contract, 5, 45))
                if current:
                    got, ack = pair([('Договор у юриста, ответим в ближайшие дни.', 'Хорошо, ждём. Если будут правки — внесём оперативно.'),
                                     ('Получили договор, проверяем реквизиты. Вернёмся завтра-послезавтра.', 'Договорились, {first}. Жду.'),
                                     ('Спасибо, {agent}. Директор в отъезде, подпишет, как вернётся.', 'Хорошо, {first}, ждём. Договор № {contract} в силе.'),
                                     ('Есть пара правок по пункту об оплате — пришлём сегодня.', 'Конечно, присылайте, согласуем.')])
                    acts.append(('burst', [item('in', got), item('out', ack)]))
                    acts.append(('task', 'Подготовить договор', 'Согласовать договор с юристом клиента', None))
                else:
                    got, ack = pair([('Договор подписали, скан отправили на почту.', 'Спасибо! Сегодня выставлю счёт на предоплату.'),
                                     ('Подписали, оригинал передадим с курьером.', 'Отлично, {first}! Счёт на предоплату пришлю сегодня.'),
                                     ('Договор № {contract} подписан с нашей стороны, скан у вас на почте.', 'Получил((|а)), спасибо! Счёт выставлю в течение часа.'),
                                     ('Всё согласовали, директор подписал договор № {contract}.', 'Спасибо, {first}! Следующий шаг — счёт на предоплату.'),
                                     ('Подписали без правок. Ждём счёт.', 'Спасибо! Счёт на {half} пришлю сегодня.')])
                    acts.append(('burst', [item('in', got), item('out', ack)]))
                    acts.append(('@end', ('task', 'Подготовить договор', 'Подготовить договор поставки',
                                          self.fmt(d, agent, r.choice(['Договор подписан обеими сторонами', 'Договор подписан, оригинал получен',
                                                                       'Договор № {contract} подписан'])))))

        elif s == 'prepay':
            acts.append(('@soon', ('note', agent, mg('Выставлен счёт № {invoice} на предоплату 50% — {half}.',
                                                     'Счёт № {invoice} (предоплата 50%, {half}) отправлен клиенту.',
                                                     'Счёт на предоплату № {invoice}: {half}, по договору № {contract}.'))))
            acts.append(('@next', ('burst', [item('out', mg('Счёт № {invoice} на предоплату отправил((|а)). Как только оплата поступит, запускаем производство.',
                                                            '{first}, счёт № {invoice} на {half} у вас на почте. После оплаты сразу ставим в производство.',
                                                            '{first}, выставил((|а)) счёт на предоплату 50% — {half}. Реквизиты — в договоре № {contract}.',
                                                            'Направил((|а)) счёт № {invoice}: предоплата — {half}, после неё запускаем заказ в работу.'))]), 3, 25))
            if current:
                acts.append(('burst', [item('in', cl('Получили, оплату проведём на этой неделе.', 'Спасибо, передал((|а)) в бухгалтерию.',
                                                     'Счёт получили. Оплата — в течение трёх банковских дней.',
                                                     'Принято, {agent}. Бухгалтерия оплатит до пятницы.')),
                                       item('out', mg('Спасибо, {first}! Как поступит — сообщу.', 'Хорошо, жду. Спасибо!',
                                                      'Отлично, {first}. Место в производстве за вами держим.'))]))
                acts.append(('task', 'Контроль оплаты', 'Проконтролировать поступление предоплаты 50%', None))
            else:
                got, ack = pair([('Оплату провели сегодня, платёжное поручение отправили на почту.',
                                  'Спасибо! Как только деньги поступят, запускаем в производство.'),
                                 ('Предоплату перевели, проверьте, пожалуйста.', 'Спасибо, {first}! Проверю поступление и напишу.'),
                                 ('{half} отправили, платёжка у бухгалтера.', 'Отлично, спасибо! Ставлю заказ в план производства.'),
                                 ('Добрый день! Предоплата по счёту № {invoice} ушла утром.', 'Спасибо, {first}! Как увижу поступление — сразу в работу.'),
                                 ('Оплатили 50%. Когда запускаете?', 'Спасибо! Запускаем на следующий день после поступления денег.')])
                acts.append(('burst', [item('in', got), item('out', ack)]))
                acts.append(('@end', ('task', 'Контроль оплаты', 'Проконтролировать поступление предоплаты 50%',
                                      r.choice(['Предоплата 50% поступила', 'Предоплата получена, заказ передан в производство',
                                                'Деньги на счёте, запускаем производство']))))

        elif s == 'prod':
            acts.append(('@soon', ('note', agent, mg('Заказ запущен в производство. Плановая готовность — {ready}.',
                                                     'Передали в цех. Готовность партии — {ready}.',
                                                     'В производстве: {lines}. Готовность — {ready}.'))))
            items = [item('out', mg('{first}, ваш заказ в производстве, готовность — {ready}. Пришлю фото готовой партии.',
                                    '{first}, запустили ваш заказ, к {ready} партия будет готова.',
                                    'Добрый день! Ваш заказ уже в работе, плановая готовность — {ready_h}.',
                                    '{first}, заказ в цеху. Как будет готов — сообщу и согласуем отгрузку.'))]
            reply = r.random() < 0.6
            got, ack = pair([('Отлично, ждём.', 'Договорились, буду держать в курсе.'),
                             ('Спасибо! Фото пришлите, пожалуйста, до отгрузки.', 'Обязательно пришлю.'),
                             ('Хорошо. Коробки промаркируете по нашему шаблону?', 'Да, пришлите шаблон — промаркируем.'),
                             ('Принято, спасибо, {agent}!', 'Хорошего дня, {first}!')])
            if waits:
                items.append(item('in', self.fmt(d, d['main'], r.choice(WAIT_QUESTION['prod']))))
            elif reply:
                items += [item('in', got), item('out', ack)]
            acts.append(('@next', ('burst', items), 10, 120))
            if current:
                if not waits:
                    acts.append(('task', 'Связаться', 'Сообщить клиенту о готовности партии', None))
                else:
                    acts.append(('task', 'Связаться', 'Ответить клиенту: дозаказ к партии', None))
            else:
                acts.append(('@end', ('burst', [item('out', mg('{first}, партия готова! Отгружаем {pallets}, доставка {v_city} — {transit}.',
                                                               '{first}, заказ готов и упакован. Отгружаем сегодня, номер ТТН пришлю.',
                                                               '{first}, всё готово: {qty}. Отгружаем сегодня.'))])))
                acts.append(('@end', ('task', 'Связаться', 'Сообщить клиенту о готовности партии',
                                      r.choice(['Партия готова, согласовали дату отгрузки', 'Готово, клиент подтвердил отгрузку',
                                                'Клиенту сообщили, отгрузка согласована']))))

        elif s == 'ship':
            acts.append(('@soon', ('note', agent, mg('Отгрузка: {pallets}, ТТН № {ttn}. Доставка {v_city} — {transit}.',
                                                     'Отгрузили {pallets}, ТТН № {ttn}. В пути — {transit}.',
                                                     'Груз ушёл {v_city}: {pallets}, ТТН № {ttn}.'))))
            items = [item('out', mg('Груз отправлен, номер ТТН — {ttn}. Ориентировочная доставка — через {transit}.',
                                    '{first}, отгрузили: ТТН № {ttn}, {v_city} груз придёт через {transit}.',
                                    '{first}, добрый день! Ваш заказ в пути: {pallets}, ТТН № {ttn}.',
                                    'Отгрузка состоялась. ТТН № {ttn}, ждём доставку {v_city} через {transit}.'))]
            reply = r.random() < 0.7
            got, ack = pair([('Спасибо, ждём.', 'Хорошего дня! Если что — на связи.'),
                             ('Отлично, склад предупредил((|а)).', 'Спасибо! Сообщите, пожалуйста, когда примете.'),
                             ('Принято. Водитель позвонит заранее?', 'Да, водитель наберёт за час до приезда.')])
            if reply:
                items += [item('in', got), item('out', ack)]
            acts.append(('@next', ('burst', items), 5, 60))
            if current:
                acts.append(('task', 'Контроль оплаты', 'Получить окончательную оплату 50%', None))
            else:
                arrival = dt.datetime.combine(a.date() + dt.timedelta(days=c['transit_days']), dt.time(10, 0))
                arrival = max(a + dt.timedelta(hours=2), min(arrival, b - dt.timedelta(hours=3)))
                acts.append(('@at', ('call', 'in', r.randint(60, 180)), arrival))
                got, ack = pair([('Всё получили, качество отличное. Спасибо! Остаток оплатили.', 'Спасибо за заказ! Будем рады следующему.'),
                                 ('Товар приняли, всё по количеству. Вторую часть оплаты провели.', 'Спасибо, {first}! Рады работать с вами.'),
                                 ('Груз приняли, {qty} — всё сходится. Остаток {half} оплатили сегодня.', 'Спасибо! Как деньги поступят — закроем сделку.'),
                                 ('Получили, спасибо! Упаковка целая. Доплату отправили.', 'Отлично, {first}! Спасибо за доверие.'),
                                 ('{agent}, всё пришло, разгрузили. Оплату остатка провели.', 'Спасибо! До следующего заказа.')])
                acts.append(('@next', ('burst', [item('in', got), item('out', ack)]), 10, 240))
                acts.append(('@end', ('task', 'Контроль оплаты', 'Получить окончательную оплату 50%',
                                      r.choice(['Оплата поступила полностью', 'Окончательный расчёт получен', 'Остаток 50% поступил']))))

        elif s == 'won':
            months = plural(r.randint(2, 3), 'месяц', 'месяца', 'месяцев')
            acts.append(('@soon', ('note', agent, mg(f'Сделка закрыта. Клиент планирует повторный заказ через {months}.',
                                                     f'Заказ выполнен и оплачен. Следующую закупку клиент планирует через {months}.',
                                                     f'Оплачено полностью, клиент доволен. Напомнить о себе через {months}.'))))
        elif s == 'lost':
            text = d['reason'] + (f" — {d['comment']}" if d.get('comment') else '')
            acts.append(('@soon', ('lost_reason', text)))

        self.place(d, acts, a, b, current)

    # ---------------------------------------------------------------- putting the acts on the time line
    def do_act(self, d, x, t, limit, start=False):
        """One timed act (not a task) at t; returns when it ended (a burst takes some minutes)."""
        agent = d['agent']
        main = d['main']
        kind = x[0]
        if kind == 'burst':
            return self.burst(d, x[1], t, limit, start)
        if kind == 'mail_or_msg':
            _, direction, subject, html, text = x
            # offers and contracts go by e-mail whenever the client has an address
            if main['email'] and d.get('mail', True):
                self.mail(d, direction, subject, html, text, t)
            else:
                self.message(d, direction, text, t)
        elif kind == 'call':
            self.call(d, x[1], x[2], t)
        elif kind == 'note':
            self.event(E_COMMENT, t, deal=d, by=x[1], after={'data': {'comment': x[2], 'files': []}})
            if len(x) > 3 and x[3] == 'tz':
                d['tz_at'] = sec(t)      # the manager filled the deal's fields from the client's request
        elif kind == 'internal':
            self.event(E_CHAT, t, deal=d, by=x[1], to=x[2], after={'data': {'message': x[3], 'files': []}})
        elif kind == 'discount':
            self.discount_events(d, t)
            return t + dt.timedelta(seconds=1)
        elif kind == 'lost_reason':
            # PATCH /deals/:id/lost right after the move: «Причина проигрыша» in the history
            self.event(E_FIELD, t, deal=d, by=agent, field_of='deal', after={'data': {'field': 'lost_reason', 'new_value': x[1]}})
        else:
            raise SystemExit(f'internal error: unknown act {kind}')
        return t

    def into_work(self, t, limit):
        """t, or the next working morning when t falls in the evening or night (19:00-09:00) or on a Sunday and that
        is before limit."""
        minutes = self.trng.uniform(5, 50)          # drawn every time: the number of draws never depends on t
        if t.weekday() != 6 and dt.time(9, 0) <= t.time() <= dt.time(19, 0):
            return t
        day = t.date() if t.time() < dt.time(9, 0) else t.date() + dt.timedelta(days=1)
        if day.weekday() == 6:
            day += dt.timedelta(days=1)
        morning = dt.datetime.combine(day, dt.time(9, 0)) + dt.timedelta(minutes=minutes)
        return morning if morning < limit else t

    def place(self, d, acts, a, b, current):
        """
        The acts of a stage on its time line, in their order: the head ('@start' right at a, '@soon' a few
        minutes after the act before), the body (plain acts spread over the stage in working hours, '@next' acts
        so many minutes after the act before), the tail ('@end': just before b, a few minutes apart). A task with
        a result is set up early in the stage and closed at its place in the order (after the work it reports);
        the open task of the current stage is set up after the last act.
        """
        agent = d['agent']
        trng = self.trng
        seq = []
        for x in acts:
            if x[0] in ('@start', '@soon', '@end'):
                seq.append((x[0], x[1], None))
            elif x[0] == '@next':
                seq.append(('@next', x[1], (x[2], x[3])))
            elif x[0] == '@at':
                seq.append(('@at', x[1], x[2]))
            else:
                seq.append(('', x, None))
        waiting = [x for _, x, _ in seq if x[0] == 'task' and x[3] is None]
        seq = [y for y in seq if not (y[1][0] == 'task' and y[1][3] is None)]
        n_head = 0
        while n_head < len(seq) and seq[n_head][0] in ('@start', '@soon'):
            n_head += 1
        n_tail = 0
        while n_tail < len(seq) - n_head and seq[len(seq) - 1 - n_tail][0] == '@end':
            n_tail += 1
        head, body, tail = seq[:n_head], seq[n_head:len(seq) - n_tail], seq[len(seq) - n_tail:]
        one = dt.timedelta(seconds=1)
        state = {'last': a}

        def slot(t, limit):
            """t, strictly after the act before and before limit (squeezed when the stage is short)."""
            last = state['last']
            if t <= last:
                t = last + one
            if t >= limit:
                t = last + (limit - last) / 2 if limit - last > 4 * one else last + one
            return max(sec(t), last + one)

        def run(x, t, limit, start=False):
            if x[0] == 'task':
                self.done_task(d, x, a, t)
                state['last'] = t
            else:
                state['last'] = self.do_act(d, x, t, limit, start)

        # the head
        for marker, x, _ in head:
            if marker == '@start':
                t = state['last'] + (2 * one if state['last'] == a else one)
            else:
                t = state['last'] + dt.timedelta(minutes=trng.uniform(3, 15))
            run(x, slot(t, b), b, start=(marker == '@start'))
        # room for the tail
        gaps = [dt.timedelta(minutes=trng.uniform(4, 25)) for _ in tail]
        tail_start = b - sum(gaps, dt.timedelta())
        if tail and tail_start <= state['last'] + dt.timedelta(minutes=5 * (len(body) + 1)):
            room = (b - state['last']) * 0.35
            gaps = [room / (len(tail) + 1)] * len(tail)
            tail_start = b - room
        limit = tail_start if tail else b
        # the body: a plain act at a random moment of what is left of the stage (shared with the plain acts after it)
        plain_left = sum(1 for m, _, _ in body if m in ('', '@at'))
        for k, (marker, x, w) in enumerate(body):
            if marker == '@next':
                t = self.into_work(state['last'] + dt.timedelta(minutes=trng.uniform(*w)), limit)
            else:
                gap = dt.timedelta(minutes=trng.uniform(3, 9))
                t = state['last'] + gap
                if limit - state['last'] > dt.timedelta(minutes=2):
                    t = max(t, self.spread(state['last'], limit, plain_left)[0])
                if marker == '@at':          # not before this moment (the goods arrived)
                    t = max(t, w)
                plain_left -= 1
            run(x, slot(t, limit), limit)
        # the tail: what moved the deal on, just before b
        t = max(tail_start, state['last'])
        for (marker, x, _), g in zip(tail, gaps):
            run(x, slot(t, b), b)
            t = state['last'] + g
        # the open task: the next step, set up after the last act
        if current and waiting and d['path'][-1] not in ('won', 'lost'):
            _, typ, label, _ = waiting[-1][:4]
            created = min(b, max(a + dt.timedelta(minutes=10), state['last'] + dt.timedelta(minutes=5)))
            due, all_day = self.due_of(DUE.get(d['key'], 'future'), created, d['crng'].random())
            self.task(label=label, typ=typ, agent=agent, creator=agent, deal=d, created=created, due=due,
                      closed=None, result=None, all_day=all_day)

    def done_task(self, d, x, a, closed):
        """A task of a stage, set up early in it and closed at `closed`: most on time (due later that day or the next
        days), about one in seven after its due time (a working moment between its start and its end)."""
        _, typ, label, result = x[:4]
        agent = d['agent']
        trng = self.trng
        span = closed - a
        made, on_time, ahead, late = trng.uniform(4, 40), trng.random(), trng.uniform(1, 30), trng.uniform(0.3, 0.8)
        created = a + min(span * 0.5, dt.timedelta(minutes=made))
        if created >= closed:
            created = closed - dt.timedelta(seconds=1)
        due = self.into_work(closed + dt.timedelta(hours=ahead), closed + dt.timedelta(days=3))
        if on_time >= 0.85 and closed - created > dt.timedelta(hours=2):      # done late: the due time had passed
            due = self.spread(created + (closed - created) * late * 0.5, closed - dt.timedelta(minutes=30), 1)[0]
        creator = agent if self.rng.random() < 0.8 else self.staff['head']
        self.task(label=label, typ=typ, agent=agent, creator=creator, deal=d, created=created, due=due,
                  closed=closed, result=result)

    def due_of(self, state, created, pick):
        """
        The due time of an open task: overdue, today or later. pick (a draw of the content's generator, 0..1)
        decides whether a task of today is for the whole day, so the time of the run never changes the data.
        """
        rng = self.trng
        today = self.today
        if state == 'overdue':
            day = self.workday(today - dt.timedelta(days=rng.randint(1, 4)))
            due = dt.datetime.combine(day, dt.time(rng.choice([10, 11, 12, 15, 16]), rng.choice([0, 30])))
            if due <= created:
                due = created + dt.timedelta(hours=2)
            if due >= self.now:          # set up too recently to be late: due in an hour (still not for the whole day)
                due = self.now + dt.timedelta(hours=1)
            return due, False
        if state == 'today':
            if pick < 0.35:
                return dt.datetime.combine(today, dt.time(0, 0)), True
            due = dt.datetime.combine(today, dt.time(rng.choice([11, 14, 15, 16, 17]), rng.choice([0, 30])))
            if due <= self.now:
                # later today (at the very end of the day: its last minute)
                due = min(dt.datetime.combine(today, dt.time(23, 59)), self.now + dt.timedelta(hours=1))
                due = max(due, self.now + dt.timedelta(seconds=30))
            return due, False
        day = self.workday(today + dt.timedelta(days=rng.randint(1, 9)))
        if day <= today:
            day = today + dt.timedelta(days=1)
        return dt.datetime.combine(day, dt.time(rng.choice([10, 11, 14, 15, 16]), rng.choice([0, 30]))), False

    # ---------------------------------------------------------------- the pace of a conversation
    def reply_at(self, d, t):
        """
        When the manager answers a client's message written at t, and whether it is a late answer. The manager's
        pace (PACE) decides: within the norm, within an hour or late, counted in working time like «Контроль
        ответов» does; a message of the evening may also be answered at once from the phone. Always the same
        number of draws: the content of the run does not depend on the time of day.
        """
        fast, medium = PACE[d['agent']['key']]
        u, v = self.pace(d['agent']['key']), d['crng'].random()
        m_fast, m_med, m_slow = self.trng.uniform(1.5, 12.5), self.trng.uniform(17, 55), self.trng.uniform(75, 260)
        m_now = self.trng.uniform(3, 25)
        bucket = 'fast' if u < fast else 'medium' if u < fast + medium else 'slow'
        if bucket == 'fast' and not working(t) and v < 0.4:
            return t + dt.timedelta(minutes=m_now), False
        return add_work(t, {'fast': m_fast, 'medium': m_med, 'slow': m_slow}[bucket]), bucket == 'slow'

    def pace(self, key):
        """The next draw (0..1) of a manager's answers: a golden-ratio sequence, so every share of PACE is met
        within one or two answers (independent draws would drift by ±8 % over 40 answers). Deterministic: the
        answers are made in the same order on every run."""
        n = self.pace_n.get(key, 0)
        self.pace_n[key] = n + 1
        start = int(hashlib.sha1(f'{self.seed}/{key}'.encode()).hexdigest()[:8], 16) / 2 ** 32
        return (start + n * GOLDEN) % 1.0

    def client_at(self, t):
        """When the client writes back after the manager: minutes later, or the next morning."""
        m, morning = self.trng.uniform(4, 75), self.trng.uniform(10, 120)
        c = t + dt.timedelta(minutes=m)
        if c.hour >= 21 or c.hour < 8 or c.weekday() == 6:
            day = c.date() + dt.timedelta(days=1) if c.hour >= 8 else c.date()
            if day.weekday() == 6:
                day += dt.timedelta(days=1)
            c = dt.datetime.combine(day, dt.time(9, 0)) + dt.timedelta(minutes=morning)
        return c

    def burst(self, d, items, t, limit, start=False):
        """
        Messages in a row. The manager answers a client's message at his pace (reply_at; a late answer begins
        with an apology), the client answers the manager minutes later. A conversation the client begins may
        start in the evening. All of it stays before `limit` (the next stage, now): squeezed if needed.
        """
        rng = d['crng']
        evening, sorry_pick = rng.random(), rng.random()
        ev_minutes = self.trng.uniform(60, 210)
        if items[0]['dir'] == 'in' and not start and evening < EVENING and t.weekday() != 6:
            e = dt.datetime.combine(t.date(), dt.time(18, 0)) + dt.timedelta(minutes=ev_minutes)
            if t < e and e + dt.timedelta(hours=16) < limit:
                t = e
        texts = [it['text'] for it in items]
        times = [t]
        for j in range(1, len(items)):
            prev, it = items[j - 1], items[j]
            if prev['dir'] == 'in' and it['dir'] == 'out':
                at, late = self.reply_at(d, times[-1])
                if late:
                    texts[j] = self.fmt(d, d['agent'], ['Извините за задержку, был((|а)) на встрече. ',
                                                        'Прошу прощения, что не сразу ответил((|а)). ',
                                                        'Извините, только освободил((ся|ась)). '][int(sorry_pick * 3)]) + texts[j]
            elif prev['dir'] == 'out' and it['dir'] == 'in':
                at = self.client_at(times[-1])
            else:
                at = times[-1] + dt.timedelta(minutes=self.trng.uniform(1, 4))
            times.append(at)
        cap = limit - dt.timedelta(minutes=1)
        if times[-1] > cap:
            span = (cap - times[0]).total_seconds()
            total = (times[-1] - times[0]).total_seconds()
            if span <= 2 * len(times):
                times = [times[0] + dt.timedelta(seconds=j) for j in range(len(times))]
            else:
                times = [times[0] + dt.timedelta(seconds=(x - times[0]).total_seconds() * span / total) for x in times]
        times = [sec(x) for x in times]
        for j in range(1, len(times)):
            if times[j] <= times[j - 1]:
                times[j] = times[j - 1] + dt.timedelta(seconds=1)
        for it, text, at in zip(items, texts, times):
            if d['main']['email'] and (d['ch'] == 'email' or (it['mail'] and d.get('mail', True))):
                self.mail(d, it['dir'], it['subj'], None, text, at)
            else:
                self.message(d, it['dir'], text, at)
        return times[-1]

    # ---------------------------------------------------------------- messengers, mail, calls
    def message(self, d, direction, text, t):
        main = d['main']
        agent = d['agent']
        channel = d['ch'] if d['ch'] in ('telegram', 'whatsapp') else ('telegram' if main['tg'] else 'whatsapp')
        if channel == 'telegram' and not main['tg_id']:
            channel = 'whatsapp' if main['wa_id'] else None
        if channel == 'whatsapp' and not main['wa_id']:
            channel = 'telegram' if main['tg_id'] else None
        if channel is None:             # no messenger: the manager writes it down
            if direction == 'out':
                self.event(E_COMMENT, t, deal=d, by=agent, after={'data': {'comment': 'Сообщение клиенту: ' + text, 'files': []}})
            return
        outgoing = direction == 'out'
        frm, to = (agent, main) if outgoing else (main, agent)
        after = {'message': text, 'files': [], 'from_user_id': frm['id'], 'to_user_id': to['id'], 'outgoing': outgoing}
        n = d['msg_n'] = d.get('msg_n', 0) + 1
        if channel == 'telegram':
            after.update({'contact': None, 'location': None})
            self.event(E_TELEGRAM, t, deal=d, by=frm, to=to, after=after, outgoing=outgoing,
                       tg_message_id=d['no'] * 1000 + n, source='telegram')
        else:
            wa = 'MOCK' + hashlib.sha1(f"{d['key']}/{n}".encode()).hexdigest()[:16].upper()
            self.event(E_WHATSAPP, t, deal=d, by=frm, to=to, after=after, outgoing=outgoing, external_id=wa,
                       source='whatsapp')

    def mail(self, d, direction, subject, html, text, t):
        """A letter in or out: a new subject opens a thread, «Re: …» or no subject answers in one."""
        t = sec(t)
        main = d['main']
        agent = d['agent']
        threads = d.setdefault('mail_threads', {})
        if subject is None:
            base = d.get('mail_current') or d['label']
        else:
            base = subject[4:] if subject.startswith('Re: ') else subject
        d['mail_current'] = base
        thread = threads.setdefault(base, [])
        subject = ('Re: ' + base) if thread else base
        outgoing = direction == 'out'
        if outgoing:
            body = html or f"<p>{text}</p><p>С уважением,<br>{agent['username']}<br>Parisa Home</p>"
        else:
            body = f"{text}\n\nС уважением,\n{main['username']}" + (f"\n{d['company']['name']}" if d['company'] else '')
        mid = '<' + hashlib.sha1(f"{d['key']}/{base}/{len(thread)}/{direction}".encode()).hexdigest()[:24] + \
              ('.crm@example.com>' if outgoing else '@example.org>')
        parent = thread[-1] if thread else None
        refs = ' '.join([x['message_id'] for x in thread][-10:]) or None
        cc = []
        if outgoing and len(d['contacts']) > 1 and d['contacts'][1]['email'] and 'договор' in subject.lower():
            cc = [d['contacts'][1]['email']]
        letter = dict(deal=d, outgoing=outgoing, subject=subject, body=body, sent_at=t, message_id=mid,
                      in_reply_to=parent['message_id'] if parent else None, reference_ids=refs,
                      frm=agent['email'] if outgoing else main['email'],
                      from_name=agent['username'] if outgoing else main['username'],
                      from_user=None if outgoing else main, sent_by=agent if outgoing else None,
                      to=[main['email']] if outgoing else [agent['email']], cc=cc,
                      mailbox=self.sent_box if outgoing else self.inbox, reader=agent,
                      fresh=bool(d.get('in_current') and not d['closed_at'] and d['last'] <= 3))
        thread.append(letter)
        self.emails.append(letter)

    def call(self, d, direction, seconds, t):
        main = d['main']
        agent = d['agent']
        outgoing = direction == 'out'
        t = sec(t)
        ms = seconds * 1000 + self.rng.randint(0, 999)
        rec = dict(duration=ms, outgoing=outgoing, created_at=t, user=agent, number=main['phone'], deal=d['id'])
        self.recordings.append(rec)
        self.event(E_CALL, t, deal=d, by=agent if outgoing else main, to=main if outgoing else agent,
                   after={'outgoing': outgoing, 'path': None, 'name': None, 'number': main['phone']},
                   outgoing=outgoing, duration=ms, source='ftp')

    def discount_events(self, d, t):
        agent = d['agent']
        old_total = sum(l['qty'] * l['list_price'] for l in d['lines'])
        for l in d['lines']:
            if l['price'] != l['list_price']:
                self.event(E_FIELD_UPDATE, t, deal=d, by=agent, field_of='deal',
                           after={'data': {'field': 'price', 'new_value': str(l['price']), 'old_value': str(l['list_price']),
                                           'subject': l['product']['name']}},
                           before={'data': {'field': 'price', 'new_value': str(l['list_price'])}})
        if old_total != d['budget']:
            self.event(E_FIELD_UPDATE, t + dt.timedelta(seconds=1), deal=d, by=agent, field_of='deal',
                       after={'data': {'field': 'budget', 'new_value': dec_text(d['budget']), 'old_value': dec_text(old_total)}},
                       before={'data': {'field': 'budget', 'new_value': dec_text(old_total)}})

    # ---------------------------------------------------------------- tasks
    def task(self, label, typ, agent, creator, created, due, closed, result, deal=None, company=None, contact=None,
             group=None, all_day=False):
        created, due, closed = sec(created), sec(due), sec(closed)
        if created > self.now or (closed and (closed > self.now or closed < created)):
            raise SystemExit(f'internal error: task «{label}» has impossible times')
        if all_day:
            start = dt.datetime.combine(due.date(), dt.time(0, 0))
            end = dt.datetime.combine(due.date(), dt.time(23, 59))
        else:
            end = due
            start = due - dt.timedelta(minutes=30)
            if start < created and closed is None and due > created:
                start = created
        t = dict(label=label, type=typ, agent=agent if not group else None, group=group, creator=creator,
                 created_at=created, start=start, end=end, all_day=all_day, closed_at=closed, result=result,
                 deal=deal, company=company, contact=contact)
        self.tasks.append(t)
        return t

    def build_loose_tasks_and_notes(self):
        """Tasks and notes of companies and contacts outside deals, a group task, the head's own task."""
        st, dk, am, my, head = (self.staff[k] for k in ('st', 'dk', 'am', 'my', 'head'))
        co, ct = self.company, self.contact

        def day(n, h=11, m=0):
            """n days ago at h:m (a Sunday: the Saturday before)."""
            return dt.datetime.combine(self.workday(self.today - dt.timedelta(days=n)), dt.time(h, m))

        def later(t, n, h, m=0):
            """n working days after t at h:m, and at least an hour after t (two days ago can be one Saturday)."""
            x = t.date()
            while n > 0:
                x += dt.timedelta(days=1)
                n -= x.weekday() != 6
            return max(dt.datetime.combine(x, dt.time(h, m)), t + dt.timedelta(hours=1))

        def due(state, created):
            return self.due_of(state, created, self.rng.random())

        # company tasks
        t = day(6, 12)
        at, all_day = due('future', t)
        self.task('Уточнить план закупок на I квартал 2027 года', 'Звонок', st, st, t, at, None, None,
                  company=co['c09'], all_day=all_day)
        t = day(22, 10)
        self.task('Поздравить с годовщиной сотрудничества', 'Связаться', my, head, t, later(t, 2, 12), later(t, 2, 15, 40),
                  'Поздравили, отправили в подарок набор полотенец с вышивкой', company=co['c15'])
        t = day(9, 10)
        at, _ = due('overdue', t)
        self.task('Запросить акт сверки за 2026 год', 'Связаться', am, am, t, at, None, None, company=co['c26'])
        t = day(2, 16)
        at, all_day = due('today', t)
        self.task('Обновить реквизиты в карточке компании', 'Связаться', dk, dk, t, at, None, None,
                  company=co['c03'], all_day=all_day)
        t = day(15, 11)
        self.task('Отправить прайс-лист на 2027 год', 'Отправить КП', my, my, t, later(t, 3, 12), later(t, 3, 14, 20),
                  'Прайс отправлен, клиент изучит к концу месяца', company=co['c17'])
        # contact tasks
        t = day(3, 15)
        at, _ = due('future', t)
        self.task('Предложить свадебные наборы полотенец с вышивкой', 'Встреча', dk, dk, t, at, None, None,
                  contact=ct['u48'])
        t = day(8, 11)
        at, _ = due('overdue', t)
        self.task('Перезвонить по оптовым ценам', 'Звонок', st, st, t, at, None, None, contact=ct['u50'])
        t = day(18, 10)
        self.task('Уточнить, нужны ли полотенца для кафе', 'Звонок', st, st, t, later(t, 1, 12), later(t, 1, 11, 25),
                  'Пока не нужно, просил связаться в январе', contact=ct['u49'])
        t = day(11, 14)
        self.task('Выслать каталог халатов', 'Отправить КП', dk, dk, t, later(t, 1, 15), later(t, 1, 12, 50),
                  'Каталог отправлен в Telegram', contact=ct['u46'])
        # a group task and the head's own
        t = day(4, 9, 30)
        at, _ = due('future', t)
        self.task('Подготовить прайс-лист на 2027 год', 'Связаться', None, head, t, at, None, None,
                  group=self.groups['g_uz'])
        t = day(1, 18)
        at, all_day = due('today', t)
        self.task('Провести планёрку отдела продаж', 'Встреча', head, head, t, at, None, None, all_day=all_day)

        # notes on the cards (outside deals)
        self.event(E_COMMENT, day(40, 12, 10), by=head, company_id=co['c10']['id'],
                   after={'data': {'comment': 'Работают по договору поставки, отсрочка платежа 30 дней — по согласованию с руководством.', 'files': []}})
        self.event(E_COMMENT, day(35, 15, 5), by=am, company_id=co['c23']['id'],
                   after={'data': {'comment': 'Документы для экспорта: инвойс, CMR, сертификат происхождения СТ-1. Растаможка на стороне клиента.', 'files': []}})
        self.event(E_COMMENT, day(25, 10, 40), by=st, contact_id=ct['u12']['id'],
                   after={'data': {'comment': 'Предпочитает общение по почте, звонить после 14:00.', 'files': []}})
        self.event(E_COMMENT, day(14, 17, 20), by=dk, contact_id=ct['u46']['id'],
                   after={'data': {'comment': 'Продаёт через Instagram и Uzum, берёт небольшие партии — от 200 шт.', 'files': []}})

    def build_mail_outside_deals(self):
        """
        A letter of nobody the CRM knows («Неразобранные» in Mail), one in Spam and one deleted (in Trash).
        Besides the Mail page they matter for the mail sync of a server with a real mailbox: it continues each
        mailbox from its newest stored letter, so every synced mailbox gets a recent mock letter and the sync
        does not copy the whole history of the real mailbox back after the wipe.
        """
        t1 = dt.datetime.combine(self.workday(self.today - dt.timedelta(days=5)), dt.time(9, 47))
        t2 = dt.datetime.combine(self.workday(self.today - dt.timedelta(days=2)), dt.time(7, 12))
        dk = self.staff['dk']
        self.emails.append(dict(deal=None, outgoing=False, subject='Приглашение на выставку домашнего текстиля 2027',
                                body='Здравствуйте! Приглашаем вашу компанию принять участие в выставке домашнего текстиля в марте 2027 года. Условия участия — во вложении к следующему письму.',
                                sent_at=t1, message_id='<expo2027.invite@example.org>', in_reply_to=None, reference_ids=None,
                                frm='events@example.org', from_name='Оргкомитет выставки', from_user=None, sent_by=None,
                                to=[dk['email']], cc=[], mailbox=self.inbox, reader=None))
        self.emails.append(dict(deal=None, outgoing=False, subject='Скидки на рекламу до 70%!!!',
                                body='Только сегодня — продвижение в соцсетях со скидкой. Ответьте на это письмо.',
                                sent_at=t2, message_id='<promo.0042@example.net>', in_reply_to=None, reference_ids=None,
                                frm='promo@example.net', from_name='Promo', from_user=None, sent_by=None,
                                to=[dk['email']], cc=[], mailbox=self.spam_box, reader=None, spam=True))
        t3 = dt.datetime.combine(self.workday(self.today - dt.timedelta(days=3)), dt.time(10, 5))
        self.emails.append(dict(deal=None, outgoing=False, subject='Рассылка: новые поступления фурнитуры',
                                body='Добрый день! В каталоге новые поступления: молнии, кнопки, тесьма. Прайс по запросу.',
                                sent_at=t3, message_id='<newsletter.1187@example.org>', in_reply_to=None, reference_ids=None,
                                frm='news@example.org', from_name='Рассылка поставщика', from_user=None, sent_by=None,
                                to=[dk['email']], cc=[], mailbox=self.trash_box, reader=dk,
                                deleted_at=t3 + dt.timedelta(hours=2, minutes=14), deleted_by=dk))

    # ---------------------------------------------------------------- nobody waits for an answer now
    def fix_waiting_clients(self):
        """
        The CRM bot reminds and escalates (to the admin's Telegram too) when a client's message of the last
        3 days in an open deal has no answer, and makes «Авто: ответьте клиенту» tasks. Every conversation of
        the data set answers the client already; this is the safety net (except the deals where the client
        waits on purpose, whose question is older than that).
        """
        horizon = self.now - dt.timedelta(days=4)
        by_deal = {}
        for e in self.events:
            if e['deal'] is not None:
                by_deal.setdefault(e['deal']['key'], []).append(e)
        for letter in self.emails:
            if letter['deal'] is not None:
                by_deal.setdefault(letter['deal']['key'], []).append(
                    dict(type=E_EMAIL, created_at=letter['sent_at'], outgoing=letter['outgoing']))
        for key in sorted(by_deal):
            evs = by_deal[key]
            d = self.deal[key]
            if d['closed_at']:
                continue
            last_in = max((e['created_at'] for e in evs if e['type'] in CHAT_TYPES and not e['outgoing']), default=None)
            last_out = max((e['created_at'] for e in evs if e['type'] in ANSWER_TYPES and e['outgoing']), default=None)
            if last_in and last_in > horizon and (last_out is None or last_out < last_in):
                t, _ = self.reply_at(d, last_in)
                if t >= self.now - dt.timedelta(minutes=1):
                    t = last_in + (self.now - last_in) / 2
                if d['path'][-1] != 'new':
                    text = self.mg(d, 'Спасибо, {first}, получил((|а)). Вернусь с ответом сегодня.',
                                   'Принято, посмотрю и отвечу до конца дня.', 'Спасибо! Уточню и напишу.')
                else:
                    text = self.mg(d, 'Здравствуйте! Спасибо за обращение, это {agent}. Уточню детали и пришлю расчёт.')
                if d['ch'] == 'email' and d['main']['email']:
                    self.mail(d, 'out', None, None, text, t)
                else:
                    self.message(d, 'out', text, t)

    # ================================================================ ids, rows of the history, checks
    def finish(self):
        # letters: rows, addresses, read marks, and their history entries
        # numbered by deal, then time (readers order by time; the id only breaks ties within a deal): a run at
        # another moment shifts the times but numbers every row the same way
        self.emails.sort(key=lambda x: (x['deal']['no'] if x['deal'] else 0, x['sent_at']))
        to_n = cc_n = 0
        for n, m in enumerate(self.emails, start=1):
            m['id'] = self.nid('email', n)
            # read: what we sent, what came before yesterday, and about a third of the newer ones (by the letter, not by chance)
            # read: what we sent, the letters outside deals, everything of the stages before; of the stage a deal
            # entered in the last 3 days about a third (by the letter, not by the time of the run)
            read = (m['outgoing'] or not m.get('fresh')
                    or int(hashlib.sha1(m['message_id'].encode()).hexdigest(), 16) % 10 < 3)
            self.add('email', {'id': m['id'], 'email_id': None, 'from': m['frm'], 'subject': m['subject'], 'body': m['body'],
                               'sent_at': m['sent_at'], 'read': bool(read and not m.get('spam')),
                               'user_id': m['from_user']['id'] if m['from_user'] else None,
                               'outgoing': m['outgoing'], 'is_spam': bool(m.get('spam')), 'deleted_at': m.get('deleted_at'),
                               'from_mailbox': m['mailbox'], 'thread_id': None, 'message_id': m['message_id'],
                               'uidvalidity': None, 'sent_by_id': m['sent_by']['id'] if m['sent_by'] else None,
                               'from_name': m['from_name'], 'in_reply_to': m['in_reply_to'],
                               'reference_ids': m['reference_ids'], 'html': '',
                               'deleted_by_id': m['deleted_by']['id'] if m.get('deleted_by') else None})
            m['to_rows'] = []
            for v in m['to']:
                to_n += 1
                self.add('email_to', dict(id=self.nid('email_to', to_n), value=v, email_id=m['id']))
                m['to_rows'].append({'id': self.nid('email_to', to_n), 'value': v})
            m['cc_rows'] = []
            for v in m['cc']:
                cc_n += 1
                self.add('email_cc', dict(id=self.nid('email_cc', cc_n), value=v, email_id=m['id']))
                m['cc_rows'].append({'id': self.nid('email_cc', cc_n), 'value': v})
            if not m['outgoing'] and m['reader'] and read:
                self.add('email_read', dict(email_id=m['id'], user_id=m['reader']['id'],
                                            read_at=min(self.now, m['sent_at'] + dt.timedelta(minutes=self.trng.randint(5, 90)))))
            if m['deal'] is not None:
                data = {'id': m['id'], 'email_id': None, 'from': m['frm'], 'thread_id': None, 'message_id': m['message_id'],
                        'uidvalidity': None, 'from_name': m['from_name'], 'in_reply_to': m['in_reply_to'],
                        'reference_ids': m['reference_ids'], 'subject': m['subject'], 'to': m['to_rows'],
                        'cc': m['cc_rows'], 'files': [], 'outgoing': m['outgoing'], 'body': m['body'],
                        'sent_at': iso(m['sent_at']), 'read': bool(read), 'is_spam': False,
                        'from_mailbox': m['mailbox'], 'deleted_at': None,
                        'from_user': person(m['from_user']) if m['from_user'] else {}}
                self.event(E_EMAIL, m['sent_at'], deal=m['deal'], by=m['from_user'] if m['from_user'] else m['sent_by'],
                           after={'data': data}, outgoing=m['outgoing'], source='web' if m['outgoing'] else 'mail')
        # call records (no audio file: path NULL, the history says «запись недоступна»)
        self.recordings.sort(key=lambda r: (r['deal'], r['created_at']))
        for n, r in enumerate(self.recordings, start=1):
            self.add('recording', dict(id=self.nid('recording', n), duration=r['duration'], outgoing=r['outgoing'],
                                       path=None, created_at=r['created_at'], user_id=r['user']['id'],
                                       from_number=r['number']))
        # tasks, by creation
        self.tasks.sort(key=lambda t: (t['deal']['no'] if t['deal'] else 0, t['created_at'], t['label']))
        notif = 0
        for n, t in enumerate(self.tasks, start=1):
            t['id'] = self.nid('task', n)
            company = t['company']
            self.add('task', {'id': t['id'], 'label': t['label'], 'result': t['result'], 'closed_at': t['closed_at'],
                              'start_time': t['start'], 'end_time': t['end'], 'allDay': t['all_day'],
                              'created_at': t['created_at'], 'type_id': self.task_type[t['type']]['id'],
                              'company_id': company['id'] if company else None,
                              'ctr_agent_id': t['contact']['id'] if t['contact'] else None,
                              'agent_id': t['agent']['id'] if t['agent'] else None,
                              'group_id': t['group']['id'] if t['group'] else None,
                              'deal_id': t['deal']['id'] if t['deal'] else None,
                              'createdById': t['creator']['id']})
            # TaskService.notifyAboutNewTask: a «new task» row when a company can be found
            co_id = (company or {}).get('id') or ((t['deal'] or {}).get('company') or {}).get('id') or \
                (((t['contact'] or {}).get('company')) or {}).get('id')
            if co_id:
                notif += 1
                self.add('notification', dict(id=self.nid('notification', notif), message='new task', company_id=co_id))
            open_snap = dict(t, result=None, closed_at=None)
            self.event(E_TASK, t['created_at'], deal=t['deal'], by=t['creator'], task=t, after=self.task_snapshot(open_snap),
                       group=None)
            if t['closed_at']:
                self.event(E_TASK_STATUS, t['closed_at'], deal=t['deal'], by=t['agent'] or t['creator'], task=t,
                           after=self.task_snapshot(t))
        # numbers of the child rows
        for table in ('deal_product', 'deal_filler', 'deal_stage_record'):
            rows = self.rows[table]
            if table == 'deal_stage_record':
                rows.sort(key=lambda r: (r['deal_id'], r['created_at']))
            for n, row in enumerate(rows, start=1):
                row['id'] = self.nid(table, n)
        # the history: by time, ids in that order
        self.events.sort(key=lambda e: (e['deal']['no'] if e['deal'] else 0, e['created_at'], e['type']))
        for n, e in enumerate(self.events, start=1):
            e['id'] = self.nid('event', n)
        self.fill_replied_at()
        for e in self.events:
            company_id, contact_id = self.client_of(e)
            self.add('event', {
                'id': e['id'], 'type': e['type'], 'field_of': e['field_of'], 'before_state': e['before'],
                'after_state': e['after'], 'created_at': e['created_at'],
                'deal_id': e['deal']['id'] if e['deal'] else None,
                'task_id': e['task']['id'] if e['task'] else None,
                'user_id': e['by']['id'] if e['by'] else None,
                'target_user_id': e['to']['id'] if e['to'] else None,
                'target_group_id': e['group']['id'] if e['group'] else None,
                'outgoing': e['outgoing'], 'tg_message_id': e['tg_message_id'], 'duration': e['duration'],
                'replied_at': e.get('replied_at'), 'external_id': e['external_id'],
                'company_id': company_id, 'contact_id': contact_id, 'source': e['source'], 'source_ref': None})

    def fill_replied_at(self):
        """event.replied_at of a client's message: the first answer after it in the deal (ControlService)."""
        by_deal = {}
        for e in self.events:
            if e['deal'] is not None:
                by_deal.setdefault(e['deal']['id'], []).append(e)
        for evs in by_deal.values():
            evs.sort(key=lambda e: (e['created_at'], e['id']))
            for i, e in enumerate(evs):
                if e['type'] in CHAT_TYPES and not e['outgoing']:
                    for f in evs[i + 1:]:
                        if f['type'] in ANSWER_TYPES and f['outgoing']:
                            e['replied_at'] = f['created_at']
                            break

    def client_of(self, e):
        """event.company_id / contact_id as EventClientSubscriber fills them."""
        company_id, contact_id = e['company_id'], e['contact_id']
        if company_id and contact_id:
            return company_id, contact_id
        data = (e['after'] or {}).get('data') if isinstance(e['after'], dict) else None
        snap_contact = snap_company = None
        if isinstance(data, dict):
            if e['type'] == E_NEW_CONTACT:
                snap_contact = data.get('id')
                snap_company = (data.get('company') or {}).get('id')
            elif e['type'] == E_NEW_COMPANY:
                snap_company = data.get('id')
            elif e['type'] in (E_TASK, E_TASK_STATUS):
                snap_contact = (data.get('ctr_agent') or {}).get('id')
                snap_company = (data.get('company') or {}).get('id')
        if not contact_id:
            contact_id = snap_contact
            if not contact_id and e['task'] and e['task']['contact']:
                contact_id = e['task']['contact']['id']
            if not contact_id:
                for p in (e['by'], e['to']):
                    if p and p.get('role') == 'ctr_agent':
                        contact_id = p['id']
                        break
        if not company_id:
            if e['deal'] and e['deal']['company']:
                company_id = e['deal']['company']['id']
            elif e['task'] and e['task']['company']:
                company_id = e['task']['company']['id']
            elif snap_company:
                company_id = snap_company
            elif contact_id:
                c = next((u for u in self.contact.values() if u['id'] == contact_id), None)
                company_id = c['company']['id'] if c and c['company'] else None
        return company_id, contact_id


# ========================================================================================== passwords

def users_file(users_dir, db_name):
    """One file of mock logins per database: production gets passwords of its own."""
    return os.path.join(users_dir, f'mock-users-{db_name}.txt')


def load_passwords(path, seed_emails, bcrypt_mod):
    """Reuse the passwords of the users file (a second run keeps the logins), make the missing ones."""
    known = {}
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            for line in f:
                if line.startswith('#') or '\t' not in line:
                    continue
                parts = line.rstrip('\n').split('\t')
                if len(parts) >= 2 and '@' in parts[0]:
                    known[parts[0]] = parts[1]
    alphabet = string.ascii_letters + string.digits
    result = {}
    for email in seed_emails:
        pw = known.get(email)
        if not pw:
            pw = ''.join(secrets.choice(alphabet) for _ in range(14))
        h = bcrypt_mod.hashpw(pw.encode(), bcrypt_mod.gensalt(rounds=10)).decode()
        # random: a token the API issued before cannot match (the mock ids are new anyway)
        tv = 1000 + secrets.randbelow(900000)
        result[email] = {'password': pw, 'hash': h, 'tv': tv}
    return result


def write_users_file(path, passwords, db_name):
    lines = [f'# Mock accounts of the Parisa CRM test data in the database {db_name} (local/seed/wipe_and_seed.py). Keep secret.',
             '# e-mail\tpassword\trole\tname\twhat they see']
    for key, name, email, tail, role, group, perms, title, goal in STAFF:
        lines.append(f"{email}\t{passwords[email]['password']}\t{role}\t{name}\t{title}")
    os.makedirs(os.path.dirname(os.path.abspath(path)), mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), prefix='.mock-users.')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    os.chmod(path, 0o600)


# ============================================================================================ the plan

def catalog(db):
    tables = [r[0] for r in db.rows(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1")]
    seqs = [dict(table=r[0], column=r[1], seq=r[2]) for r in db.rows("""
        SELECT t.relname, a.attname, s.relname
          FROM pg_depend d
          JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
          JOIN pg_class t ON t.oid = d.refobjid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
         WHERE n.nspname = 'public' AND d.deptype IN ('a', 'i')
         ORDER BY 1""")]
    cols = {}
    for t, c in db.rows("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'"):
        cols.setdefault(t, set()).add(c)
    return tables, seqs, cols


def counts(db, tables):
    parts = []
    for t in tables:
        cond = PARTIAL.get(t)
        kept = f'count(*) FILTER (WHERE {cond})' if cond else ('count(*)' if t in KEEP_FULL else '0')
        parts.append(f"SELECT {q(t)}, count(*), {kept} FROM public.{qi(t)}")
    rows = db.rows(' UNION ALL '.join(parts)) if parts else []
    return {r[0]: (int(r[1]), int(r[2])) for r in rows}


def action_of(t):
    if t in KEEP_FULL:
        return 'keep'
    if t in PARTIAL:
        return 'keep admin rows'
    if t in RESET:
        return 'reset'
    return 'wipe'


def seq_state(db):
    """Every sequence of schema public, owned by a column or not: last_value, is_called and its comment (to compare
    before and after a dry run or a failed run)."""
    names = [r[0] for r in db.rows("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                                   "WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY 1")]
    if not names:
        return {}
    parts = [f"SELECT {q(name)}, s.last_value, s.is_called, "
             f"coalesce(obj_description({q('public.' + qi(name))}::regclass, 'pg_class'), '') FROM public.{qi(name)} s"
             for name in names]
    return {r[0]: (int(r[1]), r[2] == 't', r[3]) for r in db.rows(' UNION ALL '.join(parts))}


def compare_seqs(before, after):
    """Lines describing what changed; empty when every sequence is exactly as before."""
    lines = []
    for name in sorted(set(before) | set(after)):
        if before.get(name) != after.get(name):
            lines.append(f'  {name}: {before.get(name)} -> {after.get(name)}')
    return lines


def ranges(ids):
    """«2-6, 9, 12-40»."""
    ids = sorted(ids)
    out_ = []
    i = 0
    while i < len(ids):
        j = i
        while j + 1 < len(ids) and ids[j + 1] == ids[j] + 1:
            j += 1
        out_.append(str(ids[i]) if i == j else f'{ids[i]}-{ids[j]}')
        i = j + 1
    return ', '.join(out_) or '-'


def id_plan(db, seqs, sizes):
    """
    Where the mock rows of each table go: above the highest id the table ever had (max(id) and the position of
    its sequence), rounded up to a hundred, with room to spare (so the next run fits in the same range); or the
    same range again when the sequence's comment marks it as the mock range of an earlier run and it is big
    enough (only mock rows ever had those ids). A table without a sequence keeps its ids as they are.
    """
    by_table = {s['table']: s for s in seqs if s['column'] == 'id'}
    plan = []
    parts = []
    for t in sizes:
        if t in by_table:
            s = by_table[t]
            parts.append(f"SELECT {q(t)}, (SELECT max(id) FROM public.{qi(t)}), s.last_value, s.is_called, "
                         f"coalesce(obj_description({q('public.' + qi(s['seq']))}::regclass, 'pg_class'), '') "
                         f"FROM public.{qi(s['seq'])} s")
    state = {r[0]: r for r in db.rows(' UNION ALL '.join(parts))} if parts else {}
    for t, n in sizes.items():
        if t not in by_table or n == 0:
            continue
        _, mx, last, called, comment = state[t]
        mx = int(mx) if mx else 0
        pos = int(last) if called == 't' else int(last) - 1
        hwm = max(mx, pos)
        m = MARK_RE.match(comment or '')
        if m and int(m.group(1)) >= 1 and n <= int(m.group(2)) - int(m.group(1)) + 1 and pos >= int(m.group(2)):
            base, top, reuse = int(m.group(1)) - 1, int(m.group(2)), True
        else:
            base = -(-hwm // 100) * 100
            top = base + (n // 100 + 1) * 100
            reuse = False
        plan.append(dict(table=t, seq=by_table[t]['seq'], n=n, base=base, top=top, reuse=reuse, hwm=hwm, max_id=mx,
                         pos=pos, mark=f'{MARK} {base + 1}-{top}'))
    return plan


def plan_values(plan):
    return ', '.join(f"({q(p['table'])}, {q(p['seq'])}, {p['base']}::bigint, {p['top']}::bigint, "
                     f"{'TRUE' if p['reuse'] else 'FALSE'}, {q(p['mark'])}, {p['n']}::bigint)" for p in plan)


def ids_check_sql(plan):
    """Under the locks, before anything is deleted: the ids are still where the plan saw them."""
    if not plan:
        return []
    return [f"""DO $ids$
DECLARE
  r record;
  pos bigint;
  mx bigint;
  cmt text;
BEGIN
  FOR r IN SELECT * FROM (VALUES {plan_values(plan)}) v(tbl, seq, base, top, reuse, mark, n) LOOP
    EXECUTE format('SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM %I', r.seq) INTO pos;
    EXECUTE format('SELECT max(id) FROM %I', r.tbl) INTO mx;
    cmt := obj_description(format('public.%I', r.seq)::regclass, 'pg_class');
    IF r.reuse AND (cmt IS DISTINCT FROM r.mark OR pos < r.top) THEN
      RAISE EXCEPTION 'the mock range of % changed since the plan (sequence at %, comment %): run the script again', r.tbl, pos, cmt;
    ELSIF NOT r.reuse AND (pos > r.base OR coalesce(mx, 0) > r.base) THEN
      RAISE EXCEPTION 'the ids of % moved on since the plan (max id %, sequence at %, mock ids from %): run the script again',
        r.tbl, mx, pos, r.base + 1;
    END IF;
  END LOOP;
END
$ids$;"""]


def ids_seal_sql(plan):
    """After the inserts: every mock row in its range, each sequence after the range (forward only, ALTER SEQUENCE
    RESTART is transactional), the comment that marks the range for the next run."""
    if not plan:
        return []
    return [f"""DO $seal$
DECLARE
  r record;
  pos bigint;
  bad bigint;
  cnt bigint;
BEGIN
  FOR r IN SELECT * FROM (VALUES {plan_values(plan)}) v(tbl, seq, base, top, reuse, mark, n) LOOP
    EXECUTE format('SELECT count(*), count(*) FILTER (WHERE id <= $1 OR id > $2) FROM %I WHERE NOT (%L = ''user'' AND id = 1)', r.tbl, r.tbl)
      INTO cnt, bad USING r.base, r.top;
    IF bad > 0 OR cnt <> r.n THEN
      RAISE EXCEPTION 'mock rows of % outside their ids % - % (% of % rows)', r.tbl, r.base + 1, r.top, bad, cnt;
    END IF;
    EXECUTE format('SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM %I', r.seq) INTO pos;
    IF pos < r.top THEN
      EXECUTE format('ALTER SEQUENCE %I RESTART WITH %s', r.seq, r.top + 1);
    END IF;
    EXECUTE format('COMMENT ON SEQUENCE %I IS %L', r.seq, r.mark);
  END LOOP;
END
$seal$;"""]


def deleted_users(db, cols):
    """The staff accounts that go, with what the outside services may still hold for them."""
    links = []
    if 'messenger_account' in cols and {'user_id', 'channel'} <= cols['messenger_account']:
        links.append("(SELECT string_agg(m.channel, '+' ORDER BY m.channel) FROM messenger_account m WHERE m.user_id = u.id)")
    else:
        links.append("NULL")
    for t in ('bot_account', 'recorder_token', 'call_upload'):
        links.append(f"(SELECT count(*) FROM {qi(t)} x WHERE x.user_id = u.id)" if 'user_id' in cols.get(t, set()) else '0')
    staff = db.rows(f"""SELECT u.id, u.role, (u.deleted_at IS NOT NULL), {', '.join(links)}
                          FROM "user" u WHERE u.id <> {ADMIN_ID} AND u.role <> 'ctr_agent' ORDER BY u.id""")
    contacts = [int(r[0]) for r in db.rows(f"""SELECT id FROM "user" WHERE id <> {ADMIN_ID} AND role = 'ctr_agent' ORDER BY id""")]
    return staff, contacts


# ======================================================================================= the change

def wipe_sql():
    """
    The wipe, as one block that reads the catalog inside the transaction (under the locks), so it fits the schema
    the database has at that moment (tables or rules added by later migrations included):
      1. rows that stay and point to rows that go: the reference is cleared (a row that must have one goes, with a note);
      2. one TRUNCATE … CONTINUE IDENTITY of every table that no staying table refers to (no sequence is touched);
      3. the other rows of the partly kept tables, "user" last;
      4. DELETE of the remaining wiped tables (those a staying table may refer to: company, group), children first.
    """
    order = [t for t in PARTIAL if t != 'user'] + ['user']
    part_t = ', '.join(q(t) for t in order)
    part_c = ', '.join(q(PARTIAL[t]) for t in order)
    keep_full = ', '.join(q(t) for t in sorted(KEEP_FULL))
    return [f"""DO $wipe$
DECLARE
  keep_full text[] := ARRAY[{keep_full}];
  part_t text[] := ARRAY[{part_t}];
  part_c text[] := ARRAY[{part_c}];
  wiped text[];
  truncatable text[];
  later text[];
  t text;
  fk record;
  keep text;
  dangling text;
  n bigint;
  progressed boolean;
BEGIN
  SELECT coalesce(array_agg(c.relname::text ORDER BY c.relname), '{{}}') INTO wiped
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p')
     AND NOT (c.relname::text = ANY (keep_full)) AND NOT (c.relname::text = ANY (part_t));

  FOR fk IN SELECT cl.relname::text AS tbl, a.attname::text AS col, rc.relname::text AS ref, ra.attname::text AS refcol,
                   a.attnotnull AS nn, c.conname::text AS con
              FROM pg_constraint c
              JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
              JOIN pg_class rc ON rc.oid = c.confrelid
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
              JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = c.confkey[1]
             WHERE c.contype = 'f' AND ns.nspname = 'public' AND array_length(c.conkey, 1) = 1
               AND cl.relname::text = ANY (part_t) AND NOT (rc.relname::text = ANY (keep_full))
             ORDER BY 1, 2
  LOOP
    keep := part_c[array_position(part_t, fk.tbl)];
    IF fk.ref = ANY (part_t) THEN
      dangling := format('%I IS NOT NULL AND %I NOT IN (SELECT %I FROM %I WHERE %s)',
                         fk.col, fk.col, fk.refcol, fk.ref, part_c[array_position(part_t, fk.ref)]);
    ELSE
      dangling := format('%I IS NOT NULL', fk.col);
    END IF;
    IF fk.nn THEN
      EXECUTE format('DELETE FROM %I WHERE (%s) AND %s', fk.tbl, keep, dangling);
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN RAISE NOTICE 'kept rows of % removed: % (they must point to deleted data, %)', fk.tbl, n, fk.con; END IF;
    ELSE
      EXECUTE format('UPDATE %I SET %I = NULL WHERE (%s) AND %s', fk.tbl, fk.col, keep, dangling);
    END IF;
  END LOOP;

  SELECT coalesce(array_agg(w ORDER BY w), '{{}}') INTO truncatable FROM unnest(wiped) w
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c
                       JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
                       JOIN pg_class rc ON rc.oid = c.confrelid
                      WHERE c.contype = 'f' AND ns.nspname = 'public' AND rc.relname::text = w
                        AND (cl.relname::text = ANY (keep_full) OR cl.relname::text = ANY (part_t)));
  IF cardinality(truncatable) > 0 THEN
    -- CONTINUE IDENTITY: no sequence moves back (ids handed out before are never given again)
    EXECUTE 'TRUNCATE ' || (SELECT string_agg(format('%I', x), ', ') FROM unnest(truncatable) x) || ' CONTINUE IDENTITY';
  END IF;

  FOREACH t IN ARRAY part_t LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('DELETE FROM %I WHERE NOT (%s)', t, part_c[array_position(part_t, t)]);
    END IF;
  END LOOP;

  SELECT coalesce(array_agg(w), '{{}}') INTO later FROM unnest(wiped) w WHERE NOT (w = ANY (truncatable));
  WHILE cardinality(later) > 0 LOOP
    progressed := false;
    FOREACH t IN ARRAY later LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_class rc ON rc.oid = c.confrelid
                      WHERE c.contype = 'f' AND rc.relname::text = t AND cl.relname::text <> t AND cl.relname::text = ANY (later)) THEN
        EXECUTE format('DELETE FROM %I', t);
        later := array_remove(later, t);
        progressed := true;
      END IF;
    END LOOP;
    IF NOT progressed THEN
      FOREACH t IN ARRAY later LOOP EXECUTE format('DELETE FROM %I', t); END LOOP;
      later := '{{}}';
    END IF;
  END LOOP;
  RAISE NOTICE 'wiped % tables (% by TRUNCATE), kept rows of %', cardinality(wiped), cardinality(truncatable), array_to_string(part_t, ', ');
END
$wipe$;"""]


CHECKS_SQL = r"""
DO $checks$
DECLARE
  bad bigint;
  msg text := '';
  seqrec record;
BEGIN
  -- foreign keys hold by construction (the database refuses anything else); the rest:
  SELECT count(*) INTO bad FROM deal d LEFT JOIN deal_stage s ON s.id = d.stage_id
   WHERE s.id IS NULL OR d.agent_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM "user" a WHERE a.id = d.agent_id AND a.role IN ('admin', 'manager', 'agent') AND a.deleted_at IS NULL);
  IF bad > 0 THEN msg := msg || format('%s deals without a stage or a responsible; ', bad); END IF;

  SELECT count(*) INTO bad FROM collection WHERE is_active;
  IF bad <> 1 THEN msg := msg || format('%s active pipelines; ', bad); END IF;
  SELECT count(*) INTO bad FROM (SELECT k FROM unnest(ARRAY['new','first_contact','prepayment','won','lost']) k
     WHERE (SELECT count(*) FROM deal_stage s JOIN collection c ON c.id = s.collection_id AND c.is_active WHERE s.kind = k) <> 1) x;
  IF bad > 0 THEN msg := msg || 'the pipeline lacks a system stage; '; END IF;

  SELECT count(*) INTO bad FROM task t LEFT JOIN task_type y ON y.id = t.type_id WHERE y.id IS NULL OR t.end_time < t.start_time;
  IF bad > 0 THEN msg := msg || format('%s tasks without a type or ending before they start; ', bad); END IF;

  SELECT count(*) INTO bad FROM (SELECT display_id FROM deal GROUP BY display_id HAVING count(*) > 1) x;
  IF bad > 0 THEN msg := msg || 'deal numbers are not unique; '; END IF;
  IF (SELECT count(*) FROM deal) <> (SELECT COALESCE(max(display_id), 0) FROM deal) THEN
    msg := msg || 'deal numbers are not 1..N; ';
  END IF;

  -- the stage history: in time order, each row from the stage of the one before, the last = the stage now
  SELECT count(*) INTO bad FROM (
    SELECT r.deal_id, r.created_at, r.stage_id, r.from_stage_id, r.moved_after_minutes,
           lag(r.stage_id) OVER w AS prev_stage, lag(r.created_at) OVER w AS prev_at,
           lead(r.created_at) OVER w AS next_at, row_number() OVER w AS n
      FROM deal_stage_record r WINDOW w AS (PARTITION BY r.deal_id ORDER BY r.created_at, r.id)) x
   WHERE (x.n = 1 AND x.from_stage_id IS NOT NULL)
      OR (x.n > 1 AND (x.from_stage_id IS DISTINCT FROM x.prev_stage OR x.created_at <= x.prev_at))
      OR (x.next_at IS NOT NULL AND x.moved_after_minutes IS DISTINCT FROM floor(extract(epoch FROM x.next_at - x.created_at) / 60)::bigint)
      OR (x.next_at IS NULL AND x.moved_after_minutes IS NOT NULL);
  IF bad > 0 THEN msg := msg || format('%s stage history rows out of order; ', bad); END IF;
  SELECT count(*) INTO bad FROM deal d
   WHERE d.stage_id IS DISTINCT FROM (SELECT r.stage_id FROM deal_stage_record r WHERE r.deal_id = d.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1)
      OR d.created_at <> (SELECT min(r.created_at) FROM deal_stage_record r WHERE r.deal_id = d.id)
      OR COALESCE(d.last_stage_change, d.created_at) <> (SELECT max(r.created_at) FROM deal_stage_record r WHERE r.deal_id = d.id);
  IF bad > 0 THEN msg := msg || format('%s deals whose stage history does not match the deal; ', bad); END IF;
  SELECT count(*) INTO bad FROM deal d JOIN deal_stage s ON s.id = d.stage_id
   WHERE (s.kind IN ('won', 'lost')) <> (d.closed_at IS NOT NULL)
      OR (s.kind = 'lost' AND d.lost_reason IS NULL) OR (s.kind <> 'lost' AND d.lost_reason IS NOT NULL);
  IF bad > 0 THEN msg := msg || format('%s deals closed / lost inconsistently; ', bad); END IF;

  -- the history: every event in time with its deal, people of the messages exist
  SELECT count(*) INTO bad FROM event e JOIN deal d ON d.id = e.deal_id WHERE e.created_at < d.created_at;
  IF bad > 0 THEN msg := msg || format('%s events before their deal; ', bad); END IF;
  SELECT count(*) INTO bad FROM event e
   WHERE e.type IN (12, 16) AND (NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = (e.after_state->>'from_user_id')::int)
                              OR NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = (e.after_state->>'to_user_id')::int));
  IF bad > 0 THEN msg := msg || format('%s messages naming unknown people; ', bad); END IF;
  SELECT count(*) INTO bad FROM event e
   WHERE e.type = 9 AND NOT EXISTS (SELECT 1 FROM email m WHERE m.id = ((e.after_state->'data')->>'id')::int);
  IF bad > 0 THEN msg := msg || format('%s letters of the history without their letter; ', bad); END IF;
  SELECT count(*) INTO bad FROM event e WHERE e.created_at > now() + interval '1 minute';
  IF bad > 0 THEN msg := msg || format('%s events in the future; ', bad); END IF;

  -- nothing goes out: no triggers, no queued runs, no AI jobs, no reminders, no uploads, no recorder tokens
  SELECT (SELECT count(*) FROM "trigger") + (SELECT count(*) FROM trigger_run) + (SELECT count(*) FROM ai_job)
       + (SELECT count(*) FROM bot_reminder) + (SELECT count(*) FROM call_upload) + (SELECT count(*) FROM recorder_token)
    INTO bad;
  IF bad > 0 THEN msg := msg || 'triggers, runs, AI jobs, reminders, uploads or recorder tokens exist; '; END IF;
  -- the CRM bot would escalate a client's message of the last 3 days without an answer in an open deal
  SELECT count(*) INTO bad FROM deal d
   WHERE d.deleted_at IS NULL AND d.closed_at IS NULL AND EXISTS (
     SELECT 1 FROM event q WHERE q.deal_id = d.id AND NOT q.outgoing AND q.type IN (9, 11, 12, 16)
        AND q.created_at > now() - interval '4 days'
        AND q.created_at > COALESCE((SELECT max(o.created_at) FROM event o WHERE o.deal_id = d.id AND o.outgoing
                                       AND o.type IN (9, 10, 11, 12, 16)), '-infinity'));
  IF bad > 0 THEN msg := msg || format('%s open deals with a recent unanswered client message; ', bad); END IF;
  -- people of the mock data cannot be reached: reserved phone ranges and domains, impossible messenger ids
  SELECT count(*) INTO bad FROM "user" u WHERE u.id <> 1
     AND ((u.phone IS NOT NULL AND u.phone !~ '^\+(99800000|99600000|7000000)[0-9]{4}$')
       OR (u.email IS NOT NULL AND u.email !~ '@example\.(com|org|net)$')
       OR (u.tg_id IS NOT NULL AND u.tg_id < 4503599627370496)
       OR (u.wa_id IS NOT NULL AND u.wa_id !~ '^(99800000|99600000|7000000)[0-9]{4}@s\.whatsapp\.net$'));
  SELECT bad + count(*) INTO bad FROM company c
   WHERE (c.phone IS NOT NULL AND c.phone !~ '^\+(99800000|99600000|7000000)[0-9]{4}$')
      OR (c.email IS NOT NULL AND c.email !~ '@example\.(com|org|net)$');
  SELECT bad + count(*) INTO bad FROM email_to WHERE value !~ '@example\.(com|org|net)$';
  SELECT bad + count(*) INTO bad FROM email_cc WHERE value !~ '@example\.(com|org|net)$';
  SELECT bad + count(*) INTO bad FROM recording WHERE from_number !~ '^\+(99800000|99600000|7000000)[0-9]{4}$' OR path IS NOT NULL;
  IF bad > 0 THEN msg := msg || format('%s phones, addresses or ids outside the reserved ranges; ', bad); END IF;
  SELECT count(*) INTO bad FROM (SELECT right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) k FROM "user"
                                  WHERE role = 'ctr_agent' AND phone IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x;
  IF bad > 0 THEN msg := msg || 'two contacts share a phone; '; END IF;

  -- the admin is still there and nothing points to deleted rows
  IF NOT EXISTS (SELECT 1 FROM "user" WHERE id = 1 AND role = 'admin' AND deleted_at IS NULL) THEN
    msg := msg || 'the admin (user 1) is missing; ';
  END IF;
  -- every serial number continues after its rows
  FOR seqrec IN SELECT t.relname AS tbl, a.attname AS col, s.relname AS seq
             FROM pg_depend dp JOIN pg_class s ON s.oid = dp.objid AND s.relkind = 'S'
             JOIN pg_class t ON t.oid = dp.refobjid JOIN pg_namespace n ON n.oid = t.relnamespace
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = dp.refobjsubid
            WHERE n.nspname = 'public' AND dp.deptype IN ('a', 'i') LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I > (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM %I)',
                   seqrec.tbl, seqrec.col, seqrec.seq) INTO bad;
    IF bad > 0 THEN msg := msg || format('sequence %s is behind %s; ', seqrec.seq, seqrec.tbl); END IF;
  END LOOP;

  IF msg <> '' THEN
    RAISE EXCEPTION 'mock data checks failed, nothing is changed: %', msg;
  END IF;
  RAISE NOTICE 'checks passed: stages, responsibles, task types, stage history, numbers, history, reserved contacts, sequences';
END
$checks$;
"""


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
    ap = argparse.ArgumentParser(description='Wipe the data of a Parisa CRM database (admin user 1 stays) and load mock data.')
    ap.add_argument('--db', required=True, choices=DATABASES, help='parisahon (production) or crm_staging: nothing else')
    ap.add_argument('--i-have-a-backup', action='store_true', help='without it the script only shows the plan')
    ap.add_argument('--container', default='crm-db', help='Postgres container (default crm-db)')
    ap.add_argument('--db-user', default='root', help='database role psql connects as (default root)')
    ap.add_argument('--users-dir', default=USERS_DIR,
                    help=f'where the mock logins go: <dir>/mock-users-<db>.txt, chmod 600 (default {USERS_DIR})')
    ap.add_argument('--seed', default='2026', help='the same seed gives the same data (default 2026)')
    ap.add_argument('--inbox', default='INBOX', help='EMAIL_MAIN_MAILBOX of the API')
    ap.add_argument('--sent-mailbox', default='INBOX.Sent', help='EMAIL_SENT_MAILBOX of the API')
    ap.add_argument('--spam-mailbox', default='INBOX.spam', help='EMAIL_SPAM_MAILBOX of the API')
    ap.add_argument('--trash-mailbox', default='INBOX.Trash', help='EMAIL_TRASH_MAILBOX of the API')
    ap.add_argument('--sql-out', help='also write the SQL of the change to this file (chmod 600) for review')
    ap.add_argument('--rollback', action='store_true',
                    help='do everything and run the checks, then ROLLBACK: nothing changes (a dry run, no backup needed)')
    ap.add_argument('--offline-now', help=argparse.SUPPRESS)   # test of the generator alone: no database
    ap.add_argument('--offline-base', type=int, default=0, help=argparse.SUPPRESS)   # with --offline-now: ids from N+1
    # test of the failure path (staging only): everything, then an error right before COMMIT / ROLLBACK
    ap.add_argument('--test-fail', action='store_true', help=argparse.SUPPRESS)
    args = ap.parse_args()
    if args.test_fail and args.db != 'crm_staging':
        raise SystemExit('--test-fail is for crm_staging only')
    mailboxes = (args.inbox, args.sent_mailbox, args.spam_mailbox, args.trash_mailbox)
    fake = {s[2]: {'password': 'x', 'hash': '$2b$10$' + 'x' * 53, 'tv': 1000} for s in STAFF}

    if args.offline_now:
        now = dt.datetime.strptime(args.offline_now, '%Y-%m-%d %H:%M:%S')
        bases = {t: args.offline_base for t in SEEDED_COLUMNS}
        gen = Gen(now, args.seed, mailboxes, fake, bases)
        gen.build()
        for t, rows in gen.rows.items():
            out(f'{t:<20} {len(rows):>6}')
        if args.sql_out:
            with open(args.sql_out, 'w', encoding='utf-8') as f:
                for t, rows in gen.rows.items():
                    f.write('\n'.join(inserts(t, rows)) + '\n')
        return gen
    db = Db(args.container, args.db_user, args.db)
    users_path = users_file(args.users_dir, args.db)

    out(f'== Parisa CRM mock data: database «{args.db}» (container {args.container})')
    now_text = db.rows(f"SELECT to_char(now() AT TIME ZONE {q(TZ_NAME)}, 'YYYY-MM-DD HH24:MI:SS')")[0][0]
    now = dt.datetime.strptime(now_text, '%Y-%m-%d %H:%M:%S')
    tables, seqs, cols = catalog(db)
    if 'migrations' not in tables or 'user' not in tables:
        raise SystemExit('this is not a CRM database (no migrations / user table): nothing done')
    admin = db.rows('SELECT id, role, deleted_at IS NULL, username FROM "user" WHERE id = 1')
    if not admin or admin[0][1] != 'admin' or admin[0][2] != 't':
        raise SystemExit('user 1 is not a live admin here: refusing (the owner would be locked out)')
    missing = [f'{t}.{c}' for t, cs in SEEDED_COLUMNS.items() for c in cs if c not in cols.get(t, set())]
    if missing:
        raise SystemExit('the schema differs from what the mock data needs (run the migrations first?): ' + ', '.join(missing))
    migrations = db.rows('SELECT count(*), (SELECT name FROM migrations ORDER BY id DESC LIMIT 1) FROM migrations')[0]
    out(f'now (Asia/Tashkent): {now_text}; migrations applied: {migrations[0]}, last {migrations[1]}')
    out(f'admin kept: user 1 «{admin[0][3]}»; mock logins file: {users_path}')

    before = counts(db, tables)
    out('')
    out(f'{"table":<24} {"rows":>7} {"stay":>6} {"go":>7}  action')
    total_go = 0
    for t in tables:
        n, kept = before[t]
        go = n - kept
        total_go += go
        out(f'{t:<24} {n:>7} {kept:>6} {go:>7}  {action_of(t)}')
    out(f'{"":<24} {"":>7} {"":>6} {total_go:>7}  rows will be deleted')
    unknown = [t for t in tables if t not in KEEP_FULL and t not in PARTIAL and t not in RESET
               and t not in SEEDED_COLUMNS and t not in KNOWN_WIPED]
    if unknown:
        out('tables this script does not know (they are wiped too): ' + ', '.join(unknown))

    # the people that go: the Telegram / WhatsApp / FTP services may still hold sessions of them (by user id)
    staff, contacts = deleted_users(db, cols)
    out('')
    out(f'staff accounts deleted: {len(staff)}. The Telegram / WhatsApp services keep sessions by these ids: disconnect them '
        'in the CRM before the change (after it the API does not know these users any more); FTP folders <root>/<id> stay')
    for uid, role, gone, messengers, bot, tokens, uploads in staff:
        flags = [x for x in (f'messengers {messengers}' if messengers else '', 'CRM bot' if int(bot) else '',
                             f'recorder tokens {tokens}' if int(tokens) else '', f'call uploads {uploads}' if int(uploads) else '',
                             'already deleted' if gone == 't' else '') if x]
        out(f'  user {uid:>6}  {role:<8} {", ".join(flags)}')
    if staff:
        out('  their user ids, to log out of the services: ' + ', '.join(str(r[0]) for r in staff))
    out(f'contacts deleted: {len(contacts)} (ids {ranges(contacts)})')

    # where the mock rows go: the same data as for the run (a first pass only counts the rows of each table)
    probe = Gen(now, args.seed, mailboxes, fake)
    probe.build()
    sizes = {t: len(rows) for t, rows in probe.rows.items()}
    plan = id_plan(db, seqs, sizes)
    out('')
    out('ids of the mock rows (above everything the table ever used; sequences only move forward):')
    for p in plan:
        how = 'the mock range of the last run again' if p['reuse'] else \
            f"new range: highest id so far {p['hwm']} (max(id) {p['max_id']}, sequence {p['pos']})"
        out(f"  {p['table']:<18} {p['base'] + 1:>8}-{p['base'] + p['n']:<8} reserved to {p['top']:<8} {how}")

    if not args.i_have_a_backup and not args.rollback:
        out('')
        out('Refusing to change anything without --i-have-a-backup (make a backup of the database first).')
        out('A dry run that changes nothing: --rollback.')
        sys.exit(2)

    try:
        import bcrypt  # noqa: F401
    except ImportError:
        raise SystemExit('the Python module bcrypt is needed for the passwords (pip install bcrypt): nothing done')
    import bcrypt as bcrypt_mod

    passwords = load_passwords(users_path, [s[2] for s in STAFF], bcrypt_mod)
    gen = Gen(now, args.seed, mailboxes, passwords, {p['table']: p['base'] for p in plan})
    gen.build()
    if {t: len(rows) for t, rows in gen.rows.items()} != sizes:
        raise SystemExit('internal error: the second pass of the generator made other rows than the first: nothing done')

    sql = ['BEGIN;',
           "SET LOCAL lock_timeout = '20s';",
           f"SET LOCAL TIME ZONE {q(TZ_NAME)};",
           "SET LOCAL client_min_messages = notice;",
           '-- nobody writes into the CRM while it is rebuilt (the API waits for the commit)',
           'LOCK TABLE ' + ', '.join(qi(t) for t in tables if t != 'migrations') + ' IN ACCESS EXCLUSIVE MODE;',
           "CREATE TEMP TABLE seed_carry ON COMMIT DROP AS "
           "SELECT (SELECT mail_signature FROM setting ORDER BY id DESC LIMIT 1) AS mail_signature;"]
    sql += ids_check_sql(plan)
    sql += wipe_sql()
    order = ['group', 'user', 'collection', 'deal_stage', 'setting', 'task_type', 'filler', 'product', 'product_filler',
             'company', 'company_filler', 'user_filler', 'deal', 'deal_user', 'deal_product', 'deal_filler',
             'deal_stage_record', 'task', 'notification', 'email', 'email_to', 'email_cc', 'email_read', 'recording',
             'event']
    # staff before their contacts' companies: the company of a contact is written first
    users = gen.rows['user']
    staff_rows = [r for r in users if r['role'] != 'ctr_agent']
    contact_rows = [r for r in users if r['role'] == 'ctr_agent']
    for t in order:
        if t == 'user':
            sql += inserts('user', staff_rows)
            continue
        if t == 'company':
            rows = gen.rows['company']
            primary = {r['id']: r['primary_contact_id'] for r in rows}
            for r in rows:
                r['primary_contact_id'] = None
            sql += inserts('company', rows)
            sql += inserts('user', contact_rows)
            for cid, uid in primary.items():
                if uid:
                    sql.append(f'UPDATE company SET primary_contact_id = {uid} WHERE id = {cid};')
            continue
        sql += inserts(t, gen.rows[t])
    sql += ids_seal_sql(plan)
    sql.append(CHECKS_SQL)
    if args.test_fail:
        sql.append("DO $fail$ BEGIN RAISE EXCEPTION 'test: a failure right before the end of the transaction'; END $fail$;")
    sql.append('ROLLBACK;' if args.rollback else 'COMMIT;')
    text = '\n'.join(sql) + '\n'

    if args.sql_out:
        with open(args.sql_out, 'w', encoding='utf-8') as f:
            f.write(text)
        os.chmod(args.sql_out, 0o600)

    out('')
    wiped_n = len([t for t in tables if t not in KEEP_FULL and t not in PARTIAL])
    out(f'wiping {wiped_n} tables and writing the mock data in one transaction'
        f'{" (dry run: rolled back at the end)" if args.rollback else ""} ...')
    seq_before = seq_state(db)
    code = db.script(text)
    if code != 0 or args.rollback:
        seq_after = seq_state(db)
        changed = compare_seqs(seq_before, seq_after)
        after_counts = counts(db, tables)
        rows_changed = [t for t in tables if after_counts[t][0] != before[t][0]]
        out('')
        if code != 0:
            out(f'FAILED (psql exit {code}): the transaction was rolled back.')
        else:
            out('dry run passed: the wipe, the mock data and the checks worked, then everything was rolled back.')
        if changed:
            out(f'WARNING: {len(changed)} of {len(seq_after)} sequences differ from before the run (another session wrote '
                'meanwhile, or something went wrong):')
            for line in changed:
                out(line)
        else:
            out(f'sequences: all {len(seq_after)} exactly as before (last_value, is_called, comment).')
        out('row counts: ' + ('all tables as before.' if not rows_changed else 'changed meanwhile in ' + ', '.join(rows_changed)))
        sys.exit(1 if code != 0 or changed else 0)
    write_users_file(users_path, passwords, args.db)

    after = counts(db, tables)
    out('')
    out(f'{"table":<24} {"before":>7} {"after":>7}')
    for t in tables:
        out(f'{t:<24} {before[t][0]:>7} {after[t][0]:>7}')
    users_range = next((p for p in plan if p['table'] == 'user'), None)
    if users_range:
        out(f"mock people: user ids {users_range['base'] + 1}-{users_range['base'] + users_range['n']} "
            f"(staff {users_range['base'] + 1}-{users_range['base'] + len(STAFF)}), next new user id > {users_range['top']}")
    out('mock ids: ' + '; '.join(f"{p['table']} {p['base'] + 1}-{p['base'] + p['n']}" for p in plan))
    out('')
    out(f'done. Mock logins (e-mail and password) are in {users_path} (chmod 600); they are not printed here.')
    out('Restart the API now (in-memory caches of the old data): docker restart <api container>.')


# tables the plan knows to wipe (everything not kept, reset or seeded); others are wiped as well, with a note
KNOWN_WIPED = {
    'ai_job', 'ai_usage', 'audit_log', 'bot_link_code', 'bot_reminder', 'call_upload', 'control_notice',
    'conversation_item', 'conversation_turn', 'deal_file', 'deal_number_backup', 'file', 'phone_original',
    'recorder_token', 'telegram_remote_file', 'trigger', 'trigger_run',
    # migration 1795830000000-ai-insights (commit 436230d)
    'deal_inbound', 'conversation_review', 'ai_notice', 'market_mention',
}

if __name__ == '__main__':
    main()
