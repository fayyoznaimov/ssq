<template>
    <div class="flex flex-col gap-8">
        <!-- wraps on a phone: the folders, the filter and the buttons on the right used to be cut off -->
        <BaseCard
            class="w-full flex flex-wrap gap-2 p-2"
        >
            <form
                class="flex flex-wrap gap-2"
                @submit.prevent="() => fetchEmails()"
            >
                <div>
                    <input
                        id="filter-incoming"
                        v-model="filters.direction"
                        type="radio"
                        name="direction"
                        value="incoming"
                        class="peer apperance-none opacity-0 h-0 -z-10 absolute"
                        checked
                    >
                    <label
                        for="filter-incoming"
                        class="nui-button nui-button-medium nui-button-rounded nui-button-pastel 
                        dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600 
                        dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600"
                    >
                        <Icon
                            name="ph:tray"
                            class="size-5 mr-1"
                        />
                        Входящие
                    </label>
                </div>
                <div>
                    <input
                        id="filter-outgoing"
                        v-model="filters.direction"
                        type="radio"
                        name="direction"
                        value="outgoing"
                        class="peer apperance-none opacity-0 h-0 -z-10 absolute"
                    >
                    <label
                        for="filter-outgoing"
                        class="nui-button nui-button-medium nui-button-rounded nui-button-pastel 
                        dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600 
                        dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600"
                    >
                        <Icon
                            name="ph:paper-plane-right"
                            class="size-5 mr-1"
                        />
                        Отправленные
                    </label>
                </div>
                <div>
                    <input
                        id="filter-spam"
                        v-model="filters.direction"
                        type="radio"
                        name="direction"
                        value="spam"
                        class="peer apperance-none opacity-0 h-0 -z-10 absolute"
                    >
                    <label
                        for="filter-spam"
                        class="nui-button nui-button-medium nui-button-rounded nui-button-pastel 
                        dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600 
                        dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600"
                    >
                        <Icon
                            name="lucide:octagon-alert"
                            class="size-5 mr-1"
                        />
                        Спам
                    </label>
                </div>
                <div v-if="false">
                    <input
                        id="filter-unread"
                        v-model="unread"
                        type="checkbox"
                        class="peer apperance-none opacity-0 h-0 -z-10 absolute"
                    >
                    <label
                        for="filter-unread"
                        class="nui-button nui-button-medium nui-button-rounded nui-button-pastel 
                        dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600 
                        dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600"
                    >
                        <Icon
                            name="ph:envelope"
                            class="size-5 mr-1"
                        />
                        Непрочитанные
                    </label>
                </div>
                <TairoPopover
                    fixed
                    size="2md"
                >
                    <BaseButton><Icon name="ph:funnel" /></BaseButton>
                    <template #content="{close}">
                        <div class="flex flex-col sm:flex-row gap-4 p-4">
                            <section class="sm:max-w-[16rem] w-full">
                                <ul class="flex flex-col gap-1">
                                    <li class="w-full">
                                        <input
                                            :id="'preset-' + Preset.All"
                                            v-model="preset"
                                            type="radio"
                                            name="preset"
                                            :value="Preset.All"
                                            class="apperance-none opacity-0 h-0 absolute -z-10 peer"
                                            checked
                                            @change="onPresetSelect(close, $event)"
                                        >
                                        <label
                                            :for="'preset-' + Preset.All"
                                            class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start"
                                        >
                                            Все письма 
                                        </label>
                                    </li>
                                    <li class="w-full">
                                        <input
                                            :id="'preset-' + Preset.Unread"
                                            v-model="preset"
                                            type="radio"
                                            name="preset"
                                            :value="Preset.Unread"
                                            class="apperance-none opacity-0 h-0 absolute -z-10 peer"
                                            @change="onPresetSelect(close, $event)"
                                        >
                                        <label
                                            :for="'preset-' + Preset.Unread"
                                            class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start"
                                        >
                                            Непрочитанные письма 
                                        </label>
                                    </li>
                                    <li class="w-full">
                                        <input
                                            :id="'preset-' + Preset.Read"
                                            v-model="preset"
                                            type="radio"
                                            name="preset"
                                            :value="Preset.Read"
                                            class="apperance-none opacity-0 h-0 absolute -z-10 peer"
                                            @change="onPresetSelect(close, $event)"
                                        >
                                        <label
                                            :for="'preset-' + Preset.Read"
                                            class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start"
                                        >
                                            Прочитанные письма
                                        </label>
                                    </li>
                                    <li class="w-full">
                                        <input
                                            :id="'preset-' + Preset.WithDeal"
                                            v-model="preset"
                                            type="radio"
                                            name="preset"
                                            :value="Preset.WithDeal"
                                            class="apperance-none opacity-0 h-0 absolute -z-10 peer"
                                            @change="onPresetSelect(close, $event)"
                                        >
                                        <label
                                            :for="'preset-' + Preset.WithDeal"
                                            class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start"
                                        >
                                            Письма со сделками
                                        </label>
                                    </li>
                                    <li class="w-full">
                                        <input
                                            :id="'preset-' + Preset.WithoutDeal"
                                            v-model="preset"
                                            type="radio"
                                            name="preset"
                                            :value="Preset.WithoutDeal"
                                            class="apperance-none opacity-0 h-0 absolute -z-10 peer"
                                            @change="onPresetSelect(close, $event)"
                                        >
                                        <label
                                            :for="'preset-' + Preset.WithoutDeal"
                                            class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start"
                                        >
                                            Письма без сделок
                                        </label>
                                    </li>
                                </ul>
                            </section>
                            <div class="flex items-start flex-col gap-2 w-full px-2 overflow-hidden">
                                <BaseInput
                                    v-model="filters.from"
                                    placeholder="От кого"
                                    :classes="{wrapper: 'w-full'}"
                                />
                                <BaseInput
                                    v-model="filters.subject"
                                    placeholder="Тема"
                                    :classes="{wrapper: 'w-full'}"
                                />
                                <BaseInput
                                    v-model="filters.dealLabel"
                                    placeholder="Название сделки"
                                    :classes="{wrapper: 'w-full'}"
                                />
                                <DatePicker 
                                    v-model="filters.dates"
                                    format="dd-MM-yyyy" 
                                    range
                                    text-input
                                    vertical 
                                    :preset-dates="presetDates" 
                                    auto-apply 
                                    :enable-time-picker="false"
                                    model-type="yyyy-MM-dd"
                                    :teleport="true"
                                    :dark="isDarkMode"
                                >
                                    <template #dp-input="{ onInput, value, onBlur, onPaste }">
                                        <BaseInput
                                            :value="value"
                                            placeholder="За все время"
                                            @input="onInput"
                                            @blur="onBlur"
                                            @paste="onPaste"
                                        />
                                    </template>
                                </DatePicker>
                                <BaseListbox 
                                    v-model="filters.stages" 
                                    :items="stages"
                                    :properties="{label: 'name', value: 'id' }" 
                                    multiple
                                    :fixed="true" 
                                    placeholder="Все этапы"
                                    :multiple-label="(value, prop) => {
                                        if (!value.length) return;
                                        else return `${value.map(v => v[prop]).join(', ')}`;
                                    }"
                                    name="stages"
                                />
                                <div class="relative w-full">
                                    <span class="absolute top-1/2 left-3 -translate-y-1/2 z-10 text-sm text-muted-900 dark:text-white">Непрочитанные: </span>
                                    <BaseSelect
                                        v-model="filters.read"
                                        :classes="{wrapper: 'w-full', select: '!pl-32'}"
                                    >
                                        <option value="">
                                            Не учитывать
                                        </option>
                                        <option value="yes">
                                            Да
                                        </option>
                                        <option value="no">
                                            Нет
                                        </option>
                                    </BaseSelect>
                                </div>
                                <div class="relative w-full">
                                    <span class="absolute top-1/2 left-3 -translate-y-1/2 z-10 text-sm text-muted-900 dark:text-white">Сделки: </span>
                                    <BaseSelect
                                        v-model="filters.withDeal"
                                        :classes="{wrapper: 'w-full', select: '!pl-[4.5rem]'}"
                                    >
                                        <option value="">
                                            Не учитывать
                                        </option>
                                        <option value="yes">
                                            Да
                                        </option>
                                        <option value="no">
                                            Нет
                                        </option>
                                    </BaseSelect>
                                </div>
                                <div class="relative w-full">
                                    <span class="absolute top-1/2 left-3 -translate-y-1/2 z-10 text-sm text-muted-900 dark:text-white">Вложения: </span>
                                    <BaseSelect
                                        v-model="filters.withAttachments"
                                        :classes="{wrapper: 'w-full', select: '!pl-[5.5rem]'}"
                                    >
                                        <option value="">
                                            Не учитывать
                                        </option>
                                        <option value="yes">
                                            Да
                                        </option>
                                        <option value="no">
                                            Нет
                                        </option>
                                    </BaseSelect>
                                </div>
                            
                                <BaseButton type="submit">
                                    Применить
                                </BaseButton>
                            </div>
                        </div>
                    </template>
                </TairoPopover>
            </form>
            <div class="ms-auto flex flex-wrap gap-2">
                <BaseAutocomplete
                    class="w-full sm:w-56"
                    v-model="filters.email_to"
                    :items="agentEmails.data"
                    :loading="agentEmailsLoading"
                    :display-value="(email: AgentEmail) => email.value"
                    :properties="{ value: 'id', label: 'value' }"
                    placeholder="Почты агентов"
                    clearable
                    size="md"
                    dropdown
                    :classes="[{input: 'border-none !outline-none !rounded-b-none rounded-t-md'}, 'w-auto']" 
                    @change="onEmailChange"
                    @input="onEmailInput"
                />
                <BaseButton @click="() => fetchEmails(true)">
                    <Icon
                        name="ph:arrows-clockwise"
                        class="me-1"
                    />
                    Синхронизовать
                </BaseButton>
                <NuxtLink :to="{path: '/mails/settings'}">
                    <BaseButton>
                        <Icon
                            name="ph:gear"
                            class="me-1"
                        />
                        Настройки
                    </BaseButton>
                </NuxtLink>
                <NuxtLink :to="{path: '/mails/new'}">
                    <BaseButton
                        color="primary"
                    >
                        <Icon
                            name="ph:pen-fill"
                            class="me-1"
                        />
                        Написать письмо
                    </BaseButton>
                </NuxtLink>
            </div>
        </BaseCard>
        <main>
            <div class="text-sm border border-muted-200 dark:border-muted-700 overflow-x-auto rounded-md relative">
                <ul class="text-xs bg-muted-50 dark:bg-muted-800 px-4 py-3 text-muted-700 dark:text-muted-400 items-center cols w-fit min-w-full">
                    <li
                        ref="fromRefHeader"
                        class="uppercase text-left font-sans font-semibold tracking-wider flex items-center resize-x overflow-x-auto w-96 min-w-52"
                    >
                        <BaseCheckbox
                            :checked="selectedEmails.length > 1"
                            rounded="sm"
                            :classes="{wrapper: 'peer z-10'}"
                            @change="onSelectAll"
                        />
                        <div
                            class="absolute left-0 h-11 flex items-center bg-muted-200 
                            font-normal opacity-0 -translate-x-full peer-has-[:checked]:opacity-100 peer-has-[:checked]:translate-x-0 duration-300 
                            gap-4 px-4 ml-0 text-muted-800 dark:text-muted-200 dark:bg-muted-700 border-l-[3px] border-l-blue-600 dark:border-l-blue-400"
                        >
                            <button
                                class="ml-8"
                                @click="addContactModal.open"
                            >
                                <Icon
                                    name="ph:user-plus"
                                    class="size-4 text-primary-600 dark:text-primary-200"
                                />
                                доб.контакты
                            </button>
                            <button @click="addDealModal.open">
                                <Icon
                                    name="ph:currency-circle-dollar"
                                    class="size-4 text-blue-600 dark:text-blue-400"
                                />
                                доб.сделку
                            </button>
                            <button
                                :disabled="isLoadingMap.deleteall"
                                @click="() => deleteConfirmation.open({description: `Вы действительно хотите удалить выбранные письма?`})"
                            >
                                <Icon
                                    v-if="isLoadingMap.deleteall"
                                    name="lucide:loader-circle"
                                    class="size-4 animate-spin"
                                />
                                <Icon
                                    v-else
                                    name="ph:trash"
                                    class="size-4 text-rose-600 dark:text-rose-400"
                                />
                                удалить
                            </button>
                            <button
                                v-if="unreadCount > 0"
                                :disabled="isLoadingMap.read"
                                @click="markAsRead"
                            >
                                <Icon
                                    v-if="isLoadingMap.read"
                                    name="lucide:loader-circle"
                                    class="size-4 animate-spin"
                                />
                                <Icon
                                    v-else
                                    name="ph:envelope-simple-open"
                                    class="size-4 text-primary-600 dark:text-primary-200"
                                />
                                Отметить как прочитанное
                            </button>
                            <button
                                :disabled="isLoadingMap.spamall"
                                @click="() => markAsSpam()"
                            >
                                <Icon
                                    v-if="isLoadingMap.spamall"
                                    name="lucide:loader-circle"
                                    class="size-4 animate-spin"
                                />
                                <Icon
                                    v-else
                                    name="lucide:octagon-alert"
                                    class="size-4 text-yellow-700 dark:text-yellow-200"
                                />
                                Спам
                            </button>
                        </div>
                        <span class="ml-2">
                            От кого
                        </span>
                    </li>
                    <li
                        ref="subjectRefHeader"
                        class="uppercase text-left font-sans font-semibold tracking-wider resize-x overflow-x-auto min-w-60 w-[60rem]"
                    >
                        Сделка, тема и сообщение
                    </li>
                    <li class="uppercase text-left font-sans font-semibold tracking-wider min-w-8">
                        Дата
                    </li>
                </ul>
                <BasePlaceload
                    v-show="emailsLoading"
                    class="h-2 w-full"
                />
                <div
                    v-if="!emailsLoading && !emails.data.length"
                    class="bg-white dark:bg-muted-800 py-4 px-3 text-center"
                >
                    Писем нету
                </div>
                <ul
                    v-if="!emailsLoading && emails.data"
                    class="bg-white dark:bg-muted-800 divide-y divide-muted-200 dark:divide-muted-700 border-t border-t-muted-200 dark:border-t-muted-700 relative w-fit min-w-full"
                >
                    <li
                        v-for="email in emails.data"
                        :key="email.id"
                        class="hover:bg-muted-50 dark:hover:bg-muted-900 transition-colors duration-300 px-4 py-3 cols"
                    >
                        <div
                            :ref="(el) => fromRefs.push(el as HTMLDivElement)"
                            class="flex justify-between items-center gap-2 w-96 min-w-28 from"
                        >
                            <div class="flex items-center">
                                <BaseCheckbox
                                    v-model="selectedEmails"
                                    :value="email"
                                    rounded="sm"
                                    :classes="{wrapper: 'peer z-10'}"
                                />
                                <div
                                    v-if="selectedEmails.length < 2"
                                    class="absolute left-0 h-11 flex items-center bg-muted-200 
                                    font-normal opacity-0 -translate-x-full peer-has-[:checked]:opacity-100 peer-has-[:checked]:translate-x-0 duration-300 
                                    gap-4 px-4 ml-0 text-muted-800 dark:text-muted-200 dark:bg-muted-700 border-l-[3px] border-l-blue-600 dark:border-l-blue-400"
                                >
                                    <button
                                        class="ml-8"
                                        @click="addDealModal.open"
                                    >
                                        <Icon
                                            name="ph:currency-circle-dollar"
                                            class="size-4 text-blue-600 dark:text-blue-400"
                                        />
                                        доб.сделку
                                    </button>
                                    <button @click="addContactModal.open">
                                        <Icon
                                            name="ph:user-plus"
                                            class="size-4 text-primary-600 dark:text-primary-200"
                                        />
                                        доб.контакты
                                    </button>
                                    <button
                                        :disabled="isLoadingMap['delete' + email.id]"
                                        @click="() => deleteConfirmation.open({description: `Вы действительно хотите удалить '${email.subject}'?`})"
                                    >
                                        <Icon
                                            v-if="isLoadingMap['delete' + email.id]"
                                            name="lucide:loader-circle"
                                            class="size-4 animate-spin"
                                        />
                                        <Icon
                                            v-else
                                            name="ph:trash"
                                            class="size-4 text-rose-600 dark:text-rose-400"
                                        />
                                        удалить
                                    </button>
                                    <button
                                        :disabled="isLoadingMap['spam' + email.id]"
                                        @click="() => markAsSpam(email.id)"
                                    >
                                        <Icon
                                            v-if="isLoadingMap['spam' + email.id]"
                                            name="lucide:loader-circle"
                                            class="size-4 animate-spin"
                                        />
                                        <Icon
                                            v-else
                                            name="lucide:octagon-alert"
                                            class="size-4 text-yellow-700 dark:text-yellow-200"
                                        />
                                        Спам
                                    </button>
                                </div>
                                <span class="ml-2">{{ email.from }}</span>
                            </div>
                            <span
                                v-if="!email.read"
                                class="shrink-0 inline-block bg-primary-600 dark:bg-primary-200 w-2.5 h-2.5 rounded-full mx-2"
                            />
                        </div>
                        <button
                            :ref="(el) => subjectRefs.push(el as HTMLButtonElement)"
                            class="flex min-w-60 w-[60rem]"
                            :class="!email.read ? 'font-medium' : ''"
                            @click="() => onEmailToggle(email)"
                        >
                            <span class="text-muted-900 dark:text-white whitespace-nowrap">{{ email.subject }}</span>&nbsp;&minus;&nbsp;
                            <p class="text-muted-600 dark:text-muted-400 max-w-2xl truncate">
                                {{ cleanup(email).snippet }}
                            </p>
                        </button>
                        <span class="min-w-32">{{ email.sent_at ? formatter.format(new Date(email.sent_at)) : "" }}</span>
                    </li>
                </ul>
            </div>
        </main>
        <BasePagination
            v-model:current-page="currentPage"
            class="my-2"
            :item-per-page="perPage"
            :total-items="emails.count"
            :max-links-displayed="10"
            shape="rounded"
        />
        <Transition
            :duration="300"
            name="drawer"
        >
            <div
                v-if="currentEmail"
                class="fixed right-0 top-0 bg-black/40 h-full w-full z-[9999]"
            >
                <div
                    v-click-outside="() => onEmailToggle(undefined)"
                    class="bg-white h-full w-full max-w-[85vw] md:max-w-[80vw] inner ml-auto"
                >
                    <Single :email="currentEmail" />
                </div>
            </div>
        </Transition>
        <AddContactModal
            id="AddContactModal"
            :emails="selectedEmails"
        />
        <AddDealModal
            id="AddDealModal"
            :emails="selectedEmails"
        />
        <Confirmation 
            id="DeleteConfirmation" 
            title="Удалить письмо" 
            description="Вы действительно хотите удалить выбранные письма?" 
            :on-confirm="onDelete"
        />
    </div>
