/**
 * Helpers of the history feed (EventsList.vue, EventDate.vue): who, when, which channel, and the
 * field changes in words instead of column names.
 */
import { DealEventType } from '~/types/deal';

/** Types the web client has no enum member for yet (src/events/event.entity.ts of the API). */
export const EVENT_TASK_UPDATE = 17;
export const EVENT_MOVED = 18;

export type Channel = 'telegram' | 'whatsapp' | 'email';

export const CHANNELS: Record<Channel, { label: string; icon: string; color: string }> = {
    telegram: { label: 'Telegram', icon: 'ph:telegram-logo', color: 'text-sky-600 dark:text-sky-400' },
    whatsapp: { label: 'WhatsApp', icon: 'ph:whatsapp-logo', color: 'text-emerald-600 dark:text-emerald-400' },
    email: { label: 'Почта', icon: 'ph:envelope-simple', color: 'text-primary-600 dark:text-primary-300' },
};

/** The conversation an event belongs to: messages in a row of one channel are one block of the feed. */
export function channelOf(event: any): Channel | null {
    switch (event?.type) {
        case DealEventType.NewTelegramMessage:
        case DealEventType.NewTelegramCall:
            return 'telegram';
        case DealEventType.NewWhatsAppMessage:
            return 'whatsapp';
        case DealEventType.NewEmail:
            return 'email';
        default:
            return null;
    }
}

/** Telegram / WhatsApp rows keep the message in after_state itself, older ones in after_state.data. */
export function stateOf(event: any): Record<string, any> {
    const state = event?.after_state ?? {};
    if (state.message === undefined && state.files === undefined && state.data && typeof state.data === 'object') {
        return state.data;
    }
    return state;
}

/** Written by the manager (true) or by the client (false). */
export function isOutgoing(event: any): boolean {
    if (event?.type === DealEventType.NewEmail) {
        const mail = event.after_state?.data;
        return (mail?.outgoing ?? event.outgoing) !== false;
    }
    const state = stateOf(event);
    return (state.outgoing ?? event?.outgoing) !== false;
}

/**
 * One message that went into several deals (a company's or a contact's feed shows all their deals):
 * the same key, shown once.
 */
export function messageKey(event: any): string | null {
    switch (event?.type) {
        case DealEventType.NewTelegramMessage:
            return event.tg_message_id
                ? `tg:${event.tg_message_id}:${isOutgoing(event)}:${event.originated_by?.id ?? ''}:${event.target_user?.id ?? ''}`
                : null;
        case DealEventType.NewWhatsAppMessage:
            return event.external_id ? `wa:${event.external_id}:${isOutgoing(event)}` : null;
        case DealEventType.NewEmail: {
            const id = event.after_state?.data?.id;
            return id ? `mail:${id}` : null;
        }
        case DealEventType.NewCallRecording:
        case DealEventType.NewTelegramCall: {
            const path = event.after_state?.path;
            // without the signature of the link (it changes every hour): the same call is one row
            return path ? `call:${String(path).split('?')[0]}` : null;
        }
        default:
            return null;
    }
}

/** A person of the feed: the name; an account deleted since is said to be deleted. */
export function personName(user: any): string {
    if (!user) return '—';
    const name = user.username || (user.id ? `#${user.id}` : '—');
    return user.deleted_at ? `${name} (удалён)` : name;
}

export function eventTime(event: any): number {
    const time = new Date(event?.created_at ?? 0).getTime();
    return Number.isNaN(time) ? 0 : time;
}

/** The local day of a moment: the key of the day separators. */
export function dayKey(value: string | number | Date): string {
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** «Сегодня», «Вчера», «Понедельник, 23 ноября», with the year for another year. */
export function dayLabel(value: string | number | Date): string {
    const date = new Date(value);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (dayKey(date) === dayKey(today)) return 'Сегодня';
    if (dayKey(date) === dayKey(yesterday)) return 'Вчера';
    const text = date.toLocaleDateString('ru', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
    });
    return text.charAt(0).toUpperCase() + text.slice(1);
}

export function timeOf(value: string | number | Date | null | undefined): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}

