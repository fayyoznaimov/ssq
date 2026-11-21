<template>
    <ul class="mb-5">
        <!-- EMPTY -->
        <li v-if="ctrAgents.length === 0">
            <BasePlaceholderPage
                title="Нет контактов"
                subtitle="Нажмите кнопку, чтобы добавить контакт."
            >
                <div class="mt-2 flex justify-center gap-2">
                    <BaseButton
                        color="primary"
                        rounded="lg"
                        class="h-11 min-w-[10rem] whitespace-nowrap"
                        @click="addCtrAgent"
                    >
                        Добавить контакт
                    </BaseButton>
                </div>
            </BasePlaceholderPage>
        </li>
        <!-- AGENTS -->
        <li
            v-for="(agent, idx) in ctrAgents"
            :key="`agent-${agent.id || agent.tempId}`"
            class="mb-3 last:mb-0"
        >
            <h3 class="flex items-center justify-between">
                <span class="flex items-center gap-3">
                    Контакт {{ idx + 1 }}
                    <template v-if="agent.id">
                        <!-- the primary contact's phone and email stand in for the company's when it has none -->
                        <span
                            v-if="isPrimary(agent)"
                            class="inline-flex items-center gap-1 rounded-full bg-primary-500/15 px-2 py-0.5 text-xs font-medium text-primary-600 dark:text-primary-300"
                            title="Телефон и почта основного контакта показываются как общие, если у компании нет своих"
                        >
                            <Icon name="ph:star-fill" class="size-3" /> основной контакт
                        </span>
                        <button
                            v-else
                            type="button"
                            class="text-xs font-normal text-muted-500 underline underline-offset-2 hover:text-primary-500"
                            @click="primaryContactId = agent.id!"
                        >
                            сделать основным
                        </button>
                    </template>
                </span>
                <BaseButton
                    v-if="idx"
                    size="sm"
                    type="button"
                    @click="removeCtrAgent(agent)"
                >
                    <Icon name="ph:trash" />
                </BaseButton>
            </h3>

            <!-- USERNAME -->
            <BaseInput
                v-model="agent.username"
                type="text"
                label="Имя пользователя"
                placeholder="пр.: JohnDoe"
                icon="ph:user"
                required
                :classes="{ wrapper: 'w-full mb-3' }"
                name="field"
            />

            <!-- EMAIL -->
            <BaseInput
                v-model="agent.email"
                type="email"
                label="Почта"
                placeholder="пр.:example@mail.com"
                icon="ph:at"
                :classes="{ wrapper: 'w-full mb-3' }"
                name="email"
            />

            <!-- PHONE -->
            <BaseInput
                v-model="agent.phone"
                type="text"
                label="Номер телефона"
                name="phone"
                placeholder="пр.: +998901200000"
                icon="ph:phone"
                required
                :classes="{ wrapper: 'w-full mb-3' }"
            />

            <!-- FILLERS -->
            <BaseInput
                v-for="(filler, fillerIdx) in agent.fillers || []"
                :key="`${agent.id}-${filler.id}`"
                v-model="filler.value"
                :classes="{
                    wrapper: 'w-full',
                    inputWrapper: 'flex gap-2',
                }"
                class="mb-3"
                placeholder="Введите значение"
                :label="filler.field"
                :name="`fillers.${filler.id}.${fillerIdx}`"
                :required="filler.is_required"
            />
        </li>
    </ul>

    <!-- ADD AGENT -->
    <div
        v-if="ctrAgents.length > 0"
        class="mt-2 flex justify-center gap-2"
    >
        <BaseButton
            color="primary"
            rounded="lg"
            class="h-11 min-w-[10rem] whitespace-nowrap"
            @click="addCtrAgent"
        >
            Добавить контакт
        </BaseButton>
    </div>
</template>

<script setup lang="ts">
const ctrAgentsStore = useCtrAgentsStore();

const { addCtrAgent, removeCtrAgent } = ctrAgentsStore;
const { ctrAgents, primaryContactId } = storeToRefs(ctrAgentsStore);

// a single saved contact is the primary one even when nobody chose it
function isPrimary(agent: { id?: number }) {
    if (!agent.id) return false;
    if (primaryContactId.value) return primaryContactId.value === agent.id;
    return ctrAgents.value.filter((a) => a.id).length === 1;
}
</script>
