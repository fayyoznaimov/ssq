<template>
    <!-- one column on a phone (the card, then the history), 4 + 8 from lg -->
    <div class="grid grid-cols-12 gap-x-0 gap-y-6 lg:gap-8 px-4 lg:px-10 lg:h-[calc(100vh-6.4rem)]">
        <section class="col-span-12 lg:col-span-4 rounded-md min-w-0">
            <BaseTabs 
                v-model="activeTab"
                :tabs="contactTabs"
            >
                <template #tab="{activeValue}">
                    <form
                        v-if="activeValue === 'general'"
                        class="flex flex-col gap-3"
                        novalidate
                        @submit.prevent="onSubmit"
                    >
                        <BaseInput
                            v-model="contact.username"
                            type="text"
                            label="Имя*"
                            name="name"
                            placeholder="пр.: Андрей"
                            icon="ph:buildings"
                            :loading="contactLoading"
                            required
                            :error="errors.username"
                            @input="(e: Event) => onChange('username', (e.target as HTMLInputElement).value)"
                        />
                        <BaseInput
                            v-model="contact.phone"
                            type="text"
                            label="Номер телефона"
                            name="phone"
                            placeholder="пр.: +998901200000"
                            icon="ph:phone"
                            :loading="contactLoading"
                            required
                            :error="errors.phone"
                            @input="(e: Event) => onChange('phone', (e.target as HTMLInputElement).value)"
                        />
                        <BaseInput
                            v-model="contact.email"
                            type="email"
                            label="Электронная почта"
                            name="email"
                            placeholder="пр.: andrei@example.com"
                            icon="ph:envelope"
                            :loading="contactLoading"
                            required
                            :error="errors.email"
                            @input="(e: Event) => onChange('email', (e.target as HTMLInputElement).value)"
                        />
                        <BaseAutocomplete
                            v-model="contact.company"
                            :items="companies.data"
                            :display-value="(company: Company) => company?.name"
                            :properties="{ value: 'id', label: 'name' }"
                            label="Компания"
                            clearable
                            dropdown
                            name="company"
                            :error="errors.company"
                            required
                            @input="onCompanyInput"
                            @change="(c: Company) => onChange('company', c.id)"
                        />
                        <ul class="flex flex-col gap-3">
                            <li
                                v-for="(filler, idx) in contact.user_fillers"
                                class="flex items-end gap-2"
                            >
                                <input
                                    type="hidden"
                                    name="fillers"
                                    :value="filler.id"
                                >
                                <input
                                    type="hidden"
                                    :name="`fillers.${filler.id}.${idx}.tempId`"
                                    :value="filler.tempId"
                                >
                                <input
                                    v-if="filler.new"
                                    type="hidden"
                                    :name="`fillers.${filler.id}.${idx}.new`"
                                    value="new"
                                >
                                <BaseInput 
                                    :key="filler.tempId" 
                                    v-model="filler.value" 
                                    :classes="{wrapper: 'w-full', inputWrapper: 'flex gap-2'}" 
                                    :label="filler.filler.field" 
                                    :name="`fillers.${filler.id}.${idx}`"
                                    :required="filler.filler.is_required"
                                    :error="errors[filler.tempId]"
                                    @input="(e: Event) => onChange(filler.tempId, (e.target as HTMLInputElement).value)"
                                >
                                    <template #action>
                                        <BaseButtonIcon
                                            rounded="md"
                                            @click="() => onAddtionalFillerValue(idx, filler)"
                                        >
                                            <Icon
                                                name="ph:plus"
                                                class="size-4"
                                            />
                                        </BaseButtonIcon>
                                    </template>
                                </BaseInput>
                            </li>
                        </ul>
                        <div class="flex flex-col gap-2 mt-4">
                            <Can
                                I="delete"
                                a="Contact"
                            >
                                <BaseButton
                                    v-if="contact.id"
                                    color="danger"
                                    :loading="isLoadingMap.delete"
                                    :disabled="isLoadingMap.delete"
                                    @click="onDelete"
                                >
                                    Удалить
                                </BaseButton>
                            </Can>
                            <Can
                                v-if="!contactLoading"
                                :I="contact.id ? 'update' : 'create'"
                                a="Contact"
                            >
                                <BaseButton
                                    color="primary"
                                    type="submit"
                                    :disabled="isLoadingMap.save"
                                    :loading="isLoadingMap.save"
                                >
                                    Сохранить
                                </BaseButton>
                            </Can>
                        </div>
                    </form>
                    <!--  every deal of the contact, with links  -->
                    <ContactDeals
                        v-if="activeValue === 'deals'"
                        :contact-id="contact.id"
                    />
                    <div
                        v-if="activeValue === 'settings'"
                        class="flex flex-col gap-4"
                    >
                        <div
                            v-for="(filler, idx) in fillers.user"
                            class="flex items-center gap-3"
                        >
                            <details
                                :open="openFiller === idx"
                                class="w-full"
                            >
                                <summary
                                    v-show="openFiller !== idx"
                                    @click="openFiller = idx"
                                >
                                    <BaseInput
                                        v-model="filler.field"
                                        type="text"
                                        placeholder="пр.: "
                                        icon="ph:textbox"
                                        :classes="{wrapper: 'w-full'}"
                                        :form="'filler' + filler.id"
                                        name="field"
                                    />
                                </summary>
                                <BaseInput
                                    ref="fieldRefs"
                                    v-model="filler.field"
                                    type="text"
                                    placeholder="пр.: "
                                    icon="ph:textbox"
                                    :classes="{wrapper: 'w-full'}"
                                    :form="'filler' + filler.id"
                                    name="field"
                                />
                                <BaseSwitchThin
                                    v-model="filler.is_required"
                                    :form="'filler' + filler.id"
                                    name="required"
                                    label="Обязательное поле"
                                    :classes="{wrapper: 'mt-4 max-w-fit'}"
                                />
                                <div class="flex gap-2 mt-4">
                                    <form
                                        :id="'filler' + filler.id"
                                        @submit.prevent="onFillerSave"
                                    >
                                        <input
                                            type="hidden"
                                            name="action_id"
                                            :value="`save${filler.id}`"
                                        >
                                        <input
                                            type="hidden"
                                            name="id"
                                            :value="filler.id"
                                        >
                                        <input
                                            type="hidden"
                                            name="idx"
                                            :value="idx"
                                        >
                                        <input
                                            v-if="filler.id < 0"
                                            type="hidden"
                                            name="new"
                                            value="new"
                                        >
                                        <BaseButton
                                            size="sm"
                                            type="submit"
                                            :loading="isLoadingMap[`save${filler.id}`]"
                                        >
                                            Сохранить
                                        </BaseButton>
                                    </form>
                                    <form @submit.prevent="onFillerDelete">
                                        <input
                                            v-if="filler.id < 0"
                                            type="hidden"
                                            name="new"
                                            value="new"
                                        >
                                        <input
                                            type="hidden"
                                            name="action_id"
                                            :value="`delete${filler.id}`"
                                        >
                                        <input
                                            type="hidden"
                                            name="id"
                                            :value="filler.id"
                                        >
                                        <input
                                            type="hidden"
                                            name="idx"
                                            :value="idx"
                                        >
                                        <BaseButton
                                            color="danger"
                                            size="sm"
                                            type="submit"
                                            :loading="isLoadingMap[`delete${filler.id}`]"
                                        >
                                            Удалить
                                        </BaseButton>
                                    </form>
                                </div>
                            </details>
                        </div>
                        <BaseButton
                            v-if="currentUser?.role === UserRole.Admin"
                            variant="pastel"
                            class="w-full"
                            @click="addFiller"
                        >
                            <Icon
                                class="size-4 mr-2"
                                name="ph:plus"
                            />
                            Добавить поле
                        </BaseButton>
                    </div>
                </template>
            </BaseTabs>
        </section>
        <section class="col-span-12 lg:col-span-8 flex flex-col relative min-w-0 min-h-[60vh]">
            <EventsList 
                :events="events" 
                :classes="{wrapper: 'max-h-[calc(100%-4rem)]'}" 
                :events-loading="eventsLoading" 
                :intersected="onIntersect" 
                :start-observer="!!route.params.id"
            />
            <div class="mb-8 my-4 space-y-2">
                <form
                    id="compose-form"
                    class="flex flex-wrap lg:flex-nowrap gap-2"
                    @submit.prevent="onEvent"
                >
                    <BaseListbox
                        v-model="messageType"
                        class="max-w-[10rem]"
                        name="message_type"
                        value="chat"
                        :items="messageTypes"
                        :properties="{ value: 'id', label: 'label' }"
                        size="md"
                        form="compose-form"
                    />
                    <EventSchedulerSingle
                        v-if="messageType.id === 'task'" 
                        v-model="task" 
                        :agent="currentUser" 
                        size="md" 
                        :initial-date="task.start" 
                    />
                </form>
                <EmailReplyForm 
                    v-if="messageType.id === 'email'" 
                    :reply-options="[contact.email]"
                    :to="toEmail"
                />
                <BaseTextarea
                    v-if="messageType.id === 'tg' || messageType.id === 'task'"
                    ref="commentRef"
                    v-model="content"
                    :rows="3"
                    addon
                    placeholder="Сообщение"
                    resize
                    size="lg"
                    name="content"
                    required
                    minlength="3"
                    form="compose-form"
                >
                    <template #addon>
                        <BaseButton
                            size="sm"
                            type="submit"
                            form="compose-form"
                        >
                            <div>
                                Отправить
                            </div>
                        </BaseButton>
                        <label class="cursor-pointer">
                            <Icon
                                name="ph:paperclip"
                                size="20"
                            />
                            <input
                                type="file"
                                name="files"
                                class="hidden"
                                multiple
                                form="compose-form"
                            >
                        </label>
                    </template>
                </BaseTextarea>
            </div>
        </section>
    </div>