export function dateTimeOf(value: string | number | Date | null | undefined): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** 61825 ms -> «1:02» */
export function durationOf(ms: number | string | null | undefined): string {
    const total = Math.round(Number(ms ?? 0) / 1000);
    if (!Number.isFinite(total) || total <= 0) return '';
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

const FIELD_LABELS: Record<string, string> = {
    label: 'Название',
    budget: 'Бюджет',
    agent_id: 'Ответственный',
    quantity: 'Количество товара',
    price: 'Цена товара',
    name: 'Название',
    username: 'Имя',
    email: 'E-mail',
    phone: 'Телефон',
    tg_user_id: 'Telegram',
    is_old: 'Старый клиент',
    inn: 'ИНН',
    legal_address: 'Юридический адрес',
    bank_account: 'Расчётный счёт',
    bank_name: 'Банк',
    mfo: 'МФО',
    oked: 'ОКЭД',
    director: 'Директор',
    // why a lost deal was lost (PATCH /deals/:id/lost, DEAL-11)
    lost_reason: 'Причина проигрыша',
};

const FIELD_OF: Record<string, string> = {
    company: 'Компания',
    user: 'Контакт',
    product: 'Товар',
};

/** «Компания · ИНН», «Бюджет», «Полотенце 70×140 · Количество товара», a custom field by its own name. */
export function fieldLabel(field: string | null | undefined, fieldOf?: string | null, subject?: string | null): string {
    const label = (field && FIELD_LABELS[field]) || field || 'Поле';
    const owner = subject || (fieldOf ? FIELD_OF[fieldOf] : '');
    return owner ? `${owner} · ${label}` : label;
}

/** A value of a field change in words: «—» for none, «да» / «нет», the name of a responsible. */
export function fieldValue(field: string | null | undefined, value: unknown, label?: string | null): string {
    if (value === null || value === undefined || value === '' || value === 'null' || value === 'undefined') return '—';
    if (field === 'agent_id') return label || `сотрудник №${value}`;
    if (field === 'is_old') return value === 'true' || value === true ? 'да' : value === 'false' || value === false ? 'нет' : String(value);
    if (field === 'budget' || field === 'price') {
        const number = Number(value);
        // a budget of -1 is how the deal form stored «no budget»
        if (field === 'budget' && number < 0) return 'не указан';
        if (Number.isFinite(number)) return number.toLocaleString('ru');
    }
    return String(value);
}

/**
 * A stage chip: its colour as the background and a text that can be read on it (grey text on the
 * yellow «ПРЕДОПЛАТА» was 1.7:1). Dark text on light colours, white on dark ones.
 */
export function stageStyle(color: string | null | undefined): Record<string, string> {
    const hex = String(color ?? '').trim().replace(/^#/, '');
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    if (!/^[0-9a-f]{6}$/i.test(full)) return {};
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return { 'background-color': `#${full}`, color: luminance > 0.2 ? '#1f2937' : '#ffffff' };
}

/** A note (comment) with nothing in it: no text, no files, no trace of removed files. */
export function isEmptyNote(event: any): boolean {
    if (event?.type !== DealEventType.NewComment) return false;
    const data = event.after_state?.data ?? {};
    return !String(data.comment ?? '').trim() && !(data.files?.length) && !(data.removed_files?.length) && event.id > 0;
}

/** How a file of a message is shown: played, seen or downloaded. */
export function mediaKind(file: any): 'audio' | 'image' | 'video' | 'link' {
    const type = String(file?.type ?? '').toLowerCase();
    // a signed path ("a.ogg?e=…&s=…", FileLink of the API): the extension is before the "?"
    const name = String(file?.path || file?.name || '').split('?')[0].toLowerCase();
    if (type === 'link' || file?.remote) return 'link';
    if (type === 'voice' || type === 'audio') return 'audio';
    if (type === 'photo') return 'image';
    if (type === 'video' || type === 'video_note') return 'video';
    // a sticker, or a file without a type (sent from the CRM): by the extension
    if (type === 'sticker' || !type) {
        if (/\.(webp|png|jpe?g|gif)$/.test(name)) return 'image';
        if (/\.(webm|mp4)$/.test(name)) return 'video';
        if (!type && /\.(ogg|oga|opus|mp3|m4a|wav)$/.test(name)) return 'audio';
    }
    return 'link';
}

/** A place sent in Telegram: {latitude, longitude} -> a map. */
export function mapLink(location: any): string | null {
    const lat = Number(location?.latitude);
    const lng = Number(location?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return `https://www.google.com/maps?q=${lat},${lng}`;
}

/** «Ответственный: Анна → Олег»: what a task change changed. */
export function taskChanges(before: any, after: any): string[] {
    if (!before || !after) return [];
    const out: string[] = [];
    if ((before.label ?? '') !== (after.label ?? '')) out.push(`текст: «${before.label ?? ''}» → «${after.label ?? ''}»`);
    const start = (x: any) => (x?.start_time ? new Date(x.start_time).getTime() : null);
    const end = (x: any) => (x?.end_time ? new Date(x.end_time).getTime() : null);
    if (start(before) !== start(after) || end(before) !== end(after)) {
        out.push(`срок: ${dateTimeOf(before.end_time || before.start_time) || '—'} → ${dateTimeOf(after.end_time || after.start_time) || '—'}`);
    }
    const who = (x: any) => x?.agent?.username || x?.group?.name || '';
    if ((before.agent?.id ?? null) !== (after.agent?.id ?? null) || (before.group?.id ?? null) !== (after.group?.id ?? null)) {
        out.push(`исполнитель: ${who(before) || '—'} → ${who(after) || '—'}`);
    }
    if ((before.type?.id ?? null) !== (after.type?.id ?? null)) out.push(`тип: ${before.type?.name ?? '—'} → ${after.type?.name ?? '—'}`);
    const link = (x: any) => x?.deal?.label || x?.company?.name || x?.ctr_agent?.username || '';
    if (link(before) !== link(after)) out.push(`привязка: ${link(before) || '—'} → ${link(after) || '—'}`);
    return out;
}

export const MOVED_WHAT: Record<number, string> = {
    [DealEventType.NewEmail]: 'письмо',
    [DealEventType.NewTelegramMessage]: 'сообщение Telegram',
    [DealEventType.NewWhatsAppMessage]: 'сообщение WhatsApp',
};
