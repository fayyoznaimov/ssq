import moment from 'moment';

import { russianDecline } from '~/utils/text';

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** "1 задача", "3 задачи", "10 задач" */
export function tasksCount(n: number): string {
    return `${n} ${russianDecline(n, 'задача', 'задачи', 'задач')}`;
}

/**
 * When a task is, short and without seconds: "сегодня 15:00", "завтра 10:00", "вчера 18:30",
 * "пт 21.11 15:00" (this year), "21.11.2025 15:00"; an all-day task: the day only.
 */
export function taskWhen(value: string | Date | null | undefined, allDay = false): string {
    if (!value) return '—';
    const at = moment(value);
    if (!at.isValid()) return '—';
    const today = moment().startOf('day');
    const day = at.clone().startOf('day');
    const diff = day.diff(today, 'days');
    let date: string;
    if (diff === 0) date = 'сегодня';
    else if (diff === 1) date = 'завтра';
    else if (diff === -1) date = 'вчера';
    else if (at.year() === today.year()) date = `${WEEKDAYS[at.day()]} ${at.format('DD.MM')}`;
    else date = at.format('DD.MM.YYYY');
    return allDay ? date : `${date} ${at.format('HH:mm')}`;
}

/** An open task whose deadline has passed. */
export function isTaskOverdue(task: { end?: string; end_time?: string; closed_at?: string | null }): boolean {
    const end = task.end ?? task.end_time;
    return !task.closed_at && !!end && moment(end).isBefore(moment());
}

/** "просрочено на 3 дня", "просрочено на 5 ч", "просрочено" (less than an hour); '' when not overdue. */
export function overdueText(task: { end?: string; end_time?: string; closed_at?: string | null }): string {
    if (!isTaskOverdue(task)) return '';
    const end = moment(task.end ?? task.end_time);
    const days = moment().diff(end, 'days');
    if (days >= 1) return `просрочено на ${days} ${russianDecline(days, 'день', 'дня', 'дней')}`;
    const hours = moment().diff(end, 'hours');
    if (hours >= 1) return `просрочено на ${hours} ч`;
    return 'просрочено';
}

/** The client of a task in one line: the deal (without the word «Сделка»), else the contact, else the company. */
export function taskSubject(task: Record<string, any>): string {
    if (task.deal?.label) return task.deal.label;
    if (task.ctr_agent?.username) return task.ctr_agent.username;
    if (task.company?.name) return task.company.name;
    return '';
}
