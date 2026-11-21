<template>
    <BaseCard :class="['flex-1 relative max-h-[40rem] overflow-y-auto', classes?.wrapper]" rounded="md" ref="chatAreaRef">
        <slot name="header" />
        <div class="flex flex-col p-4 no-scrollbar mb-52 h-full">
            <div v-if="eventsLoading" class="text-center w-full text-xs text-muted-600 dark:text-muted-200">Загрузка...</div>
            <p v-else-if="events.pages?.[0].count === 0" class="text-center w-full text-xs text-muted-600 dark:text-muted-200">Нету событий...</p>
            <div ref="infiniteTarget"></div>
            <ul v-for="(page, i) in groupedEvents.pages" :key="i" class="flex flex-col-reverse break-words">
                <li v-for="(event, eidx) in page.data" :key="event.id"
                    class="text-muted-600 text-sm dark:text-muted-400" 
                    tabindex="0" 
                >
                    <p class="space-x-2 mb-4" v-if="event.type === DealEventType.NewDeal">
                        <EventDate :event="event" />
                        <span>Сделка создана:</span> <NuxtLink class="underline" :to="'/deals/' + event.after_state.data.id">{{ event.after_state.data.label }}</NuxtLink>
                    </p>
                    <p class="space-x-2 mb-4" v-else-if="event.type === DealEventType.NewCtrAgent">
                        <EventDate :event="event" />
                        <span>Контакт создан:</span> <NuxtLink class="underline" :to="'/lists/contacts/' + event.after_state.data.id">{{ event.after_state.data.username }}</NuxtLink>
                    </p>
                    <p class="space-x-2 mb-4" v-else-if="event.type === DealEventType.NewCompany">
                        <EventDate :event="event" />
                        <span>Компания создана:</span> <NuxtLink class="underline" :to="'/lists/companies/' + event.after_state.data.id">{{ event.after_state.data.name }}</NuxtLink>
                    </p>
                    <p class="space-x-2 mb-4" v-else-if="event.type === DealEventType.NewFieldValue">
                        <EventDate :event="event" />
                        <span>Для поля </span> &laquo;{{ event.after_state.data.field }}&raquo; установлено значение &laquo;{{ event.after_state.data.new_value }}&raquo;
                    </p>
                    <p class="space-x-2 mb-4" v-else-if="event.type === DealEventType.NewUpdatedFieldValue">
                        <EventDate :event="event" />
                        <span>Изменено поле </span> &laquo;{{ event.after_state.data.field }}&raquo;. Предыдущее значение &laquo;{{ event.after_state.data.old_value }}&raquo;, новое значение &laquo;{{ event.after_state.data.new_value }}&raquo;
                    </p>
                    <div class="mb-4" v-else-if="event.type === DealEventType.NewStage">
                        <EventDate :event="event" />
                        <span class="ml-2">Новый этап: </span> 
                        <div class="inline px-1 py-0.5 rounded-sm" :style="{'background-color': event.after_state.data.stage.color}">{{ event.after_state.data.stage.name }}</div> 
                        из {{ event.before_state.data.stage.name }}
                    </div>
                    <BaseCard class="p-2 mb-4" rounded="sm" v-else-if="event.type === DealEventType.NewComment">
                        <div class="flex items-start space-x-4">
                            <Icon name="ph:article" size="32" class="shrink-0" />
                            <div class="flex flex-col w-full">
                                <p>
                                    <EventDate :event="event" />
                                </p>
                                <details :open="editingEventId === event.id">
                                    <summary>
                                        <BaseTextarea @click="editingEventId = event.id" :read-only="editingEventId !== event.id" :form="'comment-update-' + event.id" name="comment" :rows="1" v-model="event.after_state.data.comment" class="w-full" :resize="false" :classes="{textarea: '!p-0 !border-0 !outline-none !resize-none'}" />
                                    </summary>
                                    <div class="flex items-end" v-if="deal">
                                        <form method="post" class="w-full" @submit.prevent="onCommentUpdate" :id="'comment-update-' + event.id">
                                            <input type="hidden" name="action" :value="`${deal.id}/comments/${event.id}`" />
                                            <input type="hidden" name="action_id" :value="`patch/${deal.id}/comments/${event.id}`">
                                            <ul v-if="event.after_state.data?.files?.length > 0" class="flex gap-2 flex-wrap py-2">
                                                <li v-for="file of event.after_state.data.files">
                                                    <a class="underline text-primary-600 dark:text-primary-200" target="_blank" :href="file.url || fileUrl(file.path)">{{ file.name }}</a>
                                                </li>
                                            </ul>
                                            <BaseButton
                                                size="sm"
                                                type="submit"
                                                :disabled="isLoadingMap[`patch/${deal.id}/comments/${event.id}`]"
                                                :loading="isLoadingMap[`patch/${deal.id}/comments/${event.id}`]"
                                            >
                                                Сохранить
                                            </BaseButton>
                                        </form>
                                        <form method="post" @submit.prevent="onCommentDelete">
                                            <input type="hidden" name="action" :value="`${deal.id}/comments/${event.id}`" />
                                            <input type="hidden" name="action_id" :value="`delete/${deal.id}/comments/${event.id}`">
                                            <input type="hidden" name="pidx" :value="i">
                                            <input type="hidden" name="eidx" :value="eidx">
                                            <BaseButton
                                                size="sm"
                                                type="submit"
                                                color="danger"
                                                :disabled="isLoadingMap[`delete/${deal.id}/comments/${event.id}`]"
                                                :loading="isLoadingMap[`delete/${deal.id}/comments/${event.id}`]"
                                            >
                                                Удалить
                                            </BaseButton>
                                        </form>
                                    </div>
                                </details>
                            </div>
                        </div>
                    </BaseCard>
                    <div class="flex items-start space-x-4 mb-4" v-else-if="event.type === DealEventType.NewChatMessage">
                        <BaseAvatar
                            :text="event.originated_by?.username?.[0] ?? '?'"
                            :src="event.originated_by?.avatar ? fileUrl(event.originated_by.avatar) : undefined"
                            size="sm"
                            class="bg-primary-400 text-white dark:bg-primary-300"
                        />
                        <div class="flex flex-col w-full">
                            <p class="space-x-2">
                                <EventDate :event="event" />
                                <span>кому:</span>
                                <span v-if="event.target_group">{{ event.target_group.name }}</span>
                                <span v-else-if="event.target_user">{{ event.target_user.username }}</span>
                                <span v-else>всем</span>
                            </p>
                            <p class="mt-1">{{ event.after_state.data.message }}</p>
                            <ul v-if="event.after_state.data?.files?.length > 0" class="flex gap-2 flex-wrap py-2">
                                <li v-for="file of event.after_state.data.files">
                                    <audio v-if="file.type === 'voice'" controls class="w-full max-w-md">
                                        <source :src="fileUrl(file.path)" type="audio/mp3" />
                                        Your browser does not support the audio element.
                                    </audio>
                                    <a v-else class="underline text-primary-600 text-primary-600" target="_blank" :href="file.url || fileUrl(file.path)">{{ file.name }}</a>
                                </li>
                            </ul>
                        </div>
                    </div>
                    <div class="flex items-start space-x-4 mb-4" v-else-if="event.type === DealEventType.NewEmail">
                        <div class="dark:bg-muted-700 border border-muted-200 dark:border-muted-600 rounded-md">
                            <details class="group">
                                <summary class="p-2 flex gap-2 cursor-pointer">
                                    <Icon v-if="event.after_state.data.outgoing" name="ph:envelope-simple" class="size-8"/>
                                    <Icon v-else name="ph:envelope-simple-open" class="size-8"/>
                                    <div>
                                        <p class="text-[13px] text-muted-600 dark:text-muted-400">
                                            {{ new Date(event.after_state.data.sent_at).toLocaleString('ru') }}
                                            {{ event.after_state.data.outgoing ? 'Исходящее письмо' : 'Входящее письмо' }} от: {{ event.after_state.data.from }}
                                            кому: {{ event.after_state.data.to.map((r) => r.value.split('@')[0]).join(', ') }}
                                        </p>
                                        <p class="text-[15px] text-muted-900 underline dark:text-white">{{ event.after_state.data.subject }}</p>
                                        <MoveEventButton v-if="deal?.id && event.id > 0" :event="event" :deal-id="deal.id" @moved="removeEvent(event.id)" @click.stop.prevent />
                                        <p class="text-[15px] text-muted-900 dark:text-white group-open:hidden">{{ cleanup(event.after_state.data).snippet }}</p>
                                    </div>
                                </summary>
                                <div class="flex flex-col ml-12">
                                    <pre class="text-muted-900 text-[15px] whitespace-pre-line dark:text-white" v-html="cleanup(event.after_state.data).body"></pre>
                                    <ul class="flex items-center gap-2 py-6 mt-auto flex-wrap">
                                        <li v-for="file of event.after_state.data.files" class="basis-44">
                                            <a :href="fileUrl(file.path)" target="_blank" class="flex items-center gap-2 p-2 rounded-md bg-muted-50 w-full text-sm dark:bg-muted-800">
                                                <FileIcon :file-name="file.name" class="size-6" />
                                                <div class="flex flex-col">
                                                    <span class="text-muted-900 line-clamp-1 dark:text-white">{{ file.name }}</span>
                                                </div>
                                            </a>
                                        </li>
                                    </ul>
                                </div>
                            </details>
                        </div>
                    </div>
                    <div class="flex items-start space-x-4 mb-4" v-else-if="event.type === DealEventType.GroupedEmails">
                        <ul class="flex flex-col gap-2 rounded-md p-2 w-full dark:bg-muted-700 border border-muted-200 dark:border-muted-600 rounded-md shadow-sm">
                            <li v-for="e of event.events" class="bg-muted-100 dark:bg-muted-800 rounded-md">
                                <details class="group">
                                    <summary class="p-2 flex gap-2 cursor-pointer">
                                        <Icon v-if="e.after_state.data.outgoing" name="ph:envelope-simple" class="size-8"/>
                                        <Icon v-else name="ph:envelope-simple-open" class="size-8"/>
                                        <div>
                                            <p class="text-[13px] text-muted-600 dark:text-muted-400">
                                                {{ new Date(e.after_state.data.sent_at).toLocaleString('ru') }}
                                                {{ e.after_state.data.outgoing ? 'Исходящее письмо' : 'Входящее письмо' }} от: {{ e.after_state.data.from }}
                                                кому: {{ e.after_state.data.to.map((r) => r.value.split('@')[0]).join(', ') }}
                                            </p>
                                            <p class="text-[15px] text-muted-900 underline dark:text-white">{{ e.after_state.data.subject }}</p>
                                            <p class="text-[15px] text-muted-900 dark:text-white group-open:hidden">{{ cleanup(e.after_state.data).snippet }}</p>
                                        </div>
                                    </summary>
                                    <div class="flex flex-col ml-12">
                                        <pre class="text-muted-900 text-[15px] whitespace-pre-line dark:text-white" v-html="cleanup(e.after_state.data).body"></pre>
                                        <ul class="flex items-center gap-2 py-6 mt-auto flex-wrap">
                                            <li v-for="file of e.after_state.data.files" class="basis-44">
                                                <a :href="fileUrl(file.path)" target="_blank" class="flex items-center gap-2 p-2 rounded-md bg-muted-50 w-full text-sm dark:bg-muted-800">
                                                    <FileIcon :file-name="file.name" class="size-6" />
                                                    <div class="flex flex-col">
                                                        <span class="text-muted-900 line-clamp-1 dark:text-white">{{ file.name }}</span>
                                                    </div>
                                                </a>
                                            </li>
                                        </ul>
                                    </div>
                                </details>
                            </li>
                        </ul>
                    </div>
                    <div class="flex items-start space-x-4 mb-4" v-else-if="event.type === DealEventType.NewCallRecording || event.type === DealEventType.NewTelegramCall">
                        <BaseAvatar
                            :text="event.originated_by?.username?.[0] ?? '?'"
                            :src="event.originated_by?.avatar ? fileUrl(event.originated_by.avatar) : undefined"
                            size="sm"
                            class="bg-primary-400 text-white dark:bg-primary-300"
                        />
                        <div class="flex flex-col w-full">
                            <p class="space-x-2">
                                <EventDate :event="event" />
                                <span>кому:</span>
                                <span v-if="event.target_group">{{ event.target_group.name }}</span>
                                <span v-else-if="event.target_user">{{ event.target_user.username }}</span>
                                <span v-else>всем</span>
                            </p>
                            <audio controls class="mt-1 w-full max-w-md">
                                <source :src="fileUrl(event.after_state.path)" type="audio/mp3" />
                                Your browser does not support the audio element.
                            </audio>
                        </div>
                    </div>
                    <div class="mb-4" v-else-if="event.type === DealEventType.GroupedTgMessages">
                        <ul class="flex flex-col gap-2 p-2 w-full dark:bg-muted-700 border border-muted-200 dark:border-muted-600 rounded-md shadow-sm">
                            <li v-for="e of event.events" class="bg-muted-100 dark:bg-muted-800 rounded-md p-3 flex items-start space-x-2 max-w-fit" :class="[e.after_state.outgoing ? 'ml-auto' : '']">
                                <BaseAvatar
                                    :text="e.originated_by?.username?.[0] ?? '?'"
                                    :src="e.originated_by?.avatar ? fileUrl(e.originated_by.avatar) : undefined"
                                    size="sm"
                                    class="bg-primary-400 text-white dark:bg-primary-300"
                                />
                                <div class="flex flex-col w-full">
                                    <p class="space-x-2">
                                        <EventDate :event="e" />
                                        <span class="inline-flex items-center gap-1 text-sky-600 dark:text-sky-400"><Icon name="ph:telegram-logo" class="size-4" />Telegram</span>
                                        <span>кому:</span>
                                        <span v-if="e.target_group">{{ e.target_group.name }}</span>
                                        <span v-else-if="e.target_user">{{ e.target_user.username }}</span>
                                        <span v-else>всем</span>
                                    </p>
                                    <audio v-if="e.type === DealEventType.NewTelegramCall" controls class="mt-1 w-full max-w-md">
                                        <source :src="fileUrl(e.after_state.path)" type="audio/mp3" />
                                        Your browser does not support the audio element.
                                    </audio>
                                    <template v-else>
                                        <p class="mt-1">{{ e.after_state.message }}</p>
                                        <ul v-if="e.after_state?.files?.length > 0" class="flex gap-2 flex-wrap py-2">
                                            <li v-for="file of e.after_state.files" class="w-full">
                                                <audio v-if="file.type === 'voice'" controls class="w-full max-w-md">
                                                    <source :src="fileUrl(file.path)" type="audio/mp3" />
                                                    Your browser does not support the audio element.
                                                </audio>
                                                <a v-else class="underline text-primary-600 dark:text-primary-200" target="_blank" :href="file.url || fileUrl(file.path)">{{ file.name }}</a>
                                            </li>
                                        </ul>
                                    </template>
                                </div>
                            </li>
                        </ul>
                    </div>
                    <div class="flex items-start space-x-4 mb-4" v-else-if="event.type === DealEventType.NewTelegramMessage">
                        <BaseAvatar
                            :text="event.originated_by?.username?.[0] ?? '?'"
                            :src="event.originated_by?.avatar ? fileUrl(event.originated_by.avatar) : undefined"
                            size="sm"
                            class="bg-primary-400 text-white dark:bg-primary-300"
                        />
                        <div class="flex flex-col w-full">
                            <p class="space-x-2">
                                <EventDate :event="event" />
                                <span class="inline-flex items-center gap-1 text-sky-600 dark:text-sky-400"><Icon name="ph:telegram-logo" class="size-4" />Telegram</span>
                                <span>кому:</span>
                                <span v-if="event.target_group">{{ event.target_group.name }}</span>
                                <span v-else-if="event.target_user">{{ event.target_user.username }}</span>
                                <span v-else>всем</span>
                                <MoveEventButton v-if="deal?.id && event.id > 0" :event="event" :deal-id="deal.id" @moved="removeEvent(event.id)" />
                            </p>
                            <p class="mt-1">{{ event.after_state.message }}</p>
                            <ul v-if="event.after_state?.files?.length > 0" class="flex gap-2 flex-wrap py-2">
                                <li v-for="file of event.after_state.files" class="w-full">
                                    <audio v-if="file.type === 'voice'" controls class="w-full max-w-md">
                                        <source :src="fileUrl(file.path)" type="audio/mp3" />
                                        Your browser does not support the audio element.
                                    </audio>
                                    <a v-else class="underline text-primary-600 dark:text-primary-200" target="_blank" :href="file.url || fileUrl(file.path)">{{ file.name }}</a>
                                </li>
                            </ul>
                        </div>
                    </div>
                    <div class="flex items-start space-x-4 mb-4" v-else-if="event.type === DealEventType.NewWhatsAppMessage">
                        <BaseAvatar
                            :text="event.originated_by?.username?.[0] ?? '?'"
                            :src="event.originated_by?.avatar ? fileUrl(event.originated_by.avatar) : undefined"
                            size="sm"
                            class="bg-emerald-500 text-white"
                        />
                        <div class="flex flex-col w-full">
                            <p class="space-x-2">
                                <EventDate :event="event" />
                                <span class="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><Icon name="ph:whatsapp-logo" class="size-4" />WhatsApp</span>
                                <span>кому:</span>
                                <span v-if="event.target_user">{{ event.target_user.username }}</span>
                                <MoveEventButton v-if="deal?.id && event.id > 0" :event="event" :deal-id="deal.id" @moved="removeEvent(event.id)" />
                            </p>
                            <p class="mt-1 whitespace-pre-line">{{ event.after_state?.message }}</p>
                            <ul v-if="event.after_state?.files?.length > 0" class="flex gap-2 flex-wrap py-2">
                                <li v-for="file of event.after_state.files" class="w-full">
                                    <audio v-if="file.type === 'voice' || file.type === 'audio'" controls class="w-full max-w-md" :src="file.url || fileUrl(file.path)"></audio>
                                    <img v-else-if="file.type === 'photo' || file.type === 'sticker'" :src="file.url || fileUrl(file.path)" :alt="file.name" class="max-h-64 rounded-md" loading="lazy" />
                                    <video v-else-if="file.type === 'video'" controls class="max-h-64 rounded-md" :src="file.url || fileUrl(file.path)"></video>
                                    <a v-else class="underline text-primary-600 dark:text-primary-200" target="_blank" :href="file.url || fileUrl(file.path)">{{ file.name }}</a>
                                </li>
                            </ul>
                        </div>
                    </div>
                    <div class="flex items-start space-x-4 mb-4" v-else-if="event.type === DealEventType.NewTaskStatus">
                        <Icon name="ph:check-circle" class="size-10 text-primary-600 dark:text-primary-200" />
                        <div class="flex flex-col">
                            <p> <EventDate :event="event" /> </p>
                            <p class="line-through text-muted-900 dark:text-white">
                                <span class="">{{ event.after_state.data.type.name }}</span>
                                <span v-if="event.after_state.data.label">: {{ event.after_state.data.label }}</span>
                            </p>
                        </div>
                    </div>
                </li>
            </ul>
            <div ref="commentScrollRef"></div>
        </div>
        <ul v-if="tasks.length" class="sticky bottom-0 rounded-md rounded-t-none shadow-md p-4 max-h-48 overflow-y-auto w-full bg-white dark:bg-muted-900 border-t border-t-muted-200 dark:border-t-muted-700 no-scrollbar">
            <li v-for="task in tasks" :key="task.id" class="text-muted-600 text-sm dark:text-muted-400 mb-4 last:mb-0">
                <details>
                    <summary class="cursor-pointer">
                        <p class="space-x-2">
                            <Icon name="ph:clock-countdown" class="size-4" />
                            <span>{{ new Date(task.start).toLocaleString('ru') }}</span>
                            <span class="ml-2">для {{ task.agent?.username || task.group?.name }}</span>
                            <span>{{ task.type.name }} - {{ task.label }}</span>
                        </p>
                    </summary>
                    <form method="post" class="flex items-center gap-2 mt-2 ml-6" @submit.prevent="onTaskClose">
                        <input type="hidden" name="action" :value="`${task.id}/close`">
                        <BaseInput name="result" :classes="{wrapper: 'w-full'}" placeholder="Добавить результат" required />
                        <BaseButton type="submit" 
                                    :loading="isLoadingMap[`${task.id}/close`]" 
                                    :disabled="isLoadingMap[`${task.id}/close`]"
                        >Выполнить</BaseButton>
                    </form>
                </details>
            </li>
        </ul>
    </BaseCard>