</template>

<script lang="ts" setup>
import DatePicker from "@vuepic/vue-datepicker";
import DOMPurify from "dompurify";
import moment from "moment";

import Confirmation from "~/components/common/Confirmation.vue";
import AddContactModal from "~/components/mail/AddContactModal.vue";
import AddDealModal from "~/components/mail/AddDealModal.vue";
import TairoPopover from "~/components/tairo/TairoPopover.vue";
import { useAsync } from "~/composables/useAsync";
import type { Email } from "~/types/mail";
import type { Stage } from "~/types/stage";

import Single from "./index/[id].vue";

definePageMeta({
    authRoute: true,
    layout: "account",
    verbose: "Почта",
    subject: "Mail"
});

useHead({
    title: "Почта"
});

enum Preset {
    All = "all",
    Unread = "unread",
    Read = "read",
    Autoprocessing = "autoporcessing",
    WithDeal = "with-deal",
    WithoutDeal = "without-deal",
} 

type Filters = {
    from: string;
    subject: string;
    dealLabel: string;
    stages: Stage[];
    withDeal: "" | "yes" | "no";
    withAttachments: "" | "yes" | "no";
    read: "" | "yes" | "no";
    dates: string[];
    direction: "incoming" | "outgoing" | "spam";
    sort: {
        [key in keyof Email]?: number
    },
    skip: number;
    limit: number;
}

