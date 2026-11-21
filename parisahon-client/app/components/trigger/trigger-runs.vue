<script setup lang="ts">
// The schedule and history of one trigger: GET /stages/:id/triggers/:trigger_id/runs
// (trigger_run rows, newest first). Loaded when opened, refreshed live.
import moment from 'moment';

type Run = {
    id: number;
    deal: { id: number; label: string | null } | null;
    run_at: string;
    executed_at: string | null;
    status: 'pending' | 'done' | 'failed' | 'skipped';
    error: string | null;
};

const props = defineProps<{ stageId: number; triggerId: number }>();
const stagesService = useService('stages', { auth: true });
const { run, data: runs, isLoading, error } = useAsync<Run[]>([]);
const open = ref(false);

const statusMap: Record<Run['status'], { label: string; color: string }> = {
    pending: { label: 'Запланирован', color: 'text-amber-600 dark:text-amber-400' },
    done: { label: 'Выполнен', color: 'text-emerald-600 dark:text-emerald-400' },
    failed: { label: 'Ошибка', color: 'text-rose-600 dark:text-rose-400' },
    skipped: { label: 'Пропущен', color: 'text-muted-500 dark:text-muted-400' },
};

function load() {
    run(stagesService.get(`${props.stageId}/triggers/${props.triggerId}/runs`, { limit: 50 }).exec());
}

function onToggle(e: Event) {
    open.value = (e.target as HTMLDetailsElement).open;
    if (open.value) load();
}

const when = (r: Run) => moment(r.executed_at || r.run_at).format('DD.MM.YYYY HH:mm');

useLive((changes) => { if (open.value && liveTouches(changes, 'triggers')) load(); });
</script>

<template>
    <details class="border-t border-muted-200 dark:border-muted-700" @toggle="onToggle">
        <summary class="px-3 py-2 text-sm cursor-pointer select-none text-muted-600 dark:text-muted-300">История запусков</summary>
        <div class="px-3 pb-3 max-h-64 overflow-y-auto">
            <p v-if="isLoading && !runs.length" class="text-sm text-muted-500">Загрузка…</p>
            <p v-else-if="error" class="text-sm text-rose-600">Не удалось загрузить историю</p>
            <p v-else-if="!runs.length" class="text-sm text-muted-500">Триггер ещё не запускался</p>
            <ul v-else class="divide-y divide-muted-200 dark:divide-muted-700">
                <li v-for="r in runs" :key="r.id" class="py-1.5 text-[13px] leading-snug">
                    <div class="flex items-baseline justify-between gap-2">
                        <NuxtLink v-if="r.deal" :to="`/deals/${r.deal.id}`" class="truncate text-primary-600 dark:text-primary-300 hover:underline">
                            {{ r.deal.label || `Сделка ${r.deal.id}` }}
                        </NuxtLink>
                        <span v-else class="text-muted-500">Сделка удалена</span>
                        <span class="shrink-0" :class="statusMap[r.status]?.color">{{ statusMap[r.status]?.label ?? r.status }}</span>
                    </div>
                    <div class="flex justify-between gap-2 text-muted-500 dark:text-muted-400">
                        <span>{{ r.status === 'pending' ? 'Запуск в ' : '' }}{{ when(r) }}</span>
                    </div>
                    <p v-if="r.error" class="text-muted-500 dark:text-muted-400 break-words">{{ r.error }}</p>
                </li>
            </ul>
        </div>
    </details>
</template>
