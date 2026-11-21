<script setup lang="ts">
import { type CreateDealTrigger, type Stage, type Trigger } from '~/types/stage';

const props = defineProps<{
  trigger: Trigger & CreateDealTrigger;
  stages: Stage[];
  stage: Stage;
}>();

// the copy goes to another stage (of this funnel): never the same one
const targets = computed(() => props.stages.filter((s) => s.id !== props.stage.id && s.id > 0));
const target = ref<Stage | undefined>(targets.value.find((s) => s.id === props.trigger.create_deal_data.stage_id));

watch(target, () => {
    props.trigger.create_deal_data.stage_id = target.value?.id;
});
</script>
<template>
    <section class="px-3 pb-3 flex flex-col gap-3 pr-[3.25rem]">
        <BaseListbox
            v-model="target"
            :items="targets"
            :properties="{value: 'id', label: 'name'}"
            placeholder="В каком этапе создать копию сделки"
            name="target_stage"
        />
        <BaseInput placeholder="Название новой сделки (пусто — «… (копия)»)" name="label" v-model="trigger.create_deal_data.label" />
        <p class="text-xs text-muted-500">Копия получает клиента, компанию, ответственного и бюджет сделки.</p>
    </section>
</template>
