<script setup lang="ts">
// «Сменить ответственного»: one chosen employee, or the deals in turn among several («по очереди» —
// раздача новых заявок). The open tasks of the previous responsible go to the new one unless unticked.
import { type ChangeAgentTrigger,type Trigger } from '~/types/stage';
import type { User } from '~/types/user';

const props = defineProps<{
  employees: User[];
  trigger: Trigger & ChangeAgentTrigger;
}>();

const data = props.trigger.change_agent_data;
const modes = [
    { id: 'one', label: 'Конкретному сотруднику' },
    { id: 'rotate', label: 'По очереди нескольким сотрудникам' },
];
const mode = ref(modes.find((m) => m.id === ((data.rotate_user_ids?.length ?? 0) > 1 ? 'rotate' : 'one')) ?? modes[0]);
const agent = ref<User>();
const rotation = ref<User[]>([]);
const transfer = ref(data.transfer_tasks !== false);

watchEffect(() => {
    if (!agent.value && data.agent_id) agent.value = props.employees.find((e) => e.id === data.agent_id);
    if (!rotation.value.length && data.rotate_user_ids?.length) {
        rotation.value = data.rotate_user_ids.map((id) => props.employees.find((e) => e.id === id)).filter(Boolean) as User[];
    }
});

watch([mode, agent, rotation, transfer], () => {
    props.trigger.change_agent_data.transfer_tasks = transfer.value;
    if (mode.value.id === 'rotate') {
        props.trigger.change_agent_data.rotate_user_ids = rotation.value.map((u) => u.id);
        props.trigger.change_agent_data.agent_id = undefined;
    } else {
        props.trigger.change_agent_data.rotate_user_ids = [];
        if (agent.value) props.trigger.change_agent_data.agent_id = agent.value.id;
    }
}, { deep: true });
</script>
<template>
    <section class="px-3 pb-3 flex flex-col gap-3 pr-[3.25rem]">
        <BaseListbox
            v-model="mode"
            :items="modes"
            :properties="{value: 'id', label: 'label'}"
            name="agent_mode"
        />
        <BaseListbox
            v-if="mode.id === 'one'"
            v-model="agent"
            :items="employees"
            :properties="{value: 'id', label: 'username'}"
            placeholder="Новый ответственный"
            name="agent_id"
        />
        <template v-else>
            <BaseListbox
                v-model="rotation"
                :items="employees"
                :properties="{value: 'id', label: 'username'}"
                :multiple="true"
                :multipleLabel="(value: User[]) => value.length ? value.map((v) => v.username).join(', ') : undefined"
                placeholder="Кому раздавать (не меньше двух)"
                name="rotate_user_ids"
            />
            <p class="text-xs text-muted-500">Каждая следующая сделка достаётся следующему сотруднику из списка; уволенные пропускаются.</p>
        </template>
        <BaseCheckbox v-model="transfer" label="Передать новому ответственному открытые задачи сделки" />
    </section>
</template>
