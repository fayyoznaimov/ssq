<template>
    <!-- phone: one column — the client, then the conversation (what a manager opens the deal for),
         then the deal's fields; from lg: client + fields on the left (4), the history on the right (8) -->
    <div class="grid grid-cols-12 gap-x-0 gap-y-6 lg:gap-x-8 lg:gap-y-0 lg:grid-rows-[auto_minmax(0,1fr)] lg:h-[calc(100vh-6.4rem)]">
        <section class="order-1 col-span-12 lg:col-span-4 lg:row-start-1 min-w-0">
            <!-- the name is the field «Название сделки» of the form (main-tab.vue); the heading only shows it -->
            <BaseHeading size="lg" as="h1" class="break-words">{{ dealTitle }}</BaseHeading>
            <!-- №, the stage and days in it, the source, «клиент ждёт ответа», the reason of a loss (components/history) -->
            <DealHeader v-if="route.params.id" :summary="summary" class="mt-1" @ask-lost="askLost" />
            <ClientBlock v-if="route.params.id" :deal-id="route.params.id as string" class="mt-3 mb-2" />
        </section>
        <!-- from lg the column scrolls by itself (a visible scrollbar), «Сохранить» stays at its bottom;
             phone: a new deal starts with its fields, a saved one with its conversation -->
        <section
            class="col-span-12 lg:col-span-4 lg:row-start-2 lg:order-2 lg:min-h-0 lg:overflow-y-auto rounded-md min-w-0"
            :class="route.params.id ? 'order-3' : 'order-2'"
        >
            <BaseTabs
                rounded="lg"
                model-value="main"
                :tabs="tabs"
            >
                <template #tab="{ activeValue }">
                    <MainTab 
                        v-if="activeValue === 'main'" :deal="deal" :stages="stages" :stages-loading="stagesLoading" :fillers="fillers" 
                        @created="onDealCreated" 
                        @updated="onDealUpdated"
                        :user="user" 
                        :users="users.data"
                    />
                    <FilesTab v-if="activeValue === 'files'" />
                    <!-- who changed what in this deal and from where (the journal of changes, components/audit) -->
                    <CardHistory v-if="activeValue === 'history' && route.params.id" scope="deal" :id="route.params.id as string" />
                    <!-- «ИИ» (src/ai): summary, questions without an answer, promises, order parameters -->
                    <DealAiPanel v-if="activeValue === 'ai'" :ai="dealAi" :deal="deal" />
                </template>
            </BaseTabs>
        </section>
        <!-- from lg the history takes the height of the screen next to the form and scrolls by itself (it was
             a box of at most 40rem); a phone: full width, the composer under it -->
        <section
            class="lg:order-3 col-span-12 lg:col-span-8 lg:col-start-5 lg:row-start-1 lg:row-span-2 flex flex-col min-w-0 lg:min-h-0"
            :class="route.params.id ? 'order-2' : 'order-3'"
        >
            <EventsList
                v-model:filters="historyFilters"
                v-model:scope="historyScope"
                :events="events"
                :deal="deal"
                :events-loading="eventsLoading"
                :start-observer="!!route.params.id"
                :intersected="onIntersect"
                :tasks="tasks.data"
                :client-deals="summary?.client_deals ?? 0"
                :show-deal="historyScope === 'client'"
                @task-closed="() => {
                    fetchTasks();
                    onFilterApply();
                }"
            />
            <div class="shrink-0 mb-8 mt-3 space-y-2 lg:mb-2">
                <form class="flex flex-wrap lg:flex-nowrap gap-2" id="compose-form" @submit.prevent="onEvent">
                    <BaseListbox
                        v-model="messageType"
                        class="w-48 shrink-0"
                        name="message_type"
                        value="chat"
                        :items="availableMessageTypes"
                        :properties="{ value: 'id', label: 'label', icon: 'icon' }"
                        size="md"
                    />
                    <BaseAutocomplete
                        v-if="messageType.id === 'chat'"
                        class="max-w-xs"
                        name="target"
                        size="md"
                        :items="groupedUsers.grouped"
                        :display-value="displayUserGroup"
                        v-model="messageTarget"
                        :filter-items="nameFilter"
                        :item-disabled="(data: UserGroup) => data.type === 'group' && data.id < 0"
                        :item-classes="{
                            wrapper: (data: UserGroup) => data.type === 'group' ? 'bg-primary-500/20 dark:bg-primary-400 text-white' : '',
                            active: (data: UserGroup) => data.type === 'group' ? 'bg-primary-500/30' : 'bg-muted-100 dark:bg-muted-700'
                        }"
                        :properties="{
                            value: 'temp_id',
                            label: (data: UserGroup) => data.type === 'group' ? data.name : data.username,
                        }"
                        dropdown
                    />
                    <BaseAutocomplete
                        v-if="messageType.id === 'wa'"
                        class="max-w-xs"
                        size="md"
                        :items="waContacts"
                        :display-value="(user: User) => user.username"
                        v-model="messageTarget"
                        :filter-items="nameFilter"
                        :properties="{
                            label: 'username',
                            value: 'id',
                        }"
                        dropdown
                    />
                    <BaseAutocomplete
                        v-if="messageType.id === 'tg'"
                        class="max-w-xs"
                        size="md"
                        :items="tgContacts"
                        :display-value="(user: User) => user.username"
                        v-model="messageTarget"
                        :filter-items="nameFilter"
                        :properties="{
                            label: 'username',
                            value: 'id',
                        }"
                        dropdown
                    />
                    <EventSchedulerSingle v-if="messageType.id === 'task'" :agent="user" v-model="task" size="md" :initial-date="task.start" />
                </form>
                <!-- from which Telegram / WhatsApp it goes and whether it works; «Не клиент» for the chosen contact -->
                <MessengerComposerStatus
                    v-if="messageType.id === 'tg' || messageType.id === 'wa'"
                    :channel="messageType.id"
                    :contact="messageTarget"
                    :deal="deal"
                    @blocked="messengerBlocked = $event"
                />
                <EmailReplyForm 
                    v-if="messageType.id === 'email'" 
                    :reply-options="replyEmails"
                    :to="toEmail"
                    :deal-id="route.params.id ? Number(route.params.id) : undefined"
                />
                <BaseTextarea
                    v-else
                    :rows="3"
                    addon
                    :placeholder="composePlaceholder"
                    resize
                    size="lg"
                    name="content"
                    ref="commentRef"
                    v-model="content"
                    :required="!isClientMessenger"
                    :minlength="isClientMessenger ? undefined : 3"
                    form="compose-form"
                >
                    <template #addon>
                        <BaseButton
                            size="sm"
                            type="submit"
                            :disabled="creatingEvent || (isClientMessenger && messengerBlocked)"
                            form="compose-form"
                        >
                            <div class="flex items-center gap-1">
                                <Icon v-if="isMessenger" name="ph:paper-plane-right" class="size-4" />
                                {{ submitLabel }}
                            </div>
                        </BaseButton>
                        <label class="cursor-pointer">
                            <Icon
                                name="ph:paperclip"
                                size="20"
                            />
                            <input type="file" name="files" class="hidden" multiple form="compose-form">
                        </label>
                    </template>
                </BaseTextarea>
            </div>
        </section>
        <!-- «Почему сделка не реализована?» after the deal is saved in the stage «Закрыто и не реализовано» -->
        <LostReasonModal />
    </div>