</template>

<script lang="ts" setup>
import { Can } from "@casl/vue";

import type BaseTabs from "~/components/base/BaseTabs.vue";
import EventSchedulerSingle from "~/components/common/EventSchedulerSingle.vue";
import ContactDeals from "~/components/company/ContactDeals.vue";
import EventsList from "~/components/common/EventsList.vue";
import EmailReplyForm from "~/components/mail/EmailReplyForm.vue";
import { useAsync } from "~/composables/useAsync";
import { useValidation } from "~/composables/useValidation";
import { type DealEvent, DealEventType, type DealFile, type Task, type TaskType } from "~/types/deal";
import type { Filler, FillerValue } from "~/types/filler";
import { type Company, type Group,type User, UserRole } from "~/types/user";

definePageMeta({
    authRoute: true,
    layout: "no-min-height",
    verbose: "Новый контакт",
});

useHead({
    title: "Новый контакт"
});

type TaskEventProps = {
    label: string;
    type_id: number;
    assign_to: {
        target: string,
        id: number;
    }
    link_to: {
        target: string;
        id: number;
    },
    start_time: string;
    end_time: string;
    allDay: boolean;
    group?: Group;
    agent?: User;
    type: TaskType;
}

let fakeId = -1;
let currentPage = 0;

const emailMessageType = {
    id: "email",
    label: "E-mail"
};

