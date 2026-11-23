<template>
    <div class="flex flex-col gap-8">
        <div>
            <h1 class="text-xl">
                Контакты
            </h1>
            <h2 class="text-sm text-gray-500">
                Список контактов
            </h2>
        </div>
        <div class="flex flex-wrap gap-5 justify-between">
            <div class="flex items-center gap-4 flex-1">
                <PerPageSelect v-model="perPage" />
                <!-- contacts from Telegram, WhatsApp and calls have no company: they are listed too -->
                <BaseListbox
                    v-model="scope"
                    class="max-w-[12rem] w-full"
                    :items="scopes"
                    :properties="{ value: 'id', label: 'label' }"
                    name="scope"
                />
                <TairoPopover
                    fixed
                    size="2md"
                >
                    <BaseButton><Icon name="ph:funnel" /></BaseButton>
                    <template #content="{close}">
                        <div class="flex gap-4 p-4">
                            <section class="max-w-[16rem] w-full">
                                <ul class="flex flex-col gap-1">
                                    <li class="w-full">
                                        <input
                                            :id="'preset-' + Preset.All"
                                            v-model="preset"
                                            type="radio"
                                            name="preset"
                                            :value="Preset.All"
                                            class="apperance-none opacity-0 h-0 absolute -z-10 peer"
                                            @change="onPresetSelect(close, $event)"
                                        >
                                        <label
                                            :for="'preset-' + Preset.All"
                                            class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 dark:hover:text-primary-200 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start"
                                        >
                                            Весь список
                                        </label>
                                    </li>
                                    <!-- <li class="w-full">
                                        <input type="radio" name="preset" :value="Preset.WithNoTasks" v-model="preset" :id="'preset-' + Preset.WithNoTasks" class="apperance-none opacity-0 h-0 absolute -z-10 peer" @change="onPresetSelect(close, $event)">
                                        <label :for="'preset-' + Preset.WithNoTasks" class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 dark:hover:text-primary-200 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start">
                                            Контакты без задач
                                        </label>
                                    </li> -->
                                    <li class="w-full">
                                        <input
                                            :id="'preset-' + Preset.WithOverdueTasks"
                                            v-model="preset"
                                            type="radio"
                                            name="preset"
                                            :value="Preset.WithOverdueTasks"
                                            class="apperance-none opacity-0 h-0 absolute -z-10 peer"
                                            @change="onPresetSelect(close, $event)"
                                        >
                                        <label
                                            :for="'preset-' + Preset.WithOverdueTasks"
                                            class="nui-button nui-button-medium nui-button-rounded nui-button-pastel dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 dark:hover:text-primary-200 hover:text-primary-600 dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full justify-start"
                                        >
                                            Контакты с просроченными...
                                        </label>
                                    </li>
                                </ul>
                            </section>
                            <form
                                class="flex items-start flex-col gap-2 w-full px-2 overflow-hidden"
                                @submit.prevent="fetchContacts"
                            >
                                <details
                                    v-animated-details
                                    class="w-full"
                                >
                                    <summary
                                        class="border border-muted-300 h-10 py-2 px-3 rounded-md text-sm text-muted-300 cursor-pointer dark:border-muted-700 dark:bg-muted-900"
                                        :class="[filters.dates?.length ? 'text-muted-600' : '']"
                                    >
                                        <template v-if="filters.dates?.length === 2">
                                            <span v-if="filters.dateType === DateType.Created">Созданы: </span>
                                            <span v-else-if="filters.dateType === DateType.Updated">Изменены: </span>
                                            <span>{{ filters.dates[0] }} - {{ filters.dates[1] }}</span>
                                        </template>
                                        <span v-else>За все время</span>
                                    </summary>
                                    <div class="content p-2 flex flex-col gap-2">
                                        <ul class="flex gap-2 w-full">
                                            <li class="flex-1">
                                                <input
                                                    id="contact-created"
                                                    v-model="filters.dateType"
                                                    type="radio"
                                                    name="contact-date"
                                                    :value="DateType.Created"
                                                    class="apperance-none opacity-0 h-0 absolute -z-10 peer"
                                                    checked
                                                >
                                                <label
                                                    for="contact-created"
                                                    class="nui-button nui-button-medium nui-button-rounded nui-button-pastel
            dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600
            dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full"
                                                >Созданы</label>
                                            </li>
                                            <li class="flex-1">
                                                <input
                                                    id="contact-updated"
                                                    v-model="filters.dateType"
                                                    type="radio"
                                                    name="contact-date"
                                                    :value="DateType.Updated"
                                                    class="apperance-none opacity-0 h-0 absolute -z-10 peer"
                                                >
                                                <label
                                                    for="contact-updated"
                                                    class="nui-button nui-button-medium nui-button-rounded nui-button-pastel
            dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600
            dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600 w-full"
                                                >Изменены</label>
                                            </li>
                                        </ul>
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
                                    </div>
                                </details>
                                <BaseListbox
                                    v-model="filters.stages"
                                    :items="stages"
                                    :properties="{label: 'name', value: 'id' }"
                                    multiple
                                    :fixed="true"
                                    placeholder="Все этапы"
                                    :multiple-label="(value, prop) => {
                                        if (!value.length) return;
                                        else return `Этапы: ${value.map(v => v[prop]).join(', ')}`;
                                    }"
                                    name="stages"
                                />
                                <BaseListbox
                                    v-model="filters.tasks"
                                    :items="taskTypes"
                                    :properties="{label: 'label', value: 'id' }"
                                    :fixed="true"
                                    :multiple="true"
                                    placeholder="Задачи"
                                    :multiple-label="(value, prop) => {
                                        if (!value.length) return;
                                        else return `Задачи: ${value.map(v => v[prop]).join(', ')}`;
                                    }"
                                    name="tasks"
                                />
                                <BaseAutocomplete
                                    v-model="filters.createdBy"
                                    placeholder="Кем создана"
                                    :fixed="true"
                                    :items="employees"
                                    :properties="{label: 'username', value: 'id', sublabel: (u: User) => u.group?.name}"
                                    dropdown
                                    name="created_by"
                                    clearable
                                    :display-value="(user?: User) => user?.username ? `Создан: ${user.username}` : ''"
                                />
                                <BaseAutocomplete
                                    v-model="filters.updatedBy"
                                    placeholder="Автор изменения"
                                    :fixed="true"
                                    :items="employees"
                                    :properties="{label: 'username', value: 'id', sublabel: (u: User) => u.group?.name}"
                                    dropdown
                                    name="updated_by"
                                    clearable
                                    :display-value="(user?: User) => user?.username ? `Изменил: ${user.username}` : ''"
                                />
                                <BaseButton type="submit">
                                    Применить
                                </BaseButton>
                            </form>
                        </div>
                    </template>
                </TairoPopover>
                <div class="max-w-xs w-full" />
            </div>
            <Can
                I="create"
                a="Contact"
            >
                <NuxtLink
                    :to="{name: 'lists-contacts-id', params: {id: 'new'}}"
                    class="border border-gray-300 dark:border-muted-600 rounded-md"
                >
                    <BaseButton color="primary">
                        Новый контакт
                    </BaseButton>
                </NuxtLink>
            </Can>
        </div>
        <div>
            <!-- one box: the name, the phone (any format) or the e-mail, without choosing a field first -->
            <Search
                v-model="searchQ"
                :debounce="600"
                :fields="fields"
                :ilike="false"
            />
        </div>
        <div class="relative overflow-x-auto">
            <BaseTable
                id="contacts"
                v-model:sort-by="sortBy"
                :columns="columns"
                :data="contacts.data"
                :loading="contactsLoading"
                class="flex-auto"
            >
                <template #actions="{item}">
                    <BaseButtonIcon
                        size="sm"
                        :to="{name: item.type === 'ctr_agent' ? 'lists-contacts-id' : 'lists-companies-id', params: {id: item.id}}"
                    >
                        <Icon
                            class="w-5 h-5"
                            name="ph:pencil-simple"
                        />
                    </BaseButtonIcon>
                </template>
            </BaseTable>
            <BasePagination
                v-if="contacts.count / perPage > 1"
                v-model:current-page="currentPage"
                class="my-2"
                :item-per-page="perPage"
                :total-items="contacts.count"
                :max-links-displayed="10"
                shape="rounded"
            />
        </div>
    </div>
