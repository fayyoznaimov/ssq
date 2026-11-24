<template>
    <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm text-muted-500 dark:text-muted-400">Шаблон:</span>
            <BaseButton
                v-for="template in templates"
                :key="template.key"
                type="button"
                size="sm"
                :color="currentTemplate === template.key ? 'primary' : 'default'"
                @click="applyTemplate(template.levels)"
            >
                {{ template.label }}
            </BaseButton>
        </div>
        <div class="rounded-md border border-muted-200 dark:border-muted-700 divide-y divide-muted-200 dark:divide-muted-700">
            <div class="hidden md:grid grid-cols-5 gap-3 px-4 py-2 text-xs font-semibold text-muted-500 dark:text-muted-400">
                <span>Раздел</span>
                <span v-for="action in actions" :key="action.key">{{ action.label }}</span>
            </div>
            <div
                v-for="entity in entities"
                :key="entity.key"
                class="grid grid-cols-2 md:grid-cols-5 gap-x-3 gap-y-2 px-4 py-3 md:items-center"
            >
                <h5 class="col-span-2 md:col-span-1 text-sm font-semibold text-muted-800 dark:text-muted-100">
                    {{ entity.label }}
                </h5>
                <template v-for="action in actions" :key="action.key">
                    <!-- tasks have no levels to see or set: every employee sets them and sees their own, their
                         group's and those of the deals and clients open to them (API: task/task-access.ts) -->
                    <div
                        v-if="entity.key === 'task' && (action.key === 'view' || action.key === 'create')"
                        class="flex flex-col gap-1"
                    >
                        <span class="text-xs text-muted-500 dark:text-muted-400 md:hidden">{{ action.label }}</span>
                        <span class="text-xs text-muted-500 dark:text-muted-400">
                            {{ action.key === 'view' ? 'Свои, группы и по открытым сделкам и клиентам' : 'Да, у всех' }}
                        </span>
                    </div>
                    <BaseSelect
                        v-else
                        size="sm"
                        :label="action.label"
                        :name="`${entity.key}-${action.key}`"
                        :classes="{label: 'md:sr-only'}"
                        :model-value="level(entity.key, action.key)"
                        @update:model-value="setLevel(entity.key, action.key, $event)"
                    >
                        <option
                            v-for="option in optionsOf(action.key)"
                            :key="option.value"
                            :value="option.value"
                        >
                            {{ option.label }}
                        </option>
                    </BaseSelect>
                </template>
            </div>
        </div>
        <p class="text-xs text-muted-500 dark:text-muted-400">
            «Свои» — сделки, где сотрудник ответственный; компании и контакты, которые он создал или которые связаны с
            его сделками; задачи, которые он поставил или которые на нём. «Группы» — то же для всех сотрудников его
            группы. «Все» — без ограничений. Изменить и удалить можно только то, что видно.
        </p>
    </div>
</template>

<script lang="ts" setup>
import { STANDARD_PERMISSIONS } from '~/utils/casl';

type Levels = Record<string, Record<string, number>>;

const props = defineProps<{
    /** user.permissions: a level per section and action (0 nothing, 1 own, 2 group, 3 all; create: 0 or 3) */
    permissions?: Levels | null;
}>();

const emit = defineEmits<{ 'update:permissions': [value: Levels] }>();

const entities = [
    {key: 'deal', label: 'Сделки'},
    {key: 'company', label: 'Компании'},
    {key: 'contact', label: 'Контакты'},
    {key: 'task', label: 'Задачи'},
];

const actions = [
    {key: 'view', label: 'Просмотр'},
    {key: 'create', label: 'Создание'},
    {key: 'update', label: 'Правка'},
    {key: 'delete', label: 'Удаление'},
];

const scopeOptions = [
    {value: 0, label: 'Нет'},
    {value: 1, label: 'Свои'},
    {value: 2, label: 'Группы'},
    {value: 3, label: 'Все'},
];

// creating is either allowed or not: the API reads any level above 0 as «yes» (src/auth/access.ts)
const createOptions = [
    {value: 0, label: 'Нет'},
    {value: 3, label: 'Да'},
];

function optionsOf(action: string) {
    return action === 'create' ? createOptions : scopeOptions;
}

/** A whole set of levels: view and change at one level, creating allowed, deleting not. */
function templateOf(scope: number): Levels {
    const row = {view: scope, create: 3, update: scope, delete: 0, export: 0};
    return {deal: {...row}, company: {...row}, contact: {...row}, task: {update: scope, delete: 0}};
}

const templates = [
    {key: 'standard', label: 'Стандартные: свои записи', levels: STANDARD_PERMISSIONS as Levels},
    {key: 'group', label: 'Записи группы', levels: templateOf(2)},
    {key: 'all', label: 'Все записи', levels: templateOf(3)},
];

function level(entity: string, action: string): number {
    const value = props.permissions?.[entity]?.[action];
    if (typeof value !== 'number') return 0;
    // creating: any level above 0 allows it, as the API reads it
    return action === 'create' ? (value > 0 ? 3 : 0) : value;
}

function copy(): Levels {
    return JSON.parse(JSON.stringify(props.permissions ?? {}));
}

function setLevel(entity: string, action: string, value: number | string) {
    const next = copy();
    next[entity] = {...(next[entity] ?? {}), [action]: Number(value)};
    emit('update:permissions', next);
}

/** The levels of a template; the mail / file switches (outside the matrix) stay as they are. */
function applyTemplate(levels: Levels) {
    const next = copy();
    for (const [entity, values] of Object.entries(levels)) {
        next[entity] = {...(next[entity] ?? {}), ...values};
    }
    emit('update:permissions', next);
}

/** The template the current levels match, to mark its button. */
const currentTemplate = computed(() => {
    const matches = (levels: Levels) => Object.entries(levels).every(([entity, values]) =>
        Object.entries(values).every(([action, value]) => action === 'export' || level(entity, action) === value));
    return templates.find((template) => matches(template.levels))?.key ?? null;
});
</script>