const tgMessageType = {
    id: "tg",
    label: "Телеграм"
};

const taskMessageType = {
    id: "task",
    label: "Задача"
};

const limit = 25;
const route = useRoute();
const toast = useToast("GlobalToast");
const companiesService = useService("companies", {auth: true});
const taskService = useService("tasks", {auth: true});
const userService = useService("users", {auth: true});
const fillersService = useService("fillers", {auth: true});
const telegramService = useService("telegram", {auth: true});
const openFiller = ref();
const fieldRefs = ref();
const eventsEnded = ref(false);
const activeTab = ref("general");
const contactTabs = computed(() => [
    { label: "Общее", value: "general" },
    ...(route.params.id !== "new" ? [{ label: "Сделки", value: "deals" }] : []),
    { label: "Настройка", value: "settings" },
]);
const messageType = ref<typeof emailMessageType>(taskMessageType);
const toEmail = ref("");
const commentRef = ref();
const content = ref("");
const { data: events, runAsync: runEventsAsync, isLoading: eventsLoading, reset: resetEvents } = useInfiniteQuery<
    {data: DealEvent[]; count: number; page_size: number; current_page: number; last_page: number;}
>({data: [], count: 0, page_size: 0, current_page: 0, last_page: 0});
const { data: fillers, run: runFillers, isLoading: fillersLoading } = useAsync<{user: Filler[]}>({ user: [] });
const { data: contact, run: runContact, isLoading: contactLoading } = useAsync<User>({ role: UserRole.CtrAgent });

