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
                <!-- a saved contact is detached from the company on save (it stays in the CRM with its deals) -->
                <BaseButton
                    size="sm"
                    type="button"
                    :title="agent.id ? 'Отвязать от компании' : 'Убрать'"
                    @click="onRemove(agent)"
                >
                    <Icon name="ph:trash" />
                </BaseButton>
            </h3>

            <!-- USERNAME -->
            <BaseInput
                v-model="agent.username"
                type="text"
                label="Имя*"
                placeholder="пр.: Андрей"
                icon="ph:user"
                required
                :classes="{ wrapper: 'w-full mb-3' }"
                name="field"
            />

            <!-- EMAIL: a contact from Telegram or a business card often has none -->
            <BaseInput
                v-model="agent.email"
                type="email"
                label="Почта"
                placeholder="пр.:example@mail.com"
                icon="ph:at"
                :classes="{ wrapper: 'w-full mb-3' }"
                name="email"
            />

            <!-- PHONE: any format, stored as +998901234567 -->
            <BaseInput
                v-model="agent.phone"
                type="text"
                label="Номер телефона"
                name="phone"
                placeholder="пр.: +998901200000"
                icon="ph:phone"
                :classes="{ wrapper: 'w-full mb-3' }"
            />

            <SimilarClients
                :name="agent.username"
                :phone="agent.phone"
                :email="agent.email"
                :exclude-contact-id="agent.id && !agent.new ? agent.id : null"
                :exclude-company-id="companyId"
                class="mb-3"
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

    <p
        v-if="removedIds.length"
        class="mb-3 text-xs text-muted-500 dark:text-muted-400"
    >
        {{ removedIds.length === 1 ? 'Один контакт будет отвязан' : `Контактов будет отвязано: ${removedIds.length}` }}
        от компании при сохранении. Они останутся в CRM вместе со сделками.
    </p>

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
import SimilarClients from '~/components/company/SimilarClients.vue';
import type { CtrAgent } from '~/types/ctrAgent';
const ctrAgentsStore = useCtrAgentsStore();

const { addCtrAgent, removeCtrAgent } = ctrAgentsStore;
const { ctrAgents, primaryContactId, removedIds } = storeToRefs(ctrAgentsStore);

const route = useRoute();
// the company being edited: its own contacts and the company itself are not "similar"
const companyId = computed(() => (route.params.id && route.params.id !== "new" ? Number(route.params.id) : null));

function onRemove(agent: CtrAgent) {
    if (agent.id && !confirm(`Отвязать контакт «${agent.username || ""}» от компании? Он останется в CRM вместе со своими сделками. Изменение сохранится кнопкой «Сохранить компанию».`)) return;
    removeCtrAgent(agent);
}

// a single saved contact is the primary one even when nobody chose it
function isPrimary(agent: { id?: number }) {
    if (!agent.id) return false;
    if (primaryContactId.value) return primaryContactId.value === agent.id;
    return ctrAgents.value.filter((a) => a.id).length === 1;
}
</script>