const initialFilters: Filters = {
    from: "",
    subject: "",
    dealLabel: "",
    stages: [],
    withDeal: "",
    withAttachments: "",
    read: "",
    dates: [],
    sort: {},
    skip: 0,
    limit: 25,
    direction: "incoming",
};

const toast = useToast("GlobalToast");
const sanitize = DOMPurify.sanitize;
const route = useRoute();
const app = useAppConfig();
const stagesService = useService("stages", {auth: true});
const mailsService = useService("emails", {auth: true});
const addContactModal = useModal("AddContactModal");
const addDealModal = useModal("AddDealModal");
const deleteConfirmation = useModal("DeleteConfirmation");

const isDarkMode = useDarkMode();
const fromRefHeader = ref<HTMLLIElement>();
const subjectRefHeader = ref<HTMLLIElement>();
const fromRefs = ref<HTMLDivElement[]>([]);
const subjectRefs = ref<HTMLButtonElement[]>([]);
const filters = reactive<Filters>({...initialFilters});
const preset = ref<Preset>(Preset.All);
const currentEmail = ref<Email>();
const perPage = ref(app.pagination.defaultPageSize);
const currentPage = ref(route.query.page ? parseInt(route.query.page as string) : 1);
const unread = ref(false);
const selectedEmails = ref<Email[]>([]);
const { data: emails, isLoading: emailsLoading, run: runEmails } = useAsync<{data: Email[], count: number, page_size: number, current_page: number, last_page: number}>({data: [], count: 0, page_size: 0, current_page: 0, last_page: 0});
const { run: runStages, data: stages } = useAsync<Stage[]>([]);
const { runWithId, isLoadingMap } = useAsync();