const { data: companies, run: runCompanies } = useAsync<{data: Company[]}>({data: []});
const { runWithId, isLoadingMap } = useAsync();
const currentUser = useState<User>("user");

const schema: Schema<string> = {
    username: [required("Обязательное поле")],
    company: [required("Обязательное поле")],
    email: [required("Обязательное поле"), validEmail("Неверный формат почты")],
    phone: [required("Обязательное поле"), validPhone("Неверный номер телефона")],
};

const {onChange, validate, errors} = useValidation(schema);

const end = new Date();
const start = new Date().toISOString();
end.setMinutes(end.getMinutes() + 30);
const endStr = end.toISOString();
const task = ref<Partial<Task>>({
    id: -1,
    label:  "",
    result: null,
    closed_at: "",
    start_time: start,
    start: start,
    end: endStr,
    end_time: endStr,
    created_at: new Date().toISOString(),
    allDay: false
});

function addFiller() {
    if (!fillers.value.user) fillers.value.user = [];
    fillers.value.user.push({
        id: --fakeId,
        field: "",
        target: "user",
        created_at: new Date().toISOString(),
        is_required: false,
    });
}

function onAddtionalFillerValue(idx: number, filler: FillerValue) {
    let fillerValue = {...filler, id: filler.filler.id, value: "", new: true, tempId: Math.random().toString(32).slice(2)};
    contact.value.user_fillers.splice(idx + 1, 0, fillerValue);
    schema[fillerValue.tempId] = [required("Обязательное поле")];
}

const onCompanyInput = debounce((e: Event) => {
    const target = (e.target as HTMLInputElement);
    runCompanies(companiesService.find({name: target.value}).exec());
}, 300);

async function onFillerSave(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const isNew = formData.get("new");
    const field = formData.get("field");
    const isRequired = formData.get("required") === "on";
    const idx = Number(formData.get("idx") as string);
    const id = Number(formData.get("id") as string);
    const actionId = formData.get("action_id") as string;

    if (isNew) {
        const result = await promiseResult(runWithId(fillersService.create({ field, target: "user", is_required: isRequired }).exec(), actionId));
        if (!result.ok) return toast.show({ message: result.error.message, type: "error", timeout: 3000 });
        fillers.value.user.splice(idx, 1, result.value as Filler);
        return;
    }

    const result = await promiseResult(runWithId(fillersService.patch(id, { field, target: "user", is_required: isRequired }).exec(), actionId));
    if (!result.ok) toast.show({message: result.error.message, type: "error", timeout: 3000});
}

async function onFillerDelete(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const isNew = formData.get("new");
    const actionId = formData.get("action_id") as string;
    const id = Number(formData.get("id") as string);
    if (isNew) {
        fillers.value.user = fillers.value.user.filter((f) => f.id !== id);
        return;
    }

    const result = await promiseResult(runWithId(fillersService.remove(id).exec(), actionId));
    if (!result.ok) return toast.show({ message: result.error.message, type: "error", timeout: 3000 });
    fillers.value.user = fillers.value.user.filter((f) => f.id !== id);
}

async function onSubmit(e: Event) {
    const { id, username, phone, email, role, permissions, company } = contact.value;
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const fillerIds = formData.getAll("fillers");
    const fillersCreate = [];
    const fillers = [];
    const fieldsMap: Record<string, string> = {};

    for (let i = 0, len = fillerIds.length; i < len; i++) {
        const id = fillerIds[i];
        const value = formData.get(`fillers.${id}.${i}`) as string;
        const tempId = formData.get(`fillers.${id}.${i}.tempId`) as string;
        const isNew = formData.get(`fillers.${id}.${i}.new`);
        if (!value) continue;
        if (isNew) fillersCreate.push({ filler_id: Number(id), value });
        else fillers.push({ user_filler_id: Number(id), value });
        fieldsMap[tempId] = value;
    }

    const validationResult = validate({
        email,
        phone,
        username,
        company: company?.id,
        ...fieldsMap,
    });

    if (!validationResult.valid) return;

    let promise;
    if (id) promise = userService.patch(id, { username, phone, role, permissions, email, company_id: company?.id, fillers, fillers_create: fillersCreate }).exec();
    else promise = userService.create({ username, phone, email, role, permissions, company_id: company?.id, fillers: fillersCreate }).exec();

    const result = await promiseResult(runWithId(promise, "save"));
    if (!result.ok) return toast.show({ message: result.error.message, type: "error", timeout: 3000 });
    navigateTo("/lists/contacts");
}