</template>

<script lang="ts" setup>
import { useRoute, useRouter } from 'vue-router';

import BaseButton from '~/components/base/BaseButton.vue';
import EventSchedulerSingle from '~/components/common/EventSchedulerSingle.vue';
import { confirmTaskPlan } from '~/components/task/taskPlan';
import EventsList from '~/components/common/EventsList.vue';
import EmailReplyForm from '~/components/mail/EmailReplyForm.vue';
import { type Deal, type DealEvent, DealEventType, type DealFile, type Task,type TaskType } from '~/types/deal';
import type { Filler } from '~/types/filler';
import type { Stage } from '~/types/stage';
import { UserRole, type Company, type Group, type User } from '~/types/user';
import { promiseResult } from '~/utils/result';

import MessengerComposerStatus from '~/components/whatsapp/MessengerComposerStatus.vue';
import ClientBlock from './ClientBlock.vue';
import FilesTab from './files-tab.vue';
import CardHistory from '~/components/audit/CardHistory.vue';
import MainTab from './main-tab.vue';
import DealAiPanel from '~/components/ai/DealAiPanel.vue';
import { useDealAi } from '~/composables/useDealAi';
import DealHeader from '~/components/history/DealHeader.vue';
import LostReasonModal from '~/components/history/LostReasonModal.vue';
import { type DealSummary, type HistoryFilters, emptyHistoryFilters, historyQuery } from '~/components/history/history';
import { askLostReason } from '~/components/history/lostReason';
import type { PaginatedResponse } from '~/types/generics';

