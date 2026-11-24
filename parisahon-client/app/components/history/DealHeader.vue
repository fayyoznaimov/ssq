<template>
    <!-- Under the name of the deal (DEAL-14): its number, the stage and how long it has been there, where it came
         from, «клиент ждёт ответа» in red when the client wrote last, the earlier deal of a repeat client, and
         why a lost deal was lost (DEAL-11). GET /deals/:id/summary. -->
    <div v-if="summary" class="flex flex-col gap-1.5 text-[13px] text-muted-600 dark:text-muted-300">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span class="font-medium text-muted-800 dark:text-muted-100">№ {{ summary.display_id }}</span>
            <span v-if="summary.stage" class="inline-flex min-w-0 max-w-full items-center gap-1.5">
                <StageName :name="summary.stage.name" :color="summary.stage.color" />
                <span class="whitespace-nowrap" :title="'на этапе с ' + formatDateTime(summary.stage_since)">на этапе {{ daysText(summary.days_in_stage) }}</span>
            </span>
            <span class="inline-flex items-center gap-1 whitespace-nowrap" title="Откуда пришла сделка">
                <Icon :name="source.icon" class="size-4" />{{ source.label }}
            </span>
            <span
                v-if="summary.waiting"
                class="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-danger-500 px-2 py-0.5 text-xs font-semibold text-white"
                :title="'Последним написал клиент: ' + formatDateTime(summary.waiting.since)"
            >
                <Icon name="ph:hourglass-medium" class="size-3.5" />клиент ждёт ответа {{ waitText(summary.waiting.minutes) }}
            </span>
        </div>
        <p v-if="summary.repeat_of" class="flex flex-wrap items-center gap-1">
            <Icon name="ph:arrows-clockwise" class="size-4" />Повторное обращение, раньше:
            <NuxtLink :to="'/deals/' + summary.repeat_of.id" class="underline hover:text-primary-600 dark:hover:text-primary-300">
                № {{ summary.repeat_of.display_id }}<template v-if="summary.repeat_of.label"> «{{ summary.repeat_of.label }}»</template>
            </NuxtLink>
        </p>
        <p v-if="lost" class="flex flex-wrap items-center gap-1">
            <Icon name="ph:x-circle" class="size-4 text-danger-500" />
            <template v-if="summary.lost_reason">
                Причина: <span class="font-medium text-muted-800 dark:text-muted-100">{{ summary.lost_reason }}</span>
                <span v-if="summary.lost_comment" class="break-words">— {{ summary.lost_comment }}</span>
                <button v-if="canEdit" type="button" class="ms-1 underline hover:text-primary-600 dark:hover:text-primary-300" @click="emit('ask-lost')">изменить</button>
            </template>
            <template v-else>
                Причина проигрыша не указана
                <button v-if="canEdit" type="button" class="ms-1 underline text-primary-600 dark:text-primary-300" @click="emit('ask-lost')">указать</button>
            </template>
        </p>
    </div>
</template>

<script setup lang="ts">
import { formatDateTime } from '~/utils/format';
import StageName from './StageName.vue';
import { type DealSummary, SOURCE_LABELS, daysText, waitText } from './history';

const props = withDefaults(defineProps<{ summary: DealSummary | null; canEdit?: boolean }>(), { canEdit: true });
const emit = defineEmits<{ (e: 'ask-lost'): void }>();

const source = computed(() => SOURCE_LABELS[props.summary?.source ?? 'manual'] ?? SOURCE_LABELS.manual);
const lost = computed(() => props.summary?.stage?.kind === 'lost');
</script>