const sanitizedMap: Record<number, {body: string, snippet: string}> = {};

const unreadCount = computed(() => {
    let count = 0;
    for (const email of emails.value.data) {
        if (!email.read) count++;
    }
    return count;
});

async function onEmailToggle(email?: Email) {
    if (email) {
        document.documentElement.style.overflow = "hidden";
        emails.value.data = emails.value.data.map((e) => e.id === email.id ? ({...e, read: true}) : e);
        mailsService.get(email.id).exec().catch(() => {
            emails.value.data = emails.value.data.map((e) => e.id === email.id ? ({...e, read: false}) : e);
        });
    } else document.documentElement.style.overflow = "auto";
    currentEmail.value = email;
}

const formatter = new Intl.DateTimeFormat("ru", {
    month: "short",
    hour: "numeric",
    minute: "numeric",
    day: "numeric"
});

const presetDates = ref([
    { label: "За сегодня", value: [moment().subtract(1, "day").format("YYYY-MM-DD"), moment().add(1, "day").format("YYYY-MM-DD")] },
    { label: "За вчера", value: [moment().subtract(2, "day").format("YYYY-MM-DD"), moment().format("YYYY-MM-DD")] },
    { label: "За последние 30 дней", value: [moment().subtract(31, "day").format("YYYY-MM-DD"), moment().add(1, "day").format("YYYY-MM-DD")] },
    { label: "За эту неделю", value: [moment().startOf("week"), moment().endOf("week")] },
    { label: "За прошлую неделю", value: [moment().subtract(1, "week").startOf("week"), moment().subtract(1, "week").endOf("week")] },
    { label: "За этот месяц", value: [moment().startOf("month"), moment().endOf("month")] },
]);

