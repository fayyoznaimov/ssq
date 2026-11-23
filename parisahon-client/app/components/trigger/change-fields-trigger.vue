<script setup lang="ts">
import type { Filler } from '~/types/filler';
import { type ChangeFieldsTrigger,type Trigger } from '~/types/stage';

const props = defineProps<{
  fillers: Filler[];
  trigger: Trigger & ChangeFieldsTrigger;
}>();

const fillers = ref<(Filler & {hidden?: boolean})[]>(props.fillers);

watchEffect(() => {
    fillers.value = props.fillers;
});

const filler = ref<Filler>();

watch(filler, () => {
    if (!filler.value) return;

    const chosen = filler.value;
    props.trigger.change_fields_data.fields.push({
        field: chosen.field,
        is_filler: true,
        value: '',
        label: chosen.field,
        // kept by id too: renaming the field does not break the trigger
        filler_id: chosen.id,
    });

    // the chosen field is not offered twice; the others stay
    fillers.value = fillers.value.map((f) => f.id === chosen.id ? ({...f, hidden: true}) : f);
    filler.value = undefined;
});

const visibleFillers = computed(() => {
    return fillers.value.filter((f) => !f.hidden);
});

function onFillerRemove(idx: number) {
    const deleted = props.trigger.change_fields_data.fields.splice(idx, 1);
    if (deleted.length > 0) {
        const filler = deleted[0];
        fillers.value = fillers.value.map((f) => f.field === filler.field ? ({...f, hidden: false}) : f);
    }
}

</script>
<template>
    <section class="px-3 pb-3 flex flex-col gap-3">
        <ul v-if="trigger.change_fields_data.fields.length" class="flex flex-col gap-2 mb-2 mt-1">
            <li v-for="(filter, idx) in trigger.change_fields_data.fields" class="flex items-center gap-2">
                <div class="border border-muted-200 rounded-md flex items-center flex-1 bg-white">
                    <input type="hidden" name="dealFilters" :value="filter.field" />
                    <input v-if="filter.is_filler" type="hidden" :name="`dealFilters.${filter.field}.isFiller`">
                    <span class="text-sm text-muted-700 ms-3 whitespace-nowrap"> 
                        {{ filter.label }}
                    </span>
                    <BaseInput :name="filter.field" v-model="filter.value" :classes="{input: 'border-none !outline-none', wrapper: 'w-full'}" />
                </div>
                <BaseButtonClose size="sm" rounded="full" color="danger" @click="onFillerRemove(idx)" />
            </li>
        </ul>
        <BaseListbox 
            v-if="visibleFillers.length > 0"
            v-model="filler"
            :items="visibleFillers"
            :properties="{value: 'id', label: 'field'}"
            name="fields"
            required
            placeholder="Выберите поля"
        />
    </section>
</template>