</template>

<script lang="ts" setup>
import { Can } from "@casl/vue";
import DatePicker from "@vuepic/vue-datepicker";
import moment from "moment";
import { onMounted } from "vue";

import BaseTable from "~/components/common/BaseTable.vue";
import PerPageSelect from "~/components/common/PerPageSelect.vue";
import Search from "~/components/common/Search.vue";
import {type Column} from "~/components/common/types";
import TairoPopover from "~/components/tairo/TairoPopover.vue";
import { useAsync } from "~/composables/useAsync";
import {type PaginatedResponse} from "~/types/generics";
import type { Stage } from "~/types/stage";
import { type Contact, type User,UserRole } from "~/types/user";

definePageMeta({
    authRoute: true,
    layout: "account",
    verbose: "Контакты",
    subject: "Contact"
});

useHead({
    title: "Контакты"
});

enum Preset {
    All = "all",
    WithOverdueTasks = "overdue-tasks",
    WithNoTasks = "no-tasks",
}

enum DateType {
    Created = "created",
    Updated = "updated"
}


const overdueTaskType = {
    id: "overdue",
    label: "Просроченные"
};

// «Закрыте» sent tasks=closed, which the API does not know (400)
const taskTypes = [
    {
        id: "no_task",
        label: "Без задач"
    },
    overdueTaskType,
];