type GroupedUser = User & {type: 'user', temp_id: string};
type GroupedGroup = Group & {type: 'group', temp_id: string};
type UserGroup = GroupedUser | GroupedGroup;

let fakeId = -1;
let currentPage = 0;
let limit = 25;

const messageTypes = [
    { id: 'comment', label: 'Примечание', icon: 'ph:note-pencil' },
    { id: 'chat', label: 'Чат', icon: 'ph:chats-circle' },
    { id: 'tg', label: 'Телеграм', icon: 'ph:telegram-logo' },
    { id: 'wa', label: 'WhatsApp', icon: 'ph:whatsapp-logo' },
    { id: 'task', label: 'Задача', icon: 'ph:check-square' },
    { id: 'email', label: 'E-mail', icon: 'ph:envelope-simple' },
]; 

// «E-mail» only with the mail right: without it every request of the form answered 403
const mailAbility = useAppAbility();
const availableMessageTypes = computed(() => messageTypes.filter((type) => type.id !== 'email' || mailAbility.can('read', 'Mail')));

const router = useRouter();
const dealService = useService('deals', { auth: true });
const stageService  = useService('stages', { auth: true });
const fillerService = useService('fillers', { auth: true });
const userService = useService('users', { auth: true });
const taskService = useService('tasks', { auth: true });
const telegramService = useService('telegram', { auth: true });
const whatsappService = useService('whatsapp', { auth: true });
const messageTarget = ref<UserGroup>();
const content = ref();
const eventsEnded = ref(false);
// the history: «Всё / Переписка / Звонки / Задачи / Изменения», the search, this deal or the whole client
const historyFilters = ref<HistoryFilters>(emptyHistoryFilters());
const historyScope = ref<'deal' | 'client'>('deal');
// the deal header (GET /deals/:id/summary): №, days in the stage, the source, «клиент ждёт ответа»
const summary = ref<DealSummary | null>(null);

const end = new Date();
const start = new Date().toISOString();
end.setMinutes(end.getMinutes() + 30);
const endStr = end.toISOString();
const task = ref<Partial<Task>>({
    id: -1,
    label:  '',
    result: null,
    closed_at: '',
    start_time: start,
    start: start,
    end: endStr,
    end_time: endStr,
    created_at: new Date().toISOString(),
    allDay: false
});

const tabs = computed(() => {
    let tabs = [{label: 'Основные', value: 'main'}];
    if (route.params.id) tabs.push({ label: 'Файлы', value: 'files'});
    if (route.params.id) tabs.push({ label: 'История', value: 'history'});
    // «ИИ» only while the AI of the CRM is on (AI_FEATURES); its label counts what waits for the manager
    if (route.params.id && dealAi.enabled.value) tabs.push({ label: dealAi.tabLabel.value, value: 'ai' });
    return tabs;
});

const toast = useToast('GlobalToast');
const commentRef = ref();
const messageType = ref(messageTypes[0]);
const commentScrollRef = ref();
const toEmail = ref('');

const user = useState<User>('user');

const { run: runUsers, data: users } = useAsync<{data: User[], count: number}>({ data: [], count: 0 });
const { run: runDeal, data: deal } = useAsync<Deal>({ 
    label: '', 
    deal_fillers: [], 
    ctr_agents: [], 
    company: {} as Company, 
    // a new deal: the one who creates it is responsible (an admin too; he can pick another)
    agent: Object.assign(user.value, {user_fillers: []}),
    deal_products: [],
});

// «Новая сделка» until it is saved; a deal without a name shows its number
const dealTitle = computed(() => {
    const label = String(deal.value.label ?? '').trim();
    if (label) return label;
    if (!deal.value.id) return 'Новая сделка';
    return `Сделка №${deal.value.display_id ?? deal.value.id}`;
});

const { run: runStages, isLoading: stagesLoading, data: stages } = useAsync<Stage[]>([]);
const { run: runFillers, data: fillers } = useAsync<{
    company: Filler[], 
    user: Filler[], 
    deal: Filler[],
    product: Filler[],
}>({ company: [], user: [], deal: [], product: [] });

const { runAsync: runEventAsync, isLoading: creatingEvent } = useAsync();

const { data: events, runAsync: runEventsAsync, isLoading: eventsLoading, reset: resetEvents } = useInfiniteQuery<
    {data: DealEvent[]; count: number; page_size: number; current_page: number; last_page: number;}
