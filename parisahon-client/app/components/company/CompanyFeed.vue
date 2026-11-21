<template>
    <section class="col-span-12 lg:col-span-8 flex flex-col relative min-h-[60vh]">
        <EventsList
            :events="events"
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
                <BaseAutocomplete
                    v-if="messageType.id === 'tg'"
                    v-model="toUser"
                    class="max-w-xs"
                    size="md"
                    :items="reply?.users"
                    :display-value="(user: User) => user.username"
                    :filter-items="nameFilter"
                    :properties="{
                        label: 'username',
                        value: 'id',
                    }"
                    dropdown
                />
            </form>
            <EmailReplyForm
                v-if="messageType.id === 'email'"
                :reply-options="reply?.emails"
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
                        <div>Отправить</div>
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
</template>

<script lang="ts" setup>
import EventSchedulerSingle from "~/components/common/EventSchedulerSingle.vue";
import EventsList from "~/components/common/EventsList.vue";
import EmailReplyForm from "~/components/mail/EmailReplyForm.vue";
import { useAsync } from "~/composables/useAsync";
import {
    type DealEvent,
    DealEventType,
    type DealFile,
    type Task,
    type TaskType,
} from "~/types/deal";
import type { Company, Group, User } from "~/types/user";

// The right column of the company card: the events feed and the message composer
// (a task, a Telegram message to a contact or an e-mail).
const props = defineProps<{
    company: Company;
}>();
const { company } = toRefs(props);

const route = useRoute();

type TaskEventProps = {
    label: string;
    type_id: number;
    assign_to: {
        target: string;
        id: number;
    };
    link_to: {
        target: string;
        id: number;
    };
    start_time: string;
    end_time: string;
    allDay: boolean;
    group?: Group;
    agent?: User;
    type: TaskType;
};

let fakeId = -1;
let currentPage = 0;
const emailMessageType = {
    id: "email",
    label: "E-mail",
};

const tgMessageType = {
    id: "tg",
    label: "Телеграм",
};

const taskMessageType = {
    id: "task",
    label: "Задача",
};

const limit = 25;
const toast = useToast("GlobalToast");
const companiesService = useService("companies", { auth: true });
const telegramService = useService("telegram", { auth: true });
const taskService = useService("tasks", { auth: true });

const eventsEnded = ref(false);
const messageType = ref<typeof emailMessageType>(taskMessageType);
const toEmail = ref("");
const content = ref("");
const commentRef = ref();
const toUser = ref<User>();
const currentUser = useState<User>("user");

const {
    data: events,
    runAsync: runEventsAsync,
    isLoading: eventsLoading,
} = useInfiniteQuery<{
    data: DealEvent[];
    count: number;
    page_size: number;
    current_page: number;
    last_page: number;
}>({ data: [], count: 0, page_size: 0, current_page: 0, last_page: 0 });
const { runWithId } = useAsync();

const end = new Date();
const start = new Date().toISOString();
end.setMinutes(end.getMinutes() + 30);
const endStr = end.toISOString();
const task = ref<Partial<Task>>({
    id: -1,
    label: "",
    result: null,
    closed_at: "",
    start_time: start,
    start: start,
    end: endStr,
    end_time: endStr,
    created_at: new Date().toISOString(),
    allDay: false,
});

async function fetchEvents() {
    const query = {
        sort: {
            id: -1,
        },
        skip: currentPage * limit,
        limit,
    };

    return await promiseResult(
        runEventsAsync(
            companiesService
                .get(`${route.params.id as string}/events`, query)
                .exec()
        )
    );
}

// Live: new events of the company's deals appear without reloading the page
useLive(async (changes) => {
    if (!liveTouches(changes, "events")) return;
    const result = await promiseResult(
        companiesService
            .get(`${route.params.id as string}/events`, { sort: { id: -1 }, skip: 0, limit })
            .exec()
    );
    if (result.ok) mergeNewestEvents(events.value.pages, result.value.data, currentUser.value?.id);
});

// The feed of the company: events of all its deals, loaded page by page
// while scrolling (GET /companies/:id/events). Was switched off.
async function onIntersect() {
    if (eventsEnded.value || eventsLoading.value) return;
    const result = await fetchEvents();
    if (!result.ok) return;
    if (result.value.current_page >= result.value.last_page)
        eventsEnded.value = true;
    currentPage++;
}

