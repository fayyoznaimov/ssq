<template>
    <div>
        <div class="h-20 text-xs select-none">
            <div>Весь день</div>
        </div>

        <div class="relative">
            <table class="w-full border-collapse text-xs">
                <tbody>
                    <tr
                        v-for="hour in hours" :key="hour" :data-time="`${hour}:00`"
                        class="h-6 select-none"
                    >
                        <td class="!w-[72px] !px-4 py-0">
                            <span
                                v-if="!hour.slice(-2).includes('3')"
                                class="relative top-[-13px]"
                            >
                                {{ hour }}
                            </span>
                        </td>

                        <td
                            class="w-full border-t border-blue-500 border-opacity-50"
                            :class="{
                                'border-dotted': hour.slice(-2).includes('3')
                            }"
                        ></td>
                    </tr>
                </tbody>
            </table>

            <Events :tasks="tasks" />
        </div>

    </div>
</template>

<script lang="ts" setup>
import Events from '~/components/task/Events.vue';
const props = defineProps<{
    date: Date;
}>();

const hours = ref([]);

const tasks = ref([]);
const taskService = useService('tasks', { auth: true });

onMounted(async () => {
    hours.value = Array.from({ length: 48 }, (_, i) => {
        const hour = Math.floor(i / 2);
        const minutes = i % 2 === 0 ? '00' : '30';
        return `${hour}:${minutes}`.padStart(5, '0');
    });
    await fetchTasks();
});

watch(() => props.date, async () => {
    await fetchTasks();
});

async function fetchTasks() {
    tasks.value = await taskService.find({
        from_date: new Date(props.date.toDateString()).toISOString().slice(0, 10),
        till_date: new Date(new Date(props.date.toDateString()).setDate(props.date.getDate() + 1)).toISOString().slice(0, 10)
    }).list().exec();
}


</script>