function cleanup(email: Email) {
    const body = sanitize(email.body);
    const doc = new DOMParser().parseFromString(body, "text/html");
    const values = {body, snippet: doc.body.textContent?.slice(0, 200) || ""};
    sanitizedMap[email.id] = values;
    email.sanitized = values;
    return values;
}

function onSelectAll(e: Event) {
    const target = e.target as HTMLInputElement;
    if (target.checked) selectedEmails.value = emails.value.data;
    else selectedEmails.value = [];
}

function onPresetSelect(close: Function, e: Event) {
    const target = e.target as HTMLInputElement;
    const preset = target.value as Preset;
    const newFilters = {...initialFilters};
    switch (preset) {
        case Preset.All: {
        } break;
        case Preset.Read: {
            newFilters.read = "no";
        } break;
        case Preset.Unread: {
            newFilters.read = "yes";
        } break;
        case Preset.Autoprocessing: {
        } break;
        case Preset.WithDeal: {
            newFilters.withDeal = "yes";
        } break;
        case Preset.WithoutDeal: {
            newFilters.withDeal = "no";
        } break;
    }

    Object.assign(filters, newFilters);
    close();
    fetchEmails();
}


async function onDelete() {
    const promises = selectedEmails.value.map((email) => runWithId(mailsService.remove(email.id).exec(), "delete" + email.id));
    await Promise.all(promises);
    emails.value.data = emails.value.data.filter((email) => !selectedEmails.value.some((se) => se.id === email.id));
    selectedEmails.value = [];
}

