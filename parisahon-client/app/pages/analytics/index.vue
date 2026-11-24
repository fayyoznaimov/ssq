<template>
    <div class="flex flex-col gap-6">
        <div>
            <h1 class="text-xl">Аналитика</h1>
            <p class="text-sm text-muted-500">Отчёты по продажам, сотрудникам и звонкам. Период, выбранный в одном отчёте, сохраняется в остальных.</p>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            <NuxtLink v-for="report in reports" :key="report.to" :to="report.to" class="group">
                <BaseCard class="p-4 h-full flex gap-3 items-start transition-colors group-hover:border-primary-500">
                    <Icon :name="report.icon" class="size-6 shrink-0 text-primary-500 mt-0.5" />
                    <div class="flex flex-col gap-1 min-w-0">
                        <span class="font-semibold text-muted-800 dark:text-white">{{ report.title }}</span>
                        <span class="text-sm text-muted-500">{{ report.text }}</span>
                    </div>
                </BaseCard>
            </NuxtLink>
        </div>
    </div>
</template>
<script lang="ts" setup>
definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Аналитика'
});

useHead({
    title: 'Аналитика'
});

// the page the breadcrumb «Аналитика» leads to: it was empty
const reports = [
    { to: '/analytics/consolidated', icon: 'ph:chart-bar', title: 'Сводный отчет', text: 'Новые, выигранные и проигранные сделки, этапы, клиенты и задачи за период' },
    { to: '/analytics/sales', icon: 'ph:funnel', title: 'Анализ продаж', text: 'Сделки воронки по этапам: доля бюджета и количества, время в этапе, цикл сделки' },
    { to: '/analytics/goals', icon: 'ph:target', title: 'Цели', text: 'План и факт продаж групп и сотрудников за месяц, квартал и год' },
    { to: '/analytics/managers', icon: 'ph:users-three', title: 'По менеджерам', text: 'Сделки, выигранные, новые клиенты, звонки и скорость ответа каждого сотрудника' },
    { to: '/analytics/employees', icon: 'ph:identification-card', title: 'По сотрудникам', text: 'Сделки и задачи сотрудников за период' },
    { to: '/analytics/calls', icon: 'ph:phone', title: 'Звонки', text: 'Входящие и исходящие звонки и их длительность' },
    { to: '/analytics/products', icon: 'ph:package', title: 'По товарам', text: 'Какие товары и на какую сумму продаются в сделках' },
    { to: '/analytics/control', icon: 'ph:timer', title: 'Контроль менеджеров', text: 'Как быстро отвечают клиентам, кто ждёт ответа' },
    { to: '/analytics/market', icon: 'ph:scales', title: 'Рынок', text: 'Цены и условия конкурентов со слов клиентов против наших цен; сводка ИИ' },
    { to: '/analytics/events', icon: 'ph:list-bullets', title: 'История событий', text: 'Кто что изменил и что произошло: события сделок, изменения данных, прав и настроек, входы' },
];
</script>
