<template>
    <ul v-if="items.length" class="mt-1 flex flex-col gap-0.5">
        <li v-for="item in items" :key="item.id" class="flex min-w-0 items-start gap-1.5 text-xs text-muted-500 dark:text-muted-400" :title="item.ref.excerpt">
            <Icon :name="CHANNELS[item.ref.channel]?.icon ?? 'ph:chat-text'" class="mt-0.5 size-3.5 shrink-0" :class="CHANNELS[item.ref.channel]?.color" />
            <span class="min-w-0 flex-1 break-words line-clamp-2">
                <span class="text-muted-400">{{ WHO[item.ref.from] ?? '' }}, {{ stamp(item.ref.at) }}:</span>
                «{{ item.ref.excerpt }}»
            </span>
        </li>
    </ul>
</template>

<script lang="ts" setup>
/**
 * The messages an AI statement is based on (the ids the API checked against the deal): who wrote,
 * when, in which channel, and the beginning of the text. Ids the reader may not see (a letter without
 * the "mail" right) have no entry in `refs` and are not shown.
 */
import moment from 'moment';

import type { AiMessageRef } from '~/composables/useDealAi';

const props = defineProps<{ ids: (number | null | undefined)[]; refs: Record<string, AiMessageRef> }>();

const CHANNELS: Record<string, { icon: string; color: string }> = {
    telegram: { icon: 'ph:telegram-logo', color: 'text-sky-500' },
    whatsapp: { icon: 'ph:whatsapp-logo', color: 'text-emerald-500' },
    email: { icon: 'ph:envelope-simple', color: 'text-muted-400' },
    note: { icon: 'ph:note-pencil', color: 'text-muted-400' },
};
const WHO: Record<string, string> = { client: 'клиент', manager: 'менеджер', note: 'заметка' };

const items = computed(() =>
    [...new Set(props.ids.filter((id): id is number => typeof id === 'number'))]
        .map((id) => ({ id, ref: props.refs?.[String(id)] }))
        .filter((item): item is { id: number; ref: AiMessageRef } => !!item.ref)
        .slice(0, 3),
);

function stamp(value: string): string {
    const m = moment(value);
    if (!m.isValid()) return '';
    return m.isSame(moment(), 'day') ? m.format('HH:mm') : m.format('DD.MM HH:mm');
}
</script>