async function markAsRead() {
    const promises = selectedEmails.value.map((email) => runWithId(mailsService.get(email.id).exec(), "read"));
    await Promise.all(promises);
    emails.value.data = emails.value.data.map((email) => selectedEmails.value.some((se) => se.id === email.id) ? ({...email, read: true}) : email);
}

async function markAsSpam(emailId?: number) {
    let promises = [];
    if (emailId) promises.push(runWithId(mailsService.patch(`${emailId}/mark-as-spam`, {}).exec(), "spam" + emailId));
    else promises = selectedEmails.value.map((email) => mailsService.patch(`${email.id}/mark-as-spam`, {}).exec());
    let results = await promiseResult(runWithId(Promise.all(promises), "spamall"));
    if (!results.ok) return toast.show({message: results.error.message, type: "error", timeout: 3000});

    if (emailId) {
        emails.value.data = emails.value.data.filter((email) => email.id !== emailId);
        selectedEmails.value = selectedEmails.value.filter((email) => email.id !== emailId);
    } else {
        emails.value.data = emails.value.data.filter((email) => !selectedEmails.value.some((se) => se.id === email.id));
        selectedEmails.value = [];
    }
}

// live: mail fetched from the server or sent by others appears by itself
useLive((changes) => { if (liveTouches(changes, "emails")) fetchEmails(); }, 1000);

