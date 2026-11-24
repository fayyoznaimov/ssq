<script setup lang="ts">
// «Создать сделку»: a copy of the deal in another stage, of this pipeline or another one (production).
// The copy takes the client, company, responsible, budget and, unless unticked, the custom fields and
// the products; both deals get a note in their history with the number of the other one.
import { type CreateDealTrigger, type Stage, type Trigger } from '~/types/stage';
import { type AnyStage } from './trigger';

const props = defineProps<{
  trigger: Trigger & CreateDealTrigger;
  stages: Stage[];
  stage: Stage;
}>();

type Item = { id: number; label: string };
const triggersService = useService('triggers', { auth: true });
const { run, data: allStages, isLoading } = useAsync<AnyStage[]>([]);

// the stages of every pipeline (GET /triggers/stages); before they load, the stages of this one
const targets = computed<Item[]>(() => {
    const list: AnyStage[] = allStages.value.length
        ? allStages.value
        : props.stages.filter((s) => s.id > 0).map((s) => ({ id: s.id, name: s.name, collection_id: s.collection_id ?? null, collection: null, is_active: true }));
    const many = new Set(list.map((s) => s.collection_id)).size > 1;
    return list
        .filter((s) => s.id !== props.stage.id)
        .map((s) => ({ id: s.id, label: many && s.collection ? `${s.collection} — ${s.name}` : s.name }));
});
const target = ref<Item>();
watchEffect(() => {
    // the saved stage, with the full label once every pipeline's stages are loaded
    const found = targets.value.find((s) => s.id === props.trigger.create_deal_data.stage_id);
    if (found && (!target.value || (target.value.id === found.id && target.value.label !== found.label))) target.value = found;
});
watch(target, () => {
    if (target.value) props.trigger.create_deal_data.stage_id = target.value.id;
});

const copyFields = ref(props.trigger.create_deal_data.copy_fields !== false);
const copyProducts = ref(props.trigger.create_deal_data.copy_products !== false);
watch([copyFields, copyProducts], () => {
    props.trigger.create_deal_data.copy_fields = copyFields.value;
    props.trigger.create_deal_data.copy_products = copyProducts.value;
}, { immediate: true });

onMounted(() => run(triggersService.get('stages').exec()));
</script>
<template>
    <section class="px-3 pb-3 flex flex-col gap-3 pr-[3.25rem]">
        <BaseListbox
            v-model="target"
            :items="targets"
            :loading="isLoading"
            :properties="{value: 'id', label: 'label'}"
            placeholder="В каком этапе создать копию сделки"
            name="target_stage"
        />
        <BaseInput placeholder="Название новой сделки (пусто — «… (копия)»)" name="label" v-model="trigger.create_deal_data.label" />
        <BaseCheckbox v-model="copyFields" label="Скопировать доп. поля" />
        <BaseCheckbox v-model="copyProducts" label="Скопировать товары" />
        <p class="text-xs text-muted-500">
            Копия получает клиента, компанию, ответственного и бюджет; в истории обеих сделок появится запись со ссылкой на номер другой.
            Сделки другой воронки видны на доске, когда выбрана эта воронка.
        </p>
    </section>
</template>