>({data: [], count: 0, page_size: 0, current_page: 0, last_page: 0});

const { data: tasks, isLoading: tasksLoading, run: runTasks } = useAsync<PaginatedResponse<Task>>({
    data: []
});

const route = useRoute();
// the AI of the deal (tab «ИИ», components/ai/DealAiPanel.vue)
const dealAi = useDealAi(() => route.params.id as string | undefined);

function userGroup(user: User): Group {
    let name = '';
    let id = -1;
    if (user.role === UserRole.Admin) name = 'Администраторы';
    if (user.role === UserRole.CtrAgent) name = 'Контакты', id = -2;
    if (user.role === UserRole.Agent) name = 'Агенты', id = -3;
    if (user.role === UserRole.Manager) name = 'Менеджеры', id = -4;

    return {
        id,
        name,
        created_at: ''
    }
}

const groupedUsers = computed(() => {
    const grouped: UserGroup[] = [];
    const groupIndex: Record<number, number> = {};
    const tgUsers: User[] = [];
    for (const user of users.value.data) {
        if (user.tg_id && user.role === UserRole.CtrAgent) {
            tgUsers.push(user);
            continue;
        }
        // if (!user.group) user.group = userGroup(user);
        if (!user.group) continue;
        let index = groupIndex[user.group.id];
        if (index == null) index = groupIndex[user.group.id] = grouped.length;
        if (!grouped[index]) grouped[index] = {...user.group, temp_id: `group-${user.group.id}`, type: 'group'};
        grouped.splice(index + 1, 0, {...user, temp_id: `user-${user.id}`, type: 'user'});
    }

    return {grouped, tgUsers};
});

// this deal's history, or the whole client's (every deal of its company and contacts the user may see, DEAL-7)
function eventsPath(id: string = route.params.id as string) {
    return historyScope.value === 'client' ? `${id}/client-events` : `${id}/events`;
}

async function fetchEvents() {
    return await promiseResult(runEventsAsync(dealService.get(eventsPath(), eventsQuery(currentPage * limit)).exec()));
}

// the history query: newest first, the filter and the search chosen above the feed
function eventsQuery(skip: number) {
    return {
        sort: {
            id: -1
        },
        skip,
        limit,
        ...historyQuery(historyFilters.value),
    };
}

// Live: new history events, tasks and a stage changed elsewhere (another
// manager, a trigger, Telegram) appear without reloading the page.
let serverStageId: number | undefined;
useLive(async (changes) => {
    const id = route.params.id as string;
    if (!id) return;
    if (liveTouches(changes, 'events', id) || (historyScope.value === 'client' && liveTouches(changes, 'events'))) {
        const result = await promiseResult(dealService.get(eventsPath(id), eventsQuery(0)).exec());
        if (result.ok) mergeNewestEvents(events.value.pages, (result.value as any).data, user.value?.id);
    }
    if (liveTouches(changes, 'tasks', id)) fetchTasks();
    if (liveTouches(changes, 'deals', id)) {
        const result = await promiseResult(dealService.get(id).exec());
        if (!result.ok) return;
        const fresh = result.value as Deal;
        // the stage follows the server unless the user has picked another one in the form
        if (fresh.stage?.id !== serverStageId && deal.value.stage?.id === serverStageId) deal.value.stage = fresh.stage;
        serverStageId = fresh.stage?.id;
    }
    // the header: a new message of the client («ждёт ответа»), an answer, a stage moved elsewhere
    if (liveTouches(changes, 'events', id) || liveTouches(changes, 'deals', id)) loadSummary();
});

async function onIntersect() {
    if (eventsEnded.value || eventsLoading.value) return;
    const result = await fetchEvents();
    if (!result.ok) return;
    // the last page (an empty filter result answers current_page 1 of last_page 0: the end too)
    if (result.value.current_page >= result.value.last_page || !result.value.data?.length) eventsEnded.value = true;
    currentPage++;
}

// the history again from its newest page (a filter, the search or «Весь клиент» changed, a task closed)
let reloadPending = false;
function onFilterApply() {
    if (!route.params.id) return;
    if (eventsLoading.value) {
        reloadPending = true;
        return;
    }
    reloadPending = false;
    currentPage = 0;
    eventsEnded.value = false;
    resetEvents();
    onIntersect();
}
watch(eventsLoading, (loading) => {
    if (!loading && reloadPending) onFilterApply();
});
watch(historyFilters, onFilterApply, { deep: true });
watch(historyScope, onFilterApply);