function fetchEmails(sync?: boolean) {
    const outgoing = filters.direction === "outgoing";
    const isSpam = filters.direction === "spam";
    const query: Record<string, any> = {
        outgoing, 
        sort: { sent_at: -1 },
        skip: (currentPage.value - 1) * perPage.value,
        limit: perPage.value,
        is_spam: isSpam,
    };

    if (filters.stages.length) {
        query.stages = filters.stages.map((s) => s.id);
    }

    if (filters.dates?.length === 2) {
        query.till_date = filters.dates[1];
        query.from_date = filters.dates[0];
    }

    if (filters.dealLabel) {
        query.deal_label = filters.dealLabel;
    }

    if (filters.withDeal) {
        query.with_deal = filters.withDeal === "yes";
    }

    if (filters.withAttachments) {
        query.with_attachments = filters.withAttachments === "yes";
    }

    if (filters.read) {
        query.read = filters.read === "no";
    }

    if (filters.email_to?.value) {
        query.email_to = filters.email_to.value;
    }

    if (!sync) return runEmails(mailsService.find(query).exec());

    // The sync endpoint answers with the refreshed list. If the mail server
    // cannot be reached, say so and still show what is stored locally.
    runEmails(
        mailsService.get("sync", query).exec().catch((e: any) => {
            toast.show({
                message: `Не удалось получить новую почту: ${e?.message ?? "ошибка сервера"}`,
                type: "error",
                timeout: 5000,
            });
            return mailsService.find(query).exec();
        }) as Promise<any>,
    );
}