enum Scope {
    All = "all",
    WithCompany = "with",
    WithoutCompany = "without",
}
const scopes = [
    { id: Scope.All, label: "Все контакты" },
    { id: Scope.WithCompany, label: "С компанией" },
    { id: Scope.WithoutCompany, label: "Без компании" },
];

type Filters = {
    dates?: string[];
    stages: Stage[];
    createdBy?: User;
    updatedBy?: User;
    dateType: DateType;
    tasks: typeof taskTypes[0][];
}

const route = useRoute();
const initialFilters: Filters = {
    dates: [],
    stages: [],
    dateType: DateType.Created,
    tasks: [],
    ...(route.query.user_id && {createdBy: {id: Number(route.query.user_id), username: route.query.username} as User})
};

const app = useAppConfig();
const contactsService = useService("contacts", {auth: true});
const stageService = useService("stages", {auth: true});
const userService = useService("users", {auth: true});
const searchQ = ref<Record<string, any>>({});
const scope = ref(scopes[0]);
const filters = reactive<Filters>({...initialFilters});
const perPage = ref(app.pagination.defaultPageSize);
const currentPage = ref(route.query.page ? parseInt(route.query.page as string) : 1);
const dateFilter = reactive({start: "", end: ""});
const sortBy = ref<Record<string, any>>({id: -1});
const preset = ref<Preset>(Preset.All);
const { run: runStages, data: stages } = useAsync<Stage[]>([]);
const { data: contacts, run: runContacts, isLoading: contactsLoading } = useAsync<PaginatedResponse<Contact>>({
    data: [],
    count: 0,
    current_page: 0,
    last_page: 0,
    page_size: perPage.value
});

// the staff only (GET /users/staff): GET /users?limit=1000 mixed them with the contacts
const { run: runUsers, data: users } = useAsync<PaginatedResponse<User>>({
    count: 0,
    data: [],
    last_page: 0,
    page_size: 1000,
    current_page: 0,
});

const isDarkMode = useDarkMode();

const presetDates = ref([
    { label: "За сегодня", value: [moment().subtract(1, "day").format("YYYY-MM-DD"), moment().add(1, "day").format("YYYY-MM-DD")] },
    { label: "За вчера", value: [moment().subtract(2, "day").format("YYYY-MM-DD"), moment().format("YYYY-MM-DD")] },
    { label: "За последние 30 дней", value: [moment().subtract(31, "day").format("YYYY-MM-DD"), moment().add(1, "day").format("YYYY-MM-DD")] },
    { label: "За эту неделю", value: [moment().startOf("week"), moment().endOf("week")] },
    { label: "За прошлую неделю", value: [moment().subtract(1, "week").startOf("week"), moment().subtract(1, "week").endOf("week")] },
    { label: "За этот месяц", value: [moment().startOf("month"), moment().endOf("month")] },
    { label: "За прошлый месяц", value: [moment().subtract(1, "month").startOf("month"), moment().subtract(1, "month").endOf("month")] },
    { label: "За квартал", value: [moment().startOf("quarters"), moment().endOf("quarters")] },
    { label: "За этот год", value: [moment().startOf("year"), moment().endOf("year")] },
]);