function loadSummary() {
    const id = route.params.id as string;
    if (!id) return Promise.resolve();
    return promiseResult(dealService.get<DealSummary>(`${id}/summary`).exec()).then((result) => {
        if (!result.ok) return;
        const first = !summary.value;
        summary.value = result.value as DealSummary;
        // a repeat client: the deal opens with the history of the whole client (DEAL-7)
        if (first && summary.value.repeat_of && summary.value.client_deals > 0) historyScope.value = 'client';
    });
}

/** «Почему сделка не реализована?»: saved by the modal itself (PATCH /deals/:id/lost). */
async function askLost() {
    if (!deal.value.id) return;
    const answer = await askLostReason({
        deal: { id: deal.value.id, display_id: deal.value.display_id, label: deal.value.label },
        reasons: summary.value?.lost_reasons,
        reason: summary.value?.lost_reason,
        comment: summary.value?.lost_comment,
    });
    if (answer) loadSummary();
}

function displayUserGroup(u: UserGroup) {
    if (u.type === 'group') return u.name;
    if (u.type === 'user') return u.username;
}

function nameFilter(query?: string, items?: UserGroup[]) {
    if (!query) return items;
    const lowercased = query.toLowerCase();
    const filtered: UserGroup[] = [];
    for (let item of items || []) {
        let shouldAdd;
        if (item.type === 'group') shouldAdd = item.name.toLowerCase().includes(lowercased);
        else shouldAdd = item.username.toLowerCase().includes(lowercased);
        if (shouldAdd) filtered.push(item);
    }

    return filtered;
}

async function onDealCreated(deal: Deal) {
    const promises = events.value.pages[events.value.pages.length - 1].data.map((event) => {
        if (event.type === DealEventType.NewComment) {
            return dealService.post(`/${deal.id}/comments`, event.after_state.data.formData).exec();
        }

        if (event.type === DealEventType.NewChatMessage) {
            return dealService.post(`/${deal.id}/message`, event.after_state.data.formData).exec();
        }

        if (event.type === DealEventType.NewTask) {
            const data = event.after_state.data;
            return taskService.create({
                label: data.label,
                type_id: data.type?.id,
                assign_to: {
                    target: data.agent ? 'agent' : 'group',
                    id: data.agent?.id || data.group?.id,
                },
                link_to: {
                    target: 'deal',
                    id: deal.id,
                },
                start_time: data.start_time,
                end_time: data.end_time,
                allDay: data.allDay
            });
        }
    });

    const result = await promiseResult(runEventAsync(Promise.all(promises)));
    if (!result.ok) return toast.show({message: result.error.message, timeout: 3000, type: 'error'});
    router.push(`/deals/${deal.id}`);
}

function CommentEvent({user, comment, files, formData}: {user: User, comment: string, files: DealFile[], formData?: FormData}) {
    const event: DealEvent = {
        type: DealEventType.NewComment,
        after_state: {
            data: {
                comment,
                files,
                formData
            }
        },
        before_state: {
            data: null,
        },
        originated_by: user,
        target_group: null,
        target_user: null,
        id: --fakeId,
        created_at: new Date().toISOString(),
    };

    return event;
}

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

function NewTaskEvent(task: TaskEventProps): DealEvent {
    const event: DealEvent = {
        type: DealEventType.NewTask,
        after_state: {
            data: {
                id: --fakeId,
                label: task.label,
                result: null,
                closed_at: '',
                start_time: task.start_time,
                end_time: task.end_time,
                start: task.start_time,
                end: task.end_time,
                created_at: new Date().toISOString(),
                company: null,
                ctr_agent: null,
                agent: task.assign_to.target === 'agent' ? task.agent! : null,
                group: task.assign_to.target === 'group' ? task.group! : null,
                deal: deal.value,
                allDay: task.allDay,
                created_by: user.value,
                type: task.type,
            }
        },
        before_state: {
            data: null
        },
        originated_by: user.value,
        target_group: null,
        target_user: null,
        id: --fakeId,
        created_at: new Date().toISOString(),
    };

    return event;
}

function MessageEvent({user, message, target_group, target_user, files, formData}: {user: User, message: string, target_group: Group | null, target_user: User | null, files: DealFile[], formData?: FormData}): DealEvent {
    const event: DealEvent = {
        type: DealEventType.NewChatMessage,
        after_state: {
            data: {
                message,
                files,
                formData
            }
        },
        before_state: {
            data: null
        },
        originated_by: user,
        target_group,
        target_user,
        id: --fakeId,
        created_at: new Date().toISOString(),
    };

    return event;
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
    } 

    return event;
}