function updateWidth(els: HTMLElement[], width: number) {
    return () => {
        for (const el of els) el.style.width = `${width}px`;
    };
}

const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
        if (entry.target !== fromRefHeader.value && entry.target !== subjectRefHeader.value) continue;

        if (entry.target === fromRefHeader.value) {
            window.requestAnimationFrame(updateWidth(fromRefs.value, fromRefHeader.value!.offsetWidth));
        }
        if (entry.target === subjectRefHeader.value) {
            window.requestAnimationFrame(updateWidth(subjectRefs.value, subjectRefHeader.value!.offsetWidth));
        }
    }
});

watch(() => [currentPage.value, perPage.value, filters.direction], () => fetchEmails());


type AgentEmail = { id: number; value: string; };
type AgentEmailResponse = AgentEmail[];

const { run: runAgentEmails, data: agentEmails, loading: agentEmailsLoading } = useAsync<{data: AgentEmailResponse[], count: number}>({ data: [], count: 0 });
const agentEmailService = useService("emails/agents-email", {auth: true});

async function fetchAgentEmails(search?: string) {
    try {
        const queryParams = { search, "sort[id]": -1 };
        runAgentEmails(agentEmailService.find<AgentEmailResponse>(queryParams).exec());
    } catch (error) {
        console.error("Failed to fetch agent emails:", error);
    }
}

const onEmailInput = debounce((e: Event) => {
    const target = e.target as HTMLInputElement;
    fetchAgentEmails(target.value);
}, 500);

const onEmailChange = (value: AgentEmail) => {
    filters.email_to = value;
    fetchEmails();
};

onMounted(() => {
    runStages(stagesService.find().exec());
    fetchEmails();
    fetchAgentEmails();
    if (fromRefHeader.value) resizeObserver.observe(fromRefHeader.value);
    if (subjectRefHeader.value) resizeObserver.observe(subjectRefHeader.value);
});

onUnmounted(() => {
    resizeObserver.disconnect();
});

</script>

<style scoped>
.drawer-enter-active .inner,
.drawer-leave-active .inner {
    transition: all 0.3s ease-in-out;
}
.drawer-enter-from .inner,
.drawer-leave-to .inner {
    transform: translateX(100%);
    opacity: 0;
}

.cols {
    display: grid;
    grid-template-areas: "from subject date";
    grid-template-columns: min-content minmax(min-content, auto) minmax(min-content, 1fr);
}

</style>
