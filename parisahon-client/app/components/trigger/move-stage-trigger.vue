<script setup lang="ts">
// «Перевести в этап»: the deal goes to another stage (of this pipeline or another one) the way a manager
// moves it, and gets the triggers of that stage. A chain of moves is cut by the API after three steps.
import { type MoveStageTrigger, type Stage, type Trigger } from '~/types/stage';
import { type AnyStage } from './trigger';

const props = defineProps<{
  trigger: Trigger & MoveStageTrigger;
  stage: Stage;
}>();

type Item = { id: number; label: string };
const triggersService = useService('triggers', { auth: true });
const { run, data: stages, isLoading } = useAsync<AnyStage[]>([]);

// the other stages, «Воронка — этап» when there are several pipelines
const items = computed<Item[]>(() => {
    const many = new Set(stages.value.map((s) => s.collection_id)).size > 1;
    return stages.value
        .filter((s) => s.id !== props.stage.id)
        .map((s) => ({ id: s.id, label: many && s.collection ? `${s.collection} — ${s.name}` : s.name }));
});
const target = ref<Item>();
watchEffect(() => {
    if (!target.value && items.value.length) target.value = items.value.find((s) => s.id === props.trigger.move_stage_data.stage_id);
});
watch(target, () => {
    if (target.value) props.trigger.move_stage_data.stage_id = target.value.id;
});

onMounted(() => run(triggersService.get('stages').exec()));
</script>
<template>
    <section class="px-3 pb-3 flex flex-col gap-3 pr-[3.25rem]">
        <BaseListbox
            v-model="target"
            :items="items"
            :loading="isLoading"
            :properties="{value: 'id', label: 'label'}"
            placeholder="В какой этап перевести сделку"
            name="move_stage"
        />
        <p class="text-xs text-muted-500">
            Сделка перейдёт в этап так же, как если бы её перенёс менеджер: там сработают его триггеры,
            закрывающий этап закроет сделку.
        </p>
    </section>
</template>
