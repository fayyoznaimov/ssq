<script setup lang="ts">
// «Уведомить»: a message in the CRM bot to the responsible, the managers or one employee; whoever has not
// linked the bot gets a task with the text in the deal instead.
import { type NotifyTrigger, type Trigger } from '~/types/stage';
import type { User } from '~/types/user';
import { placeholderHint } from './trigger';

const props = defineProps<{
  trigger: Trigger & NotifyTrigger;
  employees: User[];
}>();

type Whom = { id: string; label: string };
const whoms = computed<Whom[]>(() => [
    { id: 'responsible', label: 'Ответственному за сделку' },
    { id: 'managers', label: 'Руководителям (админы и менеджеры)' },
    { id: 'both', label: 'Ответственному и руководителям' },
    ...props.employees.map((e) => ({ id: `user:${e.id}`, label: e.username })),
]);
const data = props.trigger.notify_data;
const whom = ref<Whom | undefined>(
    whoms.value.find((w) => (data.user_id ? w.id === `user:${data.user_id}` : w.id === (data.to ?? 'responsible'))) ?? whoms.value[0],
);
watch(whom, () => {
    if (!whom.value) return;
    if (whom.value.id.startsWith('user:')) {
        props.trigger.notify_data.user_id = Number(whom.value.id.slice(5));
        props.trigger.notify_data.to = undefined;
    } else {
        props.trigger.notify_data.user_id = null;
        props.trigger.notify_data.to = whom.value.id as 'responsible' | 'managers' | 'both';
    }
}, { immediate: true });
</script>
<template>
    <section class="px-3 pb-3 flex flex-col gap-3 pr-[3.25rem]">
        <BaseListbox
            v-model="whom"
            :items="whoms"
            :properties="{value: 'id', label: 'label'}"
            placeholder="Кому"
            name="notify_to"
        />
        <BaseTextarea
            v-model="trigger.notify_data.text"
            rows="3"
            name="notify_text"
            placeholder="Текст уведомления, например: Клиент {{клиент}} ждёт ответа по сделке {{сделка}}"
        />
        <p class="text-xs text-muted-500">
            Придёт в бот CRM в Telegram; у кого бот не подключён — появится задача в сделке.
            Подстановки: {{ placeholderHint }}.
        </p>
    </section>
</template>
