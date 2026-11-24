<template>
    <!-- «История событий»: days → operations (one save: who, when, from where) → objects → attributes «было → стало»;
         a business event in one line between them. `compact`: a narrow column of a card (the attributes one under
         another), otherwise a table of attributes from a tablet up. -->
    <div class="flex flex-col gap-5">
        <section v-for="day in days" :key="day.key" class="flex flex-col gap-2">
            <h3 class="sticky top-0 z-[1] bg-white/90 py-1 text-sm font-semibold text-muted-700 backdrop-blur dark:bg-muted-900/90 dark:text-muted-200">
                {{ day.label }}
            </h3>
            <ul class="flex flex-col gap-2">
                <li
                    v-for="block in day.blocks"
                    :key="block.key + block.at"
                    :class="block.type === 'operation'
                        ? 'rounded-lg border border-muted-200 bg-white p-3 dark:border-muted-700 dark:bg-muted-800'
                        : 'rounded-lg px-3 py-2 hover:bg-muted-50 dark:hover:bg-muted-800/60'"
                >
                    <!-- an operation of the journal of changes -->
                    <template v-if="block.type === 'operation'">
                        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                            <Icon
                                :name="block.automation ? 'ph:robot' : 'ph:user-circle'"
                                class="size-5 shrink-0 text-muted-400"
                            />
                            <NuxtLink
                                v-if="block.whoLink && isAdmin"
                                :to="block.whoLink"
                                class="font-semibold text-muted-800 hover:underline dark:text-muted-100"
                            >{{ block.who }}</NuxtLink>
                            <span v-else class="font-semibold text-muted-800 dark:text-muted-100">{{ block.who }}</span>
                            <span v-if="block.deleted" class="text-xs text-muted-500">(удалён)</span>
                            <span
                                v-if="block.sourceLabel"
                                class="rounded-full bg-warning-500/15 px-2 py-0.5 text-xs font-medium text-warning-700 dark:bg-warning-500/20 dark:text-warning-300"
                                :title="block.sourceText ?? ''"
                            >{{ block.sourceLabel }}</span>
                            <span class="ms-auto tabular-nums text-muted-500" :title="new Date(block.at).toLocaleString('ru')">{{ hhmm(block.at) }}</span>
                        </div>
                        <p v-if="block.causedBy" class="mt-0.5 text-xs text-muted-500 dark:text-muted-400">
                            после действия: {{ block.causedBy }}
                        </p>
                        <div
                            v-for="item in block.items"
                            :key="item.id"
                            class="mt-3 first:mt-2"
                        >
                            <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                <span class="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium" :class="TONE_CLASSES[actionTone(item)]">
                                    {{ item.action_text }}
                                </span>
                                <NuxtLink
                                    v-if="item.link && item.link !== currentPath"
                                    :to="item.link"
                                    class="min-w-0 break-words font-medium text-primary-600 underline-offset-2 hover:underline dark:text-primary-300"
                                >{{ item.object }}</NuxtLink>
                                <span v-else class="min-w-0 break-words font-medium text-muted-800 dark:text-muted-100">{{ item.object }}</span>
                            </div>
                            <!-- the attributes: «Бюджет: 10 000 → 12 000» -->
                            <dl v-if="item.fields.length" class="mt-1.5 text-sm" :class="compact ? 'flex flex-col gap-1.5' : 'audit-table'">
                                <div
                                    v-for="field in item.fields"
                                    :key="field.field"
                                    :class="compact ? 'flex flex-col' : 'audit-row'"
                                >
                                    <dt class="text-muted-500 dark:text-muted-400">{{ field.label }}</dt>
                                    <dd class="min-w-0 break-words text-muted-800 dark:text-muted-100">
                                        <!-- a new, removed or shown-once object: its value; a change: «было → стало» -->
                                        <template v-if="isWhole(item) || field.single">
                                            <span :class="field.after !== null ? 'font-medium' : 'text-muted-600 dark:text-muted-300'">{{ field.after ?? field.before ?? '—' }}</span>
                                        </template>
                                        <template v-else>
                                            <span class="text-muted-500 dark:text-muted-400">{{ field.before ?? '—' }}</span>
                                            <Icon name="ph:arrow-right" class="mx-1 inline size-3.5 align-[-2px] text-muted-400" />
                                            <span class="font-medium">{{ field.after ?? '—' }}</span>
                                        </template>
                                        <span v-if="field.delta" class="ms-1.5 whitespace-nowrap text-xs text-muted-500 dark:text-muted-400">({{ field.delta }})</span>
                                    </dd>
                                </div>
                            </dl>
                        </div>
                    </template>
                    <!-- a business event: a message, a call, a letter, a task… -->
                    <template v-else>
                        <div class="flex gap-3 text-sm">
                            <span class="w-11 shrink-0 tabular-nums text-muted-500">{{ hhmm(block.at) }}</span>
                            <div class="min-w-0 flex-1">
                                <p class="flex flex-wrap items-center gap-x-2">
                                    <span class="font-medium text-muted-800 dark:text-muted-100">{{ block.title }}</span>
                                    <span
                                        v-if="block.sourceLabel"
                                        class="rounded-full bg-warning-500/15 px-2 py-0.5 text-xs font-medium text-warning-700 dark:bg-warning-500/20 dark:text-warning-300"
                                    >{{ block.sourceLabel }}</span>
                                    <span class="text-muted-500 dark:text-muted-400">{{ block.who }}</span>
                                </p>
                                <p v-if="block.object" class="break-words">
                                    <NuxtLink
                                        v-if="block.link && block.link !== currentPath"
                                        :to="block.link"
                                        class="text-primary-600 underline-offset-2 hover:underline dark:text-primary-300"
                                    >{{ block.object }}</NuxtLink>
                                    <span v-else class="text-muted-600 dark:text-muted-300">{{ block.object }}</span>
                                </p>
                                <p v-if="block.before || block.after" class="break-words text-muted-700 dark:text-muted-200">
                                    <template v-if="block.before">
                                        <span class="text-muted-500 dark:text-muted-400">{{ block.before }}</span>
                                        <Icon name="ph:arrow-right" class="mx-1 inline size-3.5 align-[-2px] text-muted-400" />
                                    </template>{{ block.after }}
                                </p>
                            </div>
                        </div>
                    </template>
                </li>
            </ul>
        </section>
    </div>