</template>

<script lang="ts" setup>
import BaseButton from '~/components/base/BaseButton.vue';
import BaseInput from '~/components/form/BaseInput.vue';
import { useIntersectionObserver } from '~/composables/useIntersectionObserver';
import { type Deal,type DealEvent, DealEventType, type Task } from '~/types/deal';
import type { PaginatedResponse } from '~/types/generics';

import EventDate from './EventDate.vue';
import DOMPurify from 'dompurify';
import FileIcon from './FileIcon.vue';
import MoveEventButton from '~/components/deal/MoveEventButton.vue';
import { uploadUrl } from '~/utils/files';
import type { Email } from '~/types/mail';

const props = withDefaults(defineProps<{
    deal?: Deal;
    events: {pages: PaginatedResponse<DealEvent>[]};
    intersected?: () => void;
    startObserver?: boolean;
    eventsLoading?: boolean;
    tasks: Task[];
    classes?: {
        wrapper?: string | string[]
  },
}>(), {
    events: () => ({pages: []}),
    startObserver: false,
    tasks: () => [],
});


const emits = defineEmits(['task-closed']);

// a message moved to another deal leaves this deal's history
function removeEvent(id: number) {
    for (const page of props.events.pages) {
        if (page?.data) page.data = page.data.filter((e) => e.id !== id);
    }
}
const toast = useToast('GlobalToast');
const dealService = useService('deals', { auth: true });
const taskService = useService('tasks', { auth: true });
const editingEventId = ref<number>();
const infiniteTarget = ref();
const chatAreaRef = ref();
const commentScrollRef = inject<Ref<HTMLElement>>('commentScrollRef');
const { runWithId: updateEventAsync, isLoadingMap } = useAsync();