async function onDelete() {
    const result = await promiseResult(runWithId(userService.remove(contact.value.id).exec(), "delete"));
    if (!result.ok) return toast.show({ message: result.error.message, type: "error", timeout: 3000 });
    navigateTo("/lists/contacts");
}

async function fetchEvents() {
    const query: Record<string, any> = {
        sort: { 
            id: -1 
        }, 
        skip: currentPage * limit, 
        limit,
    };

    return await promiseResult(runEventsAsync(userService.get(`${route.params.id as string}/events`, query).exec()));
}

// live: new events of the contact and of its deals appear without reloading the page
useLive(async (changes) => {
    if (!liveTouches(changes, "events") || route.params.id === "new") return;
    const result = await promiseResult(
        userService.get(`${route.params.id as string}/events`, { sort: { id: -1 }, skip: 0, limit }).exec()
    );
    if (result.ok) mergeNewestEvents(events.value.pages, (result.value as any).data, currentUser.value?.id);
});

async function onIntersect() {
    if (eventsEnded.value || eventsLoading.value) return;
    const result = await fetchEvents();
    if (!result.ok) return;
    if (result.value.current_page === result.value.last_page) eventsEnded.value = true;
    currentPage++;
}

async function onEvent(e: Event) {
    const form = (e.target as HTMLFormElement);
    const formData = new FormData(form);
    const type = formData.get("message_type[id]");
    switch (type) {
        case "task": {
            onTask(formData);
        } break;
        case "tg": {
            onTgMessage(formData);
        } break;
        default:
            break;
    }

    if (commentRef.value) {
        content.value = "";
        commentRef.value.el.focus();
        form.reset();
    }

    if (messageType.value.id === "task") {
        messageType.value = messageTypes.value[0];
    }
}

function fileListToDealFiles(list: FormDataEntryValue[], cleanFormData: FormData): DealFile[] {
    const files: DealFile[] = [];
    for (const file of list) {
        if (!(file instanceof File) || file.size === 0 || file.name === "") continue;
        files.push({ path: "", url: URL.createObjectURL(file), uploaded_by: currentUser.value, name: file.name, id: -1 });
        cleanFormData.append("files", file, file.name);
    }
    return files;
}

function TgMessageEvent({user, message, target_user, files, formData}: {user: User, message: string, target_user: User, files: DealFile[], formData?: FormData}): DealEvent {
    const event: DealEvent = {
        type: DealEventType.NewTelegramMessage,
        after_state: {
            files,
            from_user_id: user.id,
            location: null,
            message,
            to_user_id: target_user.id,
            contact: null,
            outgoing: true,
            formData,
        },
        before_state: {
            data: null
        },
        originated_by: user,
        target_group: null,
        target_user: target_user,
        id: --fakeId,
        created_at: new Date().toISOString(),
    }; 

    return event;
}

async function onTgMessage(formData: FormData) {
    const content = formData.get("content");
    if (!content) return;
    const cleanFormData = new FormData();
    cleanFormData.append("message", content);
    const fileList = formData.getAll("files");
    const dealFiles = fileListToDealFiles(fileList, cleanFormData);
    const event = TgMessageEvent({
        user: currentUser.value,
        message: content as string,
        files: dealFiles,
        formData: cleanFormData,
        target_user: contact.value!
    });
    const latest = events.value.pages.length - 1;
    events.value.pages[latest].data.unshift(event);
    cleanFormData.append("to_user", String(contact.value?.id));
    cleanFormData.append("from_user", String(currentUser.value.id));
    const result = await promiseResult(runWithId(telegramService.post("/send-message", cleanFormData).exec(), "sendingMessage"));
    if (!result.ok) {
        toast.show({message: result.error.message, timeout: 3000, type: "error"});
        // remove optimistic event if there is a failure
        events.value.pages[latest].data = events.value.pages[latest].data.filter((item) => item.id !== event.id);
    }
}

