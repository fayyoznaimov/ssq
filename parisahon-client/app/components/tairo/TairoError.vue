<template>
    <div class="pb-16">
        <BasePlaceholderPage
            :title="title"
            :subtitle="description"
            image-size="md"
            class="relative !items-end"
        >
            <template #image>
            </template>
            <div class="mt-4">
                <div
                    class="text-muted-400/20 dark:text-muted-400/10 absolute inset-x-0 top-1/3 -translate-y-1/2 text-[13rem] font-bold sm:text-[20rem]"
                >
                    <span>{{ props.error?.statusCode }}</span>
                </div>
                <div
                    class="mx-auto flex w-full max-w-xs items-center justify-center gap-2"
                >
                    <BaseButton
                        shape="curved"
                        class="mx-auto !h-12 w-full max-w-[160px] items-center gap-2"
                        @click="reload"
                    >
                        <Icon name="feather:refresh-cw" class="h-3 w-3"/>
                        Обновить
                    </BaseButton>
                    <BaseButton
                        shape="curved"
                        color="primary"
                        class="mx-auto !h-12 w-full max-w-[160px] items-center gap-2"
                        @click="handleError"
                    >
                        <Icon name="feather:arrow-left"/>
                        На главную
                    </BaseButton>
                    <DevOnly>
                        <BaseButton
                            color="muted"
                            shape="curved"
                            class="mx-auto !h-12 w-full max-w-[160px]"
                            @click="retry"
                        >
                            <Icon name="feather:refresh-cw" class="h-3 w-3"/>
                            <span>Clear Error</span>
                        </BaseButton>
                    </DevOnly>
                </div>
                <DevOnly>
                    <div class="mt-6 flex items-center justify-center">
                        <BaseSwitchBall
                            v-model="showStackTrace"
                            color="danger"
                            :label="`${showStackTrace ? 'Hide' : 'Show'} Stacktrace (dev)`"
                        />
                    </div>
                </DevOnly>
            </div>
        </BasePlaceholderPage>

        <DevOnly>
            <div v-if="showStackTrace">
                <BaseCard
                    v-focus
                    shape="curved"
                    class="nui-focus nui-text-700 group relative mx-auto mt-6 max-w-3xl border-2 border-dashed p-8 hover:border-solid"
                    tabindex="0"
                >
                    <div
                        class="mb-3 flex items-center justify-start gap-1 opacity-30 transition-opacity duration-300 group-hover:opacity-100 group-focus:opacity-100"
                    >
                        <BaseTag v-if="props.error.statusCode" color="danger" condensed>
                            {{ props.error.statusCode }}
                        </BaseTag>
                        <BaseTag
                            v-if="props.error.url"
                            color="danger"
                            flavor="outline"
                            condensed
                        >
                            {{ props.error.url }}
                        </BaseTag>
                    </div>
                    <div class="mb-4 flex items-center gap-2">
                        <BaseIconBox color="danger" shape="full" size="md">
                            <Icon name="ph:skull-duotone" class="h-6 w-6"/>
                        </BaseIconBox>
                        <div>
                            <h4
                                class="text-danger-500 font-mono text-lg font-medium [overflow-wrap:anywhere]"
                            >
                                {{ props.error.message }}
                            </h4>
                            <p class="nui-text-500 font-sans text-xs font-medium">
                                This is a dev only stacktrace, you won't see it in production.
                            </p>
                        </div>
                    </div>

                    <!-- text, not markup: the stack carries the message, and the message may carry an address or a name -->
                    <div
                        v-if="props.error.stack"
                        class="mt-6 overflow-auto whitespace-pre p-2 font-mono text-sm opacity-60 transition-all duration-300 group-hover:opacity-100 group-focus:opacity-100"
                    >{{ props.error.stack }}</div>
                </BaseCard>
            </div>
        </DevOnly>
    </div>
</template>

<script setup lang="ts">
const props = defineProps<{ error: any }>();

const title = computed(() => {
    if (props.error?.statusCode === 401) {
        return 'Нужно войти заново';
    }

    if (props.error?.statusCode === 404) {
        return 'Страница не найдена';
    }

    if (props.error?.statusCode === 403) {
        return 'Недостаточно прав';
    }

    return 'Что-то пошло не так';
});

const description = computed(() => {
    if (props.error?.statusCode === 401) {
        return 'Сессия истекла. Войдите в CRM ещё раз.';
    }

    if (props.error?.statusCode === 404) {
        return 'Такой страницы нет: возможно, запись удалена или ссылка неполная.';
    }

    if (props.error?.statusCode === 403) {
        return 'У вашей роли нет доступа к этой странице. Если он нужен, обратитесь к администратору.';
    }

    return 'Сервер не ответил или страница не загрузилась. Обновите страницу; если ошибка повторится, сообщите администратору.';
});

const handleError = () => clearError({redirect: '/'});
const retry = () => clearError();
const reload = () => window.location.reload();

// Show/hide demo stack trace
const showStackTrace = ref(true);
</script>

<style>
.stack {
    @apply text-sm;
}

.stack.internal {
    @apply opacity-100 ps-4 text-xs;
}
</style>