const observer = useIntersectionObserver(infiniteTarget, async (entries) =>{
    const entry = entries[0];
    if (!entry.isIntersecting) return;
    props.intersected?.();
}, {root: chatAreaRef.value, immediate: false});

const fileUrl = uploadUrl;

const sanitize = DOMPurify.sanitize;
const sanitizedMap: Record<number, {body: string, snippet: string}> = {};

function cleanup(email: Email) {
    const body = sanitize(email.body);
    const doc = new DOMParser().parseFromString(body, 'text/html');
    const values = {body, snippet: doc.body.textContent?.slice(0, 200) || ''};
    sanitizedMap[email.id] = values;
    email.sanitized = values;
    return values;
}

async function onCommentUpdate(e: Event) {
    if (!props.deal?.id) return;
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const action = formData.get('action') as string;
    const actionId = formData.get('action_id') as string;
    const result = await promiseResult(updateEventAsync(dealService.patch(action, formData).exec(), actionId));
    if (!result.ok) toast.show({message: result.error.message, timeout: 3000, type: 'error'});
}

async function onCommentDelete(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const action = formData.get('action') as string;
    const actionId = formData.get('action_id') as string;
    const pidx = Number(formData.get('pidx') as string);
    const eidx = Number(formData.get('eidx') as string);
    const deleted = props.events.pages[pidx].data.splice(eidx, 1);
    if (!props.deal?.id) return;
    const result = await promiseResult(updateEventAsync(dealService.remove(action).exec(), actionId));
    if (!result.ok) {
        toast.show({message: result.error.message, timeout: 3000, type: 'error'});
        props.events.pages[pidx].data.splice(eidx, 0, deleted[0]);
    }
}
const groupedEvents = computed(() => {
    const events: {pages: PaginatedResponse<DealEvent>[]} = JSON.parse(JSON.stringify(props.events));
    const groupPosition: Record<string, number> = {} 
    for (let i = 0, len = events.pages.length; i < len; i++) {
        const page = events.pages[i];
        const pageCopy = JSON.parse(JSON.stringify(events.pages[i]));
        for (let j = 0, jlen = page.data.length; j < jlen; j++) {
            const currentEvent = page.data[j];
            const previousEvent = page.data[j - 1];
            if (currentEvent.type === DealEventType.NewEmail) {
                if (previousEvent?.type !== DealEventType.NewEmail) continue;
                let pos = groupPosition.email;
                if (pos == null) {
                    groupPosition.email = pos = j - 1;
                    pageCopy.data[pos] = {type: DealEventType.GroupedEmails, events: [previousEvent]}
                }
                pageCopy.data[j] = null;
                pageCopy.data[pos].events.push(currentEvent);
            }
            if (currentEvent.type === DealEventType.NewTelegramMessage || currentEvent.type === DealEventType.NewTelegramCall) {
                if (previousEvent?.type !== DealEventType.NewTelegramCall && previousEvent?.type !== DealEventType.NewTelegramMessage) continue;
                let pos = groupPosition.telegram;
                if (pos == null) {
                    groupPosition.telegram = pos = j - 1;
                    pageCopy.data[pos] = {type: DealEventType.GroupedTgMessages, events: [previousEvent]}
                }
                pageCopy.data[j] = null;
                pageCopy.data[pos].events.push(currentEvent);
            }
        }
        events.pages[i].data = pageCopy.data.filter(Boolean);
    }

    return events;
});

async function onTaskClose(e: Event) {
    if (!props.deal?.id) return;
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const result = formData.get('result');
    const action = formData.get('action') as string;
    const updateResult = await promiseResult(updateEventAsync(taskService.patch(action, {result}).exec(), action));
    if (!updateResult.ok) return toast.show({message: updateResult.error.message, timeout: 3000, type: 'error'});
    emits('task-closed')
}

watchEffect(() => {
    if (props.startObserver) observer.resume();
});

</script>