<script setup lang="ts">
// «Изменить поля»: the responsible, the budget, the name and the custom fields of the deal, several at
// once. The API checks the values on save (a budget is a number, the responsible an employee).
import type { Filler } from '~/types/filler';
import { type ChangeFieldsTrigger, type DealFilter, type Trigger } from '~/types/stage';
import type { User } from '~/types/user';

const props = defineProps<{
  fillers: Filler[];
  employees: User[];
  trigger: Trigger & ChangeFieldsTrigger;
}>();

type Option = { key: string; label: string; field: string; is_filler: boolean; filler_id?: number };
const BASE: Option[] = [
    { key: 'agent_id', label: 'Ответственный', field: 'agent_id', is_filler: false },
    { key: 'budget', label: 'Бюджет', field: 'budget', is_filler: false },
    { key: 'label', label: 'Название сделки', field: 'label', is_filler: false },
];

const fields = computed(() => props.trigger.change_fields_data.fields);
const keyOf = (f: DealFilter) => (f.is_filler ? `filler:${f.filler_id ?? f.field}` : f.field);

// what may still be added: a field is set once
const options = computed<Option[]>(() => {
    const used = new Set(fields.value.map(keyOf));
    const custom = props.fillers.map((f) => ({ key: `filler:${f.id}`, label: f.field, field: f.field, is_filler: true, filler_id: f.id }));
    return [...BASE, ...custom].filter((o) => !used.has(o.key) && !used.has(o.is_filler ? `filler:${o.field}` : o.key));
});

const chosen = ref<Option>();
watch(chosen, () => {
    const option = chosen.value;
    if (!option) return;
    props.trigger.change_fields_data.fields.push({
        field: option.field,
        is_filler: option.is_filler,
        value: '',
        label: option.label,
        // a custom field is kept by id too: renaming the field does not break the trigger
        ...(option.filler_id ? { filler_id: option.filler_id } : {}),
    });
    nextTick(() => (chosen.value = undefined));
});

function labelOf(f: DealFilter): string {
    if (!f.is_filler) return BASE.find((b) => b.field === f.field)?.label ?? f.label ?? f.field;
    return props.fillers.find((x) => x.id === f.filler_id)?.field ?? f.label ?? f.field;
}

function remove(idx: number) {
    props.trigger.change_fields_data.fields.splice(idx, 1);
}
</script>
<template>
    <section class="px-3 pb-3 flex flex-col gap-3">
        <ul v-if="fields.length" class="flex flex-col gap-2 mt-1">
            <li v-for="(field, idx) in fields" :key="keyOf(field) + idx" class="flex items-center gap-2">
                <div class="border border-muted-200 rounded-md flex items-center flex-1 bg-white dark:bg-muted-900 dark:border-muted-700 min-w-0">
                    <span class="text-sm text-muted-700 ms-3 whitespace-nowrap dark:text-muted-200">{{ labelOf(field) }}:</span>
                    <select
                        v-if="field.field === 'agent_id' && !field.is_filler"
                        v-model="field.value"
                        class="w-full bg-transparent px-2 py-2 text-sm outline-none"
                    >
                        <option value="" disabled>Выберите сотрудника</option>
                        <option v-for="employee in employees" :key="employee.id" :value="String(employee.id)">{{ employee.username }}</option>
                    </select>
                    <BaseInput
                        v-else
                        v-model="field.value"
                        :type="field.field === 'budget' && !field.is_filler ? 'number' : 'text'"
                        :placeholder="field.field === 'budget' && !field.is_filler ? 'Сумма' : 'Значение'"
                        :classes="{input: 'border-none !outline-none', wrapper: 'w-full'}"
                    />
                </div>
                <BaseButtonClose size="sm" rounded="full" color="danger" @click="remove(idx)" />
            </li>
        </ul>
        <BaseListbox
            v-if="options.length"
            v-model="chosen"
            :items="options"
            :properties="{value: 'key', label: 'label'}"
            name="fields"
            placeholder="Добавить поле"
            :classes="{input: 'border-dashed', wrapper: 'pr-10'}"
        />
    </section>
</template>