</template>

<script setup lang="ts">
import { type AuditChange, type AuditDay, TONE_CLASSES, actionTone, hhmm } from './audit';

withDefaults(defineProps<{
    days: AuditDay[];
    /** a narrow column (the cards): attributes one under another */
    compact?: boolean;
}>(), {
    compact: false,
});

const route = useRoute();
const currentPath = computed(() => route.path);
const user = useState<any>('user');
// the employee's card (/settings/users/:id) opens for the admin only
const isAdmin = computed(() => user.value?.role === 'admin');

/** Shown with its values, not as «было → стало»: created, removed, a login, a messenger connected… */
function isWhole(item: AuditChange): boolean {
    return ['insert', 'delete', 'baseline', 'login', 'logout', 'login_failed'].includes(item.action)
        || item.entity === 'messenger' || item.entity === 'file_link';
}
</script>

<style scoped>
/* from a tablet up: «Реквизит | было → стало» as two aligned columns */
.audit-table {
    display: grid;
    grid-template-columns: minmax(9rem, max-content) minmax(0, 1fr);
    column-gap: 1rem;
    row-gap: 0.35rem;
}
.audit-row {
    display: contents;
}
@media (max-width: 639px) {
    .audit-table {
        grid-template-columns: minmax(0, 1fr);
        row-gap: 0.15rem;
    }
    .audit-row > dd {
        margin-bottom: 0.4rem;
    }
}
</style>