async function onEvent(e: Event) {
    const form = (e.target as HTMLFormElement);
    const formData = new FormData(form);
    const type = formData.get('message_type[id]');
    switch (type) {
        case 'comment': {
            onComment(formData);
        } break;
        case 'chat': {
            onMessage(formData);
        } break;
        case 'task': {
            onTask(formData);
        } break;
        case 'tg':
        case 'wa': {
            // the form is cleared only when the messenger took the message: on a failure the text and
            // the files stay for another try (the same request_id: never sent twice)
            const sent = await (type === 'tg' ? onTgMessage(formData) : onWaMessage(formData));
            if (!sent) return;
            messengerRequestId = '';
        } break;
        default:
            break;
    }

    if (commentRef.value) {
        content.value = '';
        commentRef.value.el.focus();
        form.reset();
    }

    if (messageType.value.id === 'task') {
        messageType.value = messageTypes[0];
    }

    if (type === 'comment' || type === 'chat') {
        setTimeout(() => {
            commentScrollRef.value.scrollIntoView({ behavior: 'smooth' });
        }, 0);
    }
}

// one id per typed message (kept until it is sent): a repeated click or a retry is not sent twice
let messengerRequestId = '';
const isClientMessenger = computed(() => messageType.value?.id === 'tg' || messageType.value?.id === 'wa');
// the manager's own Telegram / WhatsApp is not connected (MessengerComposerStatus): «Отправить» waits, the text stays
const messengerBlocked = ref(false);

function messengerRequest(cleanFormData: FormData) {
    if (!messengerRequestId) messengerRequestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    cleanFormData.append('request_id', messengerRequestId);
    // recorded in this deal (not in another open deal of the client)
    const dealId = deal.value?.id ?? route.params.id;
    if (dealId) cleanFormData.append('deal_id', String(dealId));
}

/** The answer of /telegram|whatsapp/send-message: true = done (sent, or still being sent and recorded later). */
function messengerAnswer(result: { ok: boolean; value?: any; error?: any }, removeOptimistic: () => void): boolean {
    if (result.ok) {
        if (result.value?.pending) toast.show({message: result.value.message, timeout: 8000, type: 'success'});
        return true;
    }
    const data = result.error?.data ?? {};
    const partly = Number(data.sent) > 0 || (Array.isArray(data.message_ids) && data.message_ids.length > 0);
    toast.show({message: data.message || result.error?.message || 'Сообщение не отправлено', timeout: 8000, type: 'error'});
    removeOptimistic();
    // a part went out and is in the history: the form is cleared so that it is not sent twice
    if (partly) {
        fetchEvents();
        return true;
    }
    return false;
}

async function onTgMessage(formData: FormData): Promise<boolean> {
    const content = formData.get('content') as string | null;
    const fileList = formData.getAll('files').filter((f) => f instanceof File && f.size > 0);
    if (!content?.trim() && !fileList.length) return false;
    if (!messageTarget.value?.id) {
        toast.show({message: 'Выберите контакт клиента', timeout: 4000, type: 'error'});
        return false;
    }
    const cleanFormData = new FormData();
    cleanFormData.append('message', content || '');
    const dealFiles = fileListToDealFiles(fileList, cleanFormData);
    const event = TgMessageEvent({
        user: user.value,
        message: content || '',
        files: dealFiles,
        formData: cleanFormData,
        target_user: messageTarget.value as User
    });
    const latest = events.value.pages.length - 1;
    events.value.pages[latest].data.unshift(event);
    cleanFormData.append('to_user', String(messageTarget.value.id));
    cleanFormData.append('from_user', String(user.value.id));
    messengerRequest(cleanFormData);
    const result = await promiseResult(runEventAsync(telegramService.post('/send-message', cleanFormData).exec()));
    // remove the optimistic event if there is a failure
    return messengerAnswer(result, () => {
        events.value.pages[latest].data = events.value.pages[latest].data.filter((item) => item.id !== event.id);
    });
}