async function onEvent(e: Event) {
    const form = e.target as HTMLFormElement;
    const formData = new FormData(form);
    const type = formData.get("message_type[id]");
    switch (type) {
        case "task":
            await onTask(formData);
            break;
        case "tg":
            await onTgMessage(formData);
            break;
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

function fileListToDealFiles(
    list: FormDataEntryValue[],
    cleanFormData: FormData
): DealFile[] {
    const files: DealFile[] = [];
    for (const file of list) {
        if (!(file instanceof File) || file.size === 0 || file.name === "")
            continue;
        files.push({
            path: "",
            url: URL.createObjectURL(file),
            uploaded_by: currentUser.value,
            name: file.name,
            id: -1,
        });
        cleanFormData.append("files", file, file.name);
    }
    return files;
}

function TgMessageEvent({
    user,
    message,
    target_user,
    files,
    formData,
}: {
    user: User;
    message: string;
    target_user: User;
    files: DealFile[];
    formData?: FormData;
}): DealEvent {
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
            data: null,
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
        target_user: toUser.value!,
    });
    const latest = events.value.pages.length - 1;
    events.value.pages[latest].data.unshift(event);
    cleanFormData.append("to_user", String(toUser.value?.id));
    cleanFormData.append("from_user", String(currentUser.value.id));
    const result = await promiseResult(
        runWithId(
            telegramService.post("/send-message", cleanFormData).exec(),
            "sendingMessage"
        )
    );
    if (!result.ok) {
        toast.show({
            message: result.error.message,
            timeout: 3000,
            type: "error",
        });
        // remove optimistic event if there is a failure
        events.value.pages[latest].data = events.value.pages[
            latest
        ].data.filter((item) => item.id !== event.id);
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

    const values: TaskEventProps = {
        label: content,
        type_id: Number(typeId),
        link_to: {
            target: "company",
            id: company.value.id,
        },
        assign_to: {
            target: assignTarget,
            id: Number(assignId),
        },
        start_time: startTime,
        end_time: endTime,
        allDay: allDay,
        type: task.value.type || { name: "", id: -1 },
    };

    if (assignTarget === "agent") {
        values.agent = {
            id: Number(assignId),
            username: assignUsername,
        } as User;
    }
    if (assignTarget === "group") {
        values.group = { id: Number(assignId), name: assignName } as Group;
    }

    const event = NewTaskEvent(values);
    const latest = events.value.pages.length - 1;
    events.value.pages[latest].data.unshift(event);
    const result = await promiseResult(taskService.create(values).exec());

    if (!result.ok) {
        toast.show({
            message: result.error.message,
            timeout: 3000,
            type: "error",
        });
        events.value.pages[latest].data = events.value.pages[
            latest
        ].data.filter((item) => item.id !== event.id);
    } else {
        events.value.pages[latest].data[0] = {
            ...event,
            after_state: { ...event.after_state, data: result.value },
        };
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
                company: company.value,
                ctr_agent: null,
                agent: task.assign_to.target === "agent" ? task.agent! : null,
                group: task.assign_to.target === "group" ? task.group! : null,
                deal: null,
                allDay: task.allDay,
                created_by: currentUser.value,
                type: task.type,
            },
        },
        before_state: {
            data: null,
        },
        originated_by: currentUser.value,
        target_group: null,
        target_user: null,
        id: --fakeId,
        created_at: new Date().toISOString(),
    };

    return event;
}

const reply = computed(() => {
    const out: { emails: string[]; users: User[] } = { emails: [], users: [] };
    if (!company.value.id) return;
    if (company.value.email) out.emails.push(company.value.email);
    for (const user of company.value.users || []) {
        if (user.email) out.emails.push(user.email);
        if (user.tg_id) out.users.push(user);
    }

    out.emails = [...new Set(out.emails)];
    return out;
});

const messageTypes = computed(() => {
    let out = [taskMessageType];
    if (reply.value?.users.length) out.push(tgMessageType);
    if (reply.value?.emails.length) out.push(emailMessageType);

    return out;
});

function nameFilter(query?: string, items?: User[]) {
    if (!query) return items;
    const lowercased = query.toLowerCase();
    const filtered: User[] = [];
    for (let item of items || []) {
        let shouldAdd = item.username.toLowerCase().includes(lowercased);
        if (shouldAdd) filtered.push(item);
    }

    return filtered;
}

watchEffect(() => {
    if (!messageType.value?.id && messageTypes.value.length)
        messageType.value = messageTypes.value[0];
});

watchEffect(() => {
    if (!toEmail.value && reply.value?.emails.length)
        toEmail.value = reply.value.emails[0];
});
</script>
