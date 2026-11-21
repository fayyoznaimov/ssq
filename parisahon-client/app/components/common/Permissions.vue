<template>
    <div>
        <div class="border">
            <ul class="grid grid-cols-7 p-3">
                <li
                    v-for="(title, index) in titles"
                    class="col-span-1 col-start-{{ index + 1 }} text-[12px] font-semibold"
                    :key="index"
                >{{ title }}</li>
            </ul>
            <div
                v-for="(p, actionKey) in ps"
                class="grid grid-cols-7 p-2 border border-b-0"
            >
                <div class="flex items-center col-span-1 col-start-1">
                    <h5 class="text-sm font-semibold">
                        {{ permissionMap[actionKey] }}
                    </h5>
                </div>
                <div
                    v-for="(value, key, index) in p"
                    :class="getStartCol(index, key)"
                >
                    <Level
                        :key="key"
                        :level="value"
                        :actionKey="actionKey"
                        :permission="key"
                        @update:value="updateValue(key, $event, actionKey)"
                    />
                </div>
                <div class="flex flex-col gap-1 col-span-1 col-start-7">
                    <p
                        class="text-[12px] truncate"
                        v-for="level in Object.values(levelsMap)"
                    >
                        {{ level }}
                    </p>
                </div>
            </div>
        </div>
    </div>
</template>
<script lang="ts" setup>
import Level from '~/components/common/Level.vue';

const props = defineProps<{
    permissions?: {
        deal: {
            create: number;
            view: number;
            update: number;
            delete: number;
            export: number;
        },
        contact: {
            create: number;
            view: number;
            update: number;
            delete: number;
            export: number;
        },
        company: {
            create: number;
            view: number;
            update: number;
            delete: number;
            export: number;
        },
        task: {
            create: number;
            view: number;
            update: number;
            delete: number;
            export: number;
        },
    }
}>();

const ps = ref({
    deal: {
        create: 0,
        view: 0,
        update: 0,
        delete: 0,
        export: 0,
    },
    contact: {
        create: 0,
        view: 0,
        update: 0,
        delete: 0,
        export: 0,
    },
    company: {
        create: 0,
        view: 0,
        update: 0,
        delete: 0,
        export: 0,
    },
    task: {
        update: 0,
        delete: 0,
    },
});

const colOrders = {
    create: 2,
    view: 3,
    update: 4,
    delete: 5,
    export: 6,
};

const permissionMap = {
    deal: 'Сделки / Покупки',
    contact: 'Контакты',
    company: 'Компании',
    task: 'Задачи',
};

function getStartCol(index, key) {
    const startCol = colOrders[key] || 0;
    return `col-span-1 col-start-${startCol} col-end-${startCol + 1}`;
}

const levelsMap = {
    0: 'Запрещено',
    1: 'Если ответственный',
    2: 'Для группы',
    3: 'Разрешено',
};

const titles = [
    '',
    'Создание',
    'Просмотр',
    'Правка',
    'Удаление',
    'Экспорт',
    'Уровни доступа',
];

const emit = defineEmits(['update:permissions']);

function updateValue(key: any, value: number, actionKey: any) {
    ps.value[actionKey][key] = value;
    emit('update:permissions', ps.value);
}

onUpdated(() => {
    if (props.permissions) {
        for (const actionKey in props.permissions) {
            for (const key in props.permissions[actionKey]) {
                ps.value[actionKey][key] = props.permissions[actionKey][key];
            }
        }
    }
});

onMounted(() => {
    if (props.permissions) {
        for (const actionKey in props.permissions) {
            for (const key in props.permissions[actionKey]) {
                ps.value[actionKey][key] = props.permissions[actionKey][key];
            }
        }
    }
});

</script>
<style scoped>
.col-start-1 {
    grid-column-start: 1;
}
.col-start-2 {
    grid-column-start: 2;
}
.col-start-3 {
    grid-column-start: 3;
}
.col-start-4 {
    grid-column-start: 4;
}
.col-start-5 {
    grid-column-start: 5;
}
.col-start-6 {
    grid-column-start: 6;
}
</style>