async function onTask(formData: FormData) {
    const content = formData.get("content") as string;
    if (!content) return;
    const typeId = formData.get("type[id]");
    const assignTarget = formData.get("assignee[target]") as string;
    const assignId = formData.get("assignee[id]") as string;
    const assignName = formData.get("assignee[name]") as string;
    const assignUsername = formData.get("assignee[username]") as string;
    const startTime = formData.get("start") as string;
    const endTime = formData.get("end") as string;
    const allDay = formData.get("allDay") != null;
    let linkTarget = formData.get("linkable[type]") as string;

    if (linkTarget === "user") linkTarget = "ctr_agent";

    const values: TaskEventProps = {
        label: content,
        type_id: Number(typeId),
        link_to: {
            target: "ctr_agent",
            id: contact.value.id,
        },
        assign_to: {
            target: assignTarget,
            id: Number(assignId),
        },
        start_time: startTime,
        end_time: endTime,
        allDay: allDay,
        type: task.value.type || {name: "", id: -1},
    };

    if (assignTarget === "agent") {
        values.agent = {id: Number(assignId), username: assignUsername} as User;
    }
    if (assignTarget === "group") {
        values.group = {id: Number(assignId), name: assignName} as Group;
    }

    const event = NewTaskEvent(values);
    const latest = events.value.pages.length - 1;
    events.value.pages[latest].data.unshift(event);
    const result = await promiseResult(taskService.create(values).exec());

    if (!result.ok) {
        toast.show({message: result.error.message, timeout: 3000, type: "error"});
        events.value.pages[latest].data = events.value.pages[latest].data.filter((item) => item.id !== event.id);
    } else {
        events.value.pages[latest].data[0] = {...event, after_state: {...event.after_state, data: result.value }};
    }
    task.value = {};
}

function NewTaskEvent(task: TaskEventProps): DealEvent {
    const event: DealEvent = {
        type: DealEventType.NewTask,
        after_state: {
            data: {
                id: --fakeId,
                label: task.label,
                result: null,
                closed_at: "",
                start_time: task.start_time,
                end_time: task.end_time,
                start: task.start_time,
                end: task.end_time,
                created_at: new Date().toISOString(),
                company: null,
                ctr_agent: contact.value,
                agent: task.assign_to.target === "agent" ? task.agent! : null,
                group: task.assign_to.target === "group" ? task.group! : null,
                deal: null,
                allDay: task.allDay,
                created_by: currentUser.value,
                type: task.type,
            }
        },
        before_state: {
            data: null
        },
        originated_by: currentUser.value,
        target_group: null,
        target_user: null,
        id: --fakeId,
        created_at: new Date().toISOString(),
    };

    return event;
}

const messageTypes = computed(() => {
    let out = [taskMessageType];
    if (contact.value?.tg_id) out.push(tgMessageType);
    if (contact.value?.email) out.push(emailMessageType);

    return out;
});

watchEffect(() => {
    if (!messageType.value?.id && messageTypes.value.length) messageType.value = messageTypes.value[0];
});

watchEffect(() => {
    if (!toEmail.value && contact.value.email) toEmail.value = contact.value.email;
});

watch([fillers, contact], () => {
    for (const filler of fillers.value.user || []) {
        if (contact.value.user_fillers?.some((cf) => cf.filler.id === filler.id)) continue;
        if (!contact.value.user_fillers) contact.value.user_fillers = [];
        const fillerValue = {
            id: filler.id,
            value: "",
            filler,
            new: true,
            created_at: new Date().toISOString(),
            tempId: Math.random().toString(32).slice(2)
        };
        contact.value.user_fillers.push(fillerValue);
        if (filler.is_required) schema[fillerValue.tempId] = [required("Обязательное поле")];
    }
});

watch(openFiller, () => {
    nextTick(() => {
        fieldRefs.value[openFiller.value].el?.focus();
    });
});

onMounted(() => {
    if (route.params.id !== "new") runContact(userService.get(route.params.id as string).exec());
    runFillers(fillersService.find({target: "user"}).exec());
    runCompanies(companiesService.find().exec());
});

</script>

<style scoped>

</style>
