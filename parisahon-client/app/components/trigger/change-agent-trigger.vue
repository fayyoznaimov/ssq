<script setup lang="ts">
import { type ChangeAgentTrigger,type Trigger } from '~/types/stage';
import type { User } from '~/types/user';

const props = defineProps<{
  employees: User[];
  trigger: Trigger & ChangeAgentTrigger;
}>();

const agent = ref<User>();

watchEffect(() => {
    agent.value = props.employees.find((e) => e.id === props.trigger.change_agent_data.agent_id);
});

watch([agent], () => {
    if (agent.value) props.trigger.change_agent_data.agent_id = agent.value.id;
});

</script>
<template>
    <section class="px-3 pb-3 flex flex-col gap-3 pr-[3.25rem]">
        <BaseListbox 
            v-model="agent"
            :items="employees"
            :properties="{value: 'id', label: 'username'}"
            placeholder="Ответственный"
            name="agent_id"
        />
    </section>
</template>