// Telegram / WhatsApp from a deal: only to this deal's contacts, the first one chosen by itself
const tgContacts = computed(() => (deal.value.ctr_agents ?? []).filter((c: any) => c.tg_id));
const waContacts = computed(() => (deal.value.ctr_agents ?? []).filter((c: any) => c.phone || c.wa_id));
const isMessenger = computed(() => ['tg', 'wa', 'chat'].includes(messageType.value?.id));
const submitLabel = computed(() => (isMessenger.value ? 'Отправить' : messageType.value?.id === 'task' ? 'Создать' : 'Добавить'));
const composePlaceholder = computed(() => ({
    tg: tgContacts.value.length ? 'Сообщение в Telegram' : 'У контактов сделки нет Telegram',
    wa: waContacts.value.length ? 'Сообщение в WhatsApp' : 'У контактов сделки нет номера для WhatsApp',
    chat: 'Сообщение сотрудникам',
    task: 'Задача',
} as Record<string, string>)[messageType.value?.id] ?? 'Примечание');
watch([messageType, tgContacts, waContacts], () => {
    const id = messageType.value?.id;
    if (id !== 'tg' && id !== 'wa') return;
    const list = (id === 'tg' ? tgContacts.value : waContacts.value) as any[];
    if (!list.some((c) => c.id === (messageTarget.value as any)?.id)) messageTarget.value = list[0];
});

async function onWaMessage(formData: FormData): Promise<boolean> {
    const content = formData.get('content') as string | null;
    const fileList = formData.getAll('files').filter((f) => f instanceof File && f.size > 0);
    if (!content?.trim() && !fileList.length) return false;
    if (!messageTarget.value?.id) {
        toast.show({message: 'Выберите контакт клиента', timeout: 4000, type: 'error'});
        return false;
    }
    const cleanFormData = new FormData();
    cleanFormData.append('message', (content as string) || '');
    const dealFiles = fileListToDealFiles(fileList, cleanFormData);
    const event = { ...TgMessageEvent({
        user: user.value,
        message: (content as string) || '',
        files: dealFiles,
        formData: cleanFormData,
        target_user: messageTarget.value as User
    }), type: DealEventType.NewWhatsAppMessage } as DealEvent;
    const latest = events.value.pages.length - 1;
    events.value.pages[latest].data.unshift(event);
    cleanFormData.append('to_user', String(messageTarget.value.id));
    messengerRequest(cleanFormData);
    const result = await promiseResult(runEventAsync(whatsappService.post('/send-message', cleanFormData).exec()));
    return messengerAnswer(result, () => {
        events.value.pages[latest].data = events.value.pages[latest].data.filter((item) => item.id !== event.id);
    });
}

async function onTask(formData: FormData) {
    const content = formData.get('content') as string;
    if (!content) return;
    const typeId = formData.get('type[id]');
    const assignTarget = formData.get('assignee[target]') as string;
    const assignId = formData.get('assignee[id]') as string;
    const assignName = formData.get('assignee[name]') as string;
    const assignUsername = formData.get('assignee[username]') as string;
    const startTime = formData.get('start') as string;
    const endTime = formData.get('end') as string;
    const allDay = formData.get('allDay') != null;
    let linkTarget = formData.get('linkable[type]') as string;

    if (linkTarget === 'user') linkTarget = 'ctr_agent';

    const values: TaskEventProps = {
        label: content,
        type_id: Number(typeId),
        link_to: {
            target: 'deal',
            id: deal.value.id,
        },
        assign_to: {
            target: assignTarget,
            id: Number(assignId),
        },
        start_time: startTime,
        end_time: endTime,
        allDay: allDay,
        type: task.value.type || {name: '', id: -1},
    };

    if (assignTarget === 'agent') {
        values.agent = {id: Number(assignId), username: assignUsername} as User;
    }
    if (assignTarget === 'group') {
        values.group = {id: Number(assignId), name: assignName} as Group;
    }

    const event = NewTaskEvent(values);
    const latest = events.value.pages.length - 1;
    events.value.pages[latest].data.unshift(event);
    if (!deal.value.id) return;
    const result = await promiseResult(confirmTaskPlan((flags) => taskService.create({...values, ...flags}).exec()));

    if (!result.ok) {
        toast.show({message: result.error.message, timeout: 3000, type: 'error'});
        events.value.pages[latest].data = events.value.pages[latest].data.filter((item) => item.id !== event.id);
    } else {
        events.value.pages[latest].data[0] = {...event, after_state: {...event.after_state, data: result.value }};
    }
    fetchTasks();
    task.value = {};
}

