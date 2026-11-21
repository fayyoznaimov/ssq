<template>
    <table class="absolute top-0 left-0 z-1 w-full border-collapse text-xs">
        <tbody>
            <tr>
                <td class="w-16 px-1"></td>
                <td>
                    <div
                        v-for="task in props.tasks"
                        :key="task.id"
                        class="absolute h-full bg-blue-500 bg-opacity-50"
                        :style="{
                            top: `${calcTop(task)}px`,
                            height: `${calcHeight(task)}px`,
                            width: `calc(100% - 64px)`,
                        }"
                        :task-time-range="`${ calcStartTime(task) } - ${ calcEndTime(task) }`"
                        @mousedown.prevent
                    >
                        <div
                            class="absolute top-0 left-0 right-0 h-2 cursor-ns-resize"
                            @mousedown="startResizing('top', task, $event)"
                        ></div>

                        <div class="px-2 py-1 text-xs flex gap-2 h-full cursor-pointer"
                             @mousedown="startResizing('drag', task, $event)"
                        >
                            <span>
                                {{ task.label }}
                            </span>
                            <span>
                                {{ calcStartTime(task) }}
                            </span>
                            <span>
                                {{ calcEndTime(task) }}
                            </span>
                        </div>

                        <div
                            class="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize"
                            @mousedown="startResizing('bottom', task, $event)"
                        ></div>
                    </div>
                </td>
            </tr>
        </tbody>
    </table>
</template>

<script lang="ts" setup>
const props = defineProps<{
    tasks: any[],
}>();

const initialMouseY = ref(0);

const resizingTask = ref(null);
const resizingElement = ref<any>(null);
const direction = ref('');
const cellHeight = 24;
const millisecondsInHalfHour = 30 * 60 * 1000;

const calcTop = (task: any) => {
    const hours = new Date(task.start_time.slice(0, -1)).getHours();
    const minutes = new Date(task.start_time.slice(0, -1)).getMinutes();
    const extraCell = minutes / 30;
    const cells = hours * 2 + extraCell;
    return cells * cellHeight;
};

const calcHeight = (task: any) => {
    return (new Date(task.end_time.slice(0, -1)).getTime() - new Date(task.start_time.slice(0, -1)).getTime()) / millisecondsInHalfHour * cellHeight;
};

const calcStartTime = (task: any) => {
    return new Date(task.start_time.slice(0, -1)).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
};

const calcEndTime = (task: any) => {
    return new Date(task.end_time.slice(0, -1)).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
};

const startResizing = (dir: string, task: any, event: Event) => {
    resizingTask.value = task;
    initialMouseY.value = (event as MouseEvent).clientY;
    resizingElement.value = (event.target as HTMLElement).parentElement;
    direction.value = dir;

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', stopResizing);
};

const handleMouseMove = (event: MouseEvent) => {
    if (resizingTask.value) {
        const diffMove = initialMouseY.value - event.clientY;
        if(direction.value === 'drag') {
            const absDiffMove = Math.abs(diffMove);
            if(absDiffMove >= cellHeight && absDiffMove%cellHeight === 0) {
                const startTime = new Date(resizingTask.value.start_time).getTime() - diffMove / cellHeight * millisecondsInHalfHour;
                const endTime = new Date(resizingTask.value.end_time).getTime() - diffMove / cellHeight * millisecondsInHalfHour;
                resizingTask.value.start_time = new Date(startTime).toISOString();
                resizingTask.value.end_time = new Date(endTime).toISOString();
                initialMouseY.value = event.clientY;
            }
        }

        if(direction.value === 'top') {
            if(Math.abs(diffMove) >= cellHeight && diffMove%cellHeight === 0) {
                const startTime = new Date(resizingTask.value.start_time).getTime() - diffMove / cellHeight * millisecondsInHalfHour;
                resizingTask.value.start_time = new Date(startTime).toISOString();
                initialMouseY.value = event.clientY;
            }
        }

        if(direction.value === 'bottom') {
            if(Math.abs(diffMove) >= cellHeight && diffMove%cellHeight === 0) {
                const endTime = new Date(resizingTask.value.end_time).getTime() - diffMove / cellHeight * millisecondsInHalfHour;
                resizingTask.value.end_time = new Date(endTime).toISOString();
                initialMouseY.value = event.clientY;
            }
        }
    }
};

const stopResizing = () => {
    useService('tasks', { auth: true }).patch(resizingTask.value.id, resizingTask.value).exec();
    if(resizingTask.value) {
        resizingTask.value = null;
        initialMouseY.value = 0;
        resizingElement.value = null;
    }
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', stopResizing);
};

onUnmounted(() => {
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', stopResizing);
});

</script>