// the API gives phones[] and emails[] (the «Почта» column read `email` and was always empty)
const columns = ref<Column[]>([
    {
        label: "Имя",
        name: "name",
        resizable: true,
        sortable: true,
        headerStyle: {
            minWidth: "200px",
        },
        link(value) {
            if (value.type === "ctr_agent") return {name: "lists-contacts-id", params: {id: value.id}};
            if (value.type === "company") return {name: "lists-companies-id", params: {id: value.id}};
            return "";
        }
    },
    {
        label: "Телефон",
        name: "phone",
        sortable: true,
        phone: true,
        headerStyle: {
            minWidth: "160px",
        },
        field: (value) => value.phones?.[0] ?? "",
    },
    {
        label: "Почта",
        name: "email",
        resizable: true,
        sortable: true,
        headerStyle: {
            minWidth: "200px",
        },
        field: (value) => value.emails?.[0] ?? "",
    },
    {
        label: "Компания",
        name: "company",
        resizable: true,
        sortable: true,
        headerStyle: {
            minWidth: "200px",
        },
        field: (value) => {
            return value.company?.name ?? "";
        },
        link(value) {
            return value.company?.id ? {name: "lists-companies-id", params: {id: value.company.id}} : "";
        }
    },
    {
        label: "Ответственный",
        name: "agent",
        headerStyle: {
            minWidth: "160px",
        },
        field: (value) => value.agent?.username ?? "",
    },
    {
        label: "Последнее касание",
        name: "last_activity_at",
        dateFormat: "DD.MM.YYYY, HH:mm",
        headerStyle: {
            minWidth: "160px",
        },
    },
    {
        label: "",
        name: "actions",
        headerStyle: {
            width: "100px"
        }
    }
]);

// one field: the box needs no «Поиск по…» (it searched nothing until a field was chosen)
const fields: {key: string, label: string}[] = [
    {
        label: "Имя, телефон или почта",
        key: "q",
    },
];

const employees = computed(() => {
    return (users.value.data ?? []).filter((u) => u.role !== UserRole.CtrAgent);
});

function onPresetSelect(close: Function, e: Event) {
    const target = e.target as HTMLInputElement;
    const preset = target.value as Preset;
    const newFilters = {...initialFilters};
    switch (preset) {
        case Preset.All: {
        } break;
        case Preset.WithNoTasks: {
        } break;
        case Preset.WithOverdueTasks: {
            newFilters.tasks = [overdueTaskType];
        } break;
    }

    Object.assign(filters, newFilters);
    fetchContacts();
    close();
}

// The search, the filters, the page and the sorting go in one request: the search used to be a request
// of its own, and a page change dropped it. Contacts only (role=ctr_agent), with or without a company.
function fetchContacts() {
    const query: Record<string, any> = {
        skip: (currentPage.value - 1) * perPage.value,
        limit: perPage.value,
        sort: sortBy.value,
        role: UserRole.CtrAgent,
    };

    const text = String(searchQ.value?.q ?? "").trim();
    if (text) query.q = text;

    if (scope.value?.id === Scope.WithCompany) query.employees = true;
    else if (scope.value?.id === Scope.WithoutCompany) query.employees = false;

    if (filters.stages.length) {
        query.stages = filters.stages.map((s) => s.id);
    }

    if (filters.dates?.length === 2) {
        const [beforeKey, afterKey] = filters.dateType === DateType.Created ? ["created_before", "created_after"] : ["updated_before", "updated_after"];
        query[beforeKey] = filters.dates[1];
        query[afterKey] = filters.dates[0];
    }

    if (filters.createdBy?.id) {
        query.created_by = filters.createdBy.id;
    }

    if (filters.updatedBy?.id) {
        query.updated_by = filters.updatedBy.id;
    }

    if (filters.tasks.length) {
        query.tasks = filters.tasks.map((t) => t.id);
    }

    runContacts(contactsService.find(query).exec());
}

// a new search or scope starts from the first page
watch([searchQ, scope], () => {
    if (currentPage.value !== 1) currentPage.value = 1;
    else fetchContacts();
});

watch([currentPage, sortBy, perPage, dateFilter], fetchContacts);

onMounted(() => {
    runStages(stageService.find().exec());
    fetchContacts();
    runUsers(userService.get("staff").exec());
});
</script>