function fileListToDealFiles(list: FormDataEntryValue[], cleanFormData: FormData): DealFile[] {
    const files: DealFile[] = [];
    for (const file of list) {
        if (!(file instanceof File) || file.size === 0 || file.name === '') continue;
        files.push({ path: '', url: URL.createObjectURL(file), uploaded_by: user.value, deal: deal.value, name: file.name, id: -1 });
        cleanFormData.append('files', file, file.name);
    }
    return files;
}

async function onComment(formData: FormData) {
    const content = formData.get('content');
    if (!content) return;
    const cleanFormData = new FormData();
    cleanFormData.append('comment', content);
    const fileList = formData.getAll('files');
    const dealFiles = fileListToDealFiles(fileList, cleanFormData);
    const event = CommentEvent({
        user: user.value,
        comment: content as string,
        files: dealFiles,
        formData: cleanFormData,
    });
    const latest = events.value.pages.length - 1;
    events.value.pages[latest].data.unshift(event);
    if (!deal.value.id) return;
    const result = await promiseResult(runEventAsync(dealService.post(`/${deal.value.id}/comments`, cleanFormData).exec()));
    if (!result.ok) {
        toast.show({message: result.error.message, timeout: 3000, type: 'error'});
        // remove optimistic event if there is a failure
        events.value.pages[latest].data = events.value.pages[latest].data.filter((item) => item.id !== event.id);
    } else {
        events.value.pages[latest].data[0] = result.value as DealEvent;
    }
}

async function onMessage(formData: FormData) {
    const content = formData.get('content');
    if (!content) return;
    const cleanFormData = new FormData();
    cleanFormData.append('message', content);
    if (messageTarget.value?.type) { 
        cleanFormData.append('target', messageTarget.value.type);
    } else {
        cleanFormData.append('target', 'all');
    }

    if (messageTarget.value?.id) cleanFormData.append('target_id', String(messageTarget.value?.id));
    const fileList = formData.getAll('files');
    const dealFiles = fileListToDealFiles(fileList, cleanFormData);
    const event = MessageEvent({
        user: user.value,
        message: content as string,
        target_group: messageTarget.value?.type === 'group' ? messageTarget.value : null,
        target_user: messageTarget.value?.type === 'user' ? messageTarget.value : null,
        files: dealFiles,
        formData: cleanFormData
    });
    const latest = events.value.pages.length - 1;
    events.value.pages[latest].data.unshift(event);
    if (!deal.value.id) return;
    const result = await promiseResult(runEventAsync(dealService.post(`/${deal.value.id}/message`, cleanFormData).exec()));
    if (!result.ok) {
        toast.show({message: result.error.message, timeout: 3000, type: 'error'});
        // remove optimistic event if there is a failure
        events.value.pages[latest].data = events.value.pages[latest].data.filter((item) => item.id !== event.id);
    }
}

function fetchTasks() {
    runTasks(taskService.find({deal_id: route.params.id}).exec());
}

const replyEmails = computed(() => {
    if (!deal.value.id) return [];
    const out: string[] = [];
    if (deal.value.company?.email) out.push(deal.value.company.email);
    for (const contact of deal.value.ctr_agents) {
        if (contact.email) out.push(contact.email);
    }

    return out;
});

watchEffect(() => {
    if (!toEmail.value && replyEmails.value.length) toEmail.value = replyEmails.value[0];
});

provide('commentScrollRef', commentScrollRef);

function loadDeal() {
    return runDeal(dealService.get(route.params.id as string).exec(), (deal) => {
        if (!deal.company) deal.company = {} as Company;
        serverStageId = deal.stage?.id;
        if (!deal.agent && user.value.role !== 'admin') deal.agent = Object.assign(user.value, {user_fillers: []})
        return deal;
    });
}

// Saved: the card stays open (it used to throw the manager out to the list) and shows the deal
// as the server has it now (the new values of the fields got their ids)
async function onDealUpdated() {
    toast.show({message: 'Сделка сохранена', timeout: 2500, type: 'success'});
    const before = summary.value?.stage?.kind ?? null;
    await loadDeal();
    await loadSummary();
    // saved into «Закрыто и не реализовано»: why (DEAL-11); «Не указывать» leaves it for later (the header offers it)
    if (summary.value?.stage?.kind === 'lost' && before !== 'lost' && !summary.value.lost_reason) askLost();
}

onMounted(() => {
    if (route.params.id) {
        loadDeal();
        fetchTasks();
        loadSummary();
    }
    runStages(stageService.find().exec());
    runFillers(fillerService.find().exec());
    runUsers(userService.find().exec());
});

</script>