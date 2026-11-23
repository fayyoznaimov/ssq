<template>
    <BaseCard :class="['flex-1 relative max-h-[40rem] overflow-y-auto', classes?.wrapper]" rounded="md" ref="chatAreaRef">
        <slot name="header" />
        <div class="flex flex-col p-4 no-scrollbar mb-52 h-full">
            <div v-if="eventsLoading" class="text-center w-full text-xs text-muted-600 dark:text-muted-200">Загрузка...</div>
            <p v-else-if="isEmpty" class="text-center w-full text-xs text-muted-600 dark:text-muted-200">Событий пока нет</p>
            <div ref="infiniteTarget"></div>
            <!--
                The feed, oldest at the top and the newest next to the composer: all loaded pages in
                the order of time, a separator per day, messages of one channel in a row as one block.
            -->
            <ul class="flex flex-col break-words">
                <li v-for="item in feed" :key="item.key" class="text-muted-600 text-sm dark:text-muted-400">
                    <!-- ============================== the day -->
                    <div v-if="item.kind === 'day'" data-feed="day" class="flex items-center gap-3 my-3 text-xs text-muted-500 dark:text-muted-400">
                        <span class="h-px flex-1 bg-muted-200 dark:bg-muted-700"></span>
                        <span class="font-medium">{{ item.label }}</span>
                        <span class="h-px flex-1 bg-muted-200 dark:bg-muted-700"></span>
                    </div>

                    <!-- ============================== a conversation: Telegram, WhatsApp, e-mail -->
                    <div v-else-if="item.kind === 'chat'" class="mb-4 rounded-md border border-muted-200 dark:border-muted-700 p-2">
                        <p class="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pb-2 text-xs text-muted-500 dark:text-muted-400">
                            <span class="inline-flex items-center gap-1 font-medium" :class="CHANNELS[item.channel].color">
                                <Icon :name="CHANNELS[item.channel].icon" class="size-4" />{{ CHANNELS[item.channel].label }}
                            </span>
                            <span v-if="clientOf(item.events)">· {{ clientOf(item.events) }}</span>
                            <span v-if="item.events.length > 1">· {{ item.events.length }} {{ messagesWord(item.events.length) }}</span>
                            <NuxtLink v-if="showDeal && item.events[0]?.deal?.id" :to="'/deals/' + item.events[0].deal.id" class="underline hover:text-primary-600 dark:hover:text-primary-300">
                                № {{ item.events[0].deal.display_id ?? item.events[0].deal.id }} {{ item.events[0].deal.label }}
                            </NuxtLink>
                        </p>
                        <ul class="flex flex-col gap-2">
                            <li v-for="e in item.events" :key="e.id" class="flex" :class="isOutgoing(e) ? 'justify-end' : 'justify-start'">
                                <!-- a letter -->
                                <div v-if="e.type === DealEventType.NewEmail" class="w-full max-w-[95%] min-w-0">
                                    <div v-if="e.after_state?.hidden" class="flex items-center gap-2 rounded-md border border-dashed border-muted-300 dark:border-muted-600 p-2 text-[13px]">
                                        <Icon name="ph:envelope-simple" class="size-5 shrink-0" />
                                        <span>{{ timeOf(e.created_at) }} · {{ isOutgoing(e) ? 'Исходящее письмо' : 'Входящее письмо' }} · скрыто: нет доступа к почте</span>
                                    </div>
                                    <details v-else class="group rounded-md border border-muted-200 dark:border-muted-600 bg-white dark:bg-muted-800/60">
                                        <summary class="p-2 flex gap-2 cursor-pointer">
                                            <Icon :name="isOutgoing(e) ? 'ph:envelope-simple' : 'ph:envelope-simple-open'" class="size-6 shrink-0 mt-0.5" />
                                            <div class="min-w-0 flex-1">
                                                <p class="text-[13px] text-muted-500 dark:text-muted-400 break-all">
                                                    {{ timeOf(mailOf(e).sent_at || e.created_at) }} · {{ isOutgoing(e) ? 'Исходящее' : 'Входящее' }}
                                                    · от: {{ mailOf(e).from || personName(e.originated_by) }}
                                                    <template v-if="recipients(mailOf(e))">· кому: {{ recipients(mailOf(e)) }}</template>
                                                </p>
                                                <p class="text-[15px] text-muted-900 underline dark:text-white">{{ mailOf(e).subject || '(без темы)' }}</p>
                                                <p class="text-[14px] text-muted-700 dark:text-muted-300 group-open:hidden line-clamp-2">{{ mailView(mailOf(e)).snippet }}</p>
                                                <MoveEventButton v-if="deal?.id && e.id > 0" :event="e" :deal-id="deal.id" @moved="removeEvent(e.id)" @click.stop.prevent />
                                            </div>
                                        </summary>
                                        <div class="flex flex-col px-2 pb-2 ml-8">
                                            <div class="text-muted-900 text-[15px] whitespace-pre-line break-words dark:text-white" v-html="mailView(mailOf(e)).body"></div>
                                            <p v-if="mailOf(e).quoted" class="mt-1 text-xs text-muted-500 dark:text-muted-400">Цитата предыдущих писем не показана — письмо целиком в разделе «Почта».</p>
                                            <ul v-if="mailOf(e).files?.length" class="flex items-center gap-2 pt-3 flex-wrap">
                                                <li v-for="file of mailOf(e).files" :key="file.id ?? file.path" class="basis-44">
                                                    <a :href="fileUrl(file.path)" target="_blank" rel="noopener" class="flex items-center gap-2 p-2 rounded-md bg-muted-50 w-full text-sm dark:bg-muted-800">
                                                        <FileIcon :file-name="file.name" class="size-6" />
                                                        <span class="text-muted-900 line-clamp-1 dark:text-white">{{ file.name }}</span>
                                                    </a>
                                                </li>
                                            </ul>
                                            <p v-if="removedFiles(mailOf(e))" class="mt-1 text-xs text-muted-500 dark:text-muted-400">{{ removedFiles(mailOf(e)) }}</p>
                                            <p v-if="movedFrom(e)" class="mt-1 text-xs text-muted-500 dark:text-muted-400">{{ movedFrom(e) }}</p>
                                        </div>
                                    </details>
                                </div>

                                <!-- a message or a call in a messenger -->
                                <div
                                    v-else
                                    class="max-w-[85%] min-w-0 rounded-lg px-3 py-2"
                                    :class="isOutgoing(e) ? 'bg-primary-500/10 dark:bg-primary-500/20' : 'bg-muted-100 dark:bg-muted-800'"
                                >
                                    <p class="flex flex-wrap items-center gap-x-2 text-xs text-muted-500 dark:text-muted-400">
                                        <EventDate :event="e" />
                                        <span v-if="isOutgoing(e) && e.target_user">→ {{ personName(e.target_user) }}</span>
                                        <span v-if="stateOf(e).edited" :title="stateOf(e).original_message ? 'было: ' + stateOf(e).original_message : undefined">(изменено)</span>
                                        <MoveEventButton v-if="deal?.id && e.id > 0 && e.type !== DealEventType.NewTelegramCall" :event="e" :deal-id="deal.id" @moved="removeEvent(e.id)" />
                                    </p>
                                    <template v-if="e.type === DealEventType.NewTelegramCall">
                                        <p class="mt-1 text-muted-800 dark:text-muted-100">Звонок в Telegram<template v-if="durationOf(e.duration)">, {{ durationOf(e.duration) }}</template></p>
                                        <audio v-if="e.after_state?.path" controls preload="none" class="mt-1 w-64 max-w-full" :src="fileUrl(e.after_state.path)"></audio>
                                    </template>
                                    <template v-else>
                                        <p v-if="stateOf(e).message" class="mt-1 whitespace-pre-line break-words text-muted-800 dark:text-muted-100">{{ stateOf(e).message }}</p>
                                        <ul v-if="stateOf(e).files?.length" class="mt-1 flex flex-col gap-1">
                                            <li v-for="(file, fi) of stateOf(e).files" :key="fi">
                                                <audio v-if="mediaKind(file) === 'audio'" controls preload="none" class="w-64 max-w-full" :src="file.url || fileUrl(file.path)"></audio>
                                                <a v-else-if="mediaKind(file) === 'image'" :href="file.url || fileUrl(file.path)" target="_blank" rel="noopener">
                                                    <img :src="file.url || fileUrl(file.path)" :alt="file.name" class="max-h-64 max-w-full rounded-md" loading="lazy" />
                                                </a>
                                                <video v-else-if="mediaKind(file) === 'video'" controls preload="metadata" class="max-h-64 max-w-full rounded-md" :src="file.url || fileUrl(file.path)"></video>
                                                <a v-else class="inline-flex items-center gap-1 underline text-primary-600 dark:text-primary-300" target="_blank" rel="noopener" :href="file.url || fileUrl(file.path)">
                                                    <FileIcon :file-name="file.name || ''" class="size-4" />{{ file.name || 'Файл' }}
                                                </a>
                                                <p v-if="file.caption && file.caption !== stateOf(e).message" class="text-xs whitespace-pre-line">{{ file.caption }}</p>
                                            </li>
                                        </ul>
                                        <a v-if="mapLink(stateOf(e).location)" :href="mapLink(stateOf(e).location) ?? undefined" target="_blank" rel="noopener noreferrer" class="mt-1 inline-flex items-center gap-1 underline text-primary-600 dark:text-primary-300">
                                            <Icon name="ph:map-pin" class="size-4" />Геолокация на карте
                                        </a>
                                        <p v-else-if="typeof stateOf(e).location === 'string' && stateOf(e).location" class="mt-1 inline-flex items-center gap-1">
                                            <Icon name="ph:map-pin" class="size-4" />{{ stateOf(e).location }}
                                        </p>
                                        <p v-if="stateOf(e).contact" class="mt-1 inline-flex items-center gap-1 text-muted-800 dark:text-muted-100">
                                            <Icon name="ph:address-book" class="size-4" />Контакт: {{ [stateOf(e).contact.first_name, stateOf(e).contact.last_name].filter(Boolean).join(' ') }} {{ stateOf(e).contact.phone_number }}
                                        </p>
                                        <p v-if="movedFrom(e)" class="mt-1 text-xs text-muted-500 dark:text-muted-400">{{ movedFrom(e) }}</p>
                                    </template>
                                </div>
                            </li>
                        </ul>
                    </div>

                    <!-- ============================== one event -->
                    <template v-else>
                        <template v-for="event in [item.event]" :key="'e' + event.id">
                            <!-- a comment (note) -->
                            <BaseCard v-if="event.type === DealEventType.NewComment" class="p-2 mb-4" rounded="sm">
                                <div class="flex items-start space-x-4">
                                    <Icon name="ph:article" size="32" class="shrink-0" />
                                    <div class="flex flex-col w-full min-w-0">
                                        <p class="text-xs text-muted-500 dark:text-muted-400">
                                            <EventDate :event="event" />
                                            <span v-if="event.after_state?.data?.edited_at" class="ml-2" :title="'изменено ' + new Date(event.after_state.data.edited_at).toLocaleString('ru')">(изменено)</span>
                                            <NuxtLink v-if="showDeal && event.deal?.id" :to="'/deals/' + event.deal.id" class="ml-2 underline hover:text-primary-600 dark:hover:text-primary-300">№ {{ event.deal.display_id ?? event.deal.id }} {{ event.deal.label }}</NuxtLink>
                                        </p>
                                        <details :open="editingEventId === event.id">
                                            <summary class="list-none">
                                                <BaseTextarea
                                                    v-model="event.after_state.data.comment"
                                                    :readonly="editingEventId !== event.id"
                                                    :form="'comment-update-' + event.id"
                                                    name="comment"
                                                    :rows="1"
                                                    autogrow
                                                    class="w-full"
                                                    :resize="false"
                                                    :classes="{textarea: '!p-0 !border-0 !outline-none !resize-none !bg-transparent'}"
                                                    @click="mayEdit(event) && (editingEventId = event.id)"
                                                />
                                            </summary>
                                            <div class="flex items-end gap-2" v-if="deal && mayEdit(event)">
                                                <form method="post" class="w-full" @submit.prevent="onCommentUpdate" :id="'comment-update-' + event.id">
                                                    <input type="hidden" name="action" :value="`${deal.id}/comments/${event.id}`" />
                                                    <input type="hidden" name="action_id" :value="`patch/${deal.id}/comments/${event.id}`">
                                                    <BaseButton
                                                        size="sm"
                                                        type="submit"
                                                        :disabled="isLoadingMap[`patch/${deal.id}/comments/${event.id}`]"
                                                        :loading="isLoadingMap[`patch/${deal.id}/comments/${event.id}`]"
                                                    >
                                                        Сохранить
                                                    </BaseButton>
                                                </form>
                                                <BaseButton
                                                    size="sm"
                                                    color="danger"
                                                    :disabled="isLoadingMap[`delete/${deal.id}/comments/${event.id}`]"
                                                    :loading="isLoadingMap[`delete/${deal.id}/comments/${event.id}`]"
                                                    @click="onCommentDelete(event)"
                                                >
                                                    Удалить
                                                </BaseButton>
                                            </div>
                                        </details>
                                        <!-- the files of a note: seen without opening it (they were inside the closed details) -->
                                        <ul v-if="event.after_state?.data?.files?.length > 0" class="flex gap-2 flex-wrap py-2">
                                            <li v-for="file of event.after_state.data.files" :key="file.id ?? file.path ?? file.url">
                                                <a class="underline text-primary-600 dark:text-primary-200" target="_blank" rel="noopener" :href="file.url || fileUrl(file.path)">{{ file.name }}</a>
                                            </li>
                                        </ul>
                                        <p v-if="removedFiles(event.after_state?.data)" class="text-xs text-muted-500 dark:text-muted-400">{{ removedFiles(event.after_state?.data) }}</p>
                                    </div>
                                </div>
                            </BaseCard>

                            <!-- an inner chat message between employees -->
                            <div class="flex items-start space-x-4 mb-4" v-else-if="event.type === DealEventType.NewChatMessage">
                                <BaseAvatar
                                    :text="event.originated_by?.username?.[0] ?? '?'"
                                    :src="event.originated_by?.avatar ? fileUrl(event.originated_by.avatar) : undefined"
                                    size="sm"
                                    class="bg-primary-400 text-white dark:bg-primary-300 shrink-0"
                                />
                                <div class="flex flex-col w-full min-w-0">
                                    <p class="text-xs text-muted-500 dark:text-muted-400 space-x-2">
                                        <EventDate :event="event" />
                                        <span>кому:</span>
                                        <span v-if="event.target_group">{{ event.target_group.name }}</span>
                                        <span v-else-if="event.target_user">{{ personName(event.target_user) }}</span>
                                        <span v-else>всем</span>
                                        <NuxtLink v-if="showDeal && event.deal?.id" :to="'/deals/' + event.deal.id" class="underline hover:text-primary-600 dark:hover:text-primary-300">№ {{ event.deal.display_id ?? event.deal.id }} {{ event.deal.label }}</NuxtLink>
                                    </p>
                                    <p class="mt-1 whitespace-pre-line break-words text-muted-800 dark:text-muted-100">{{ event.after_state?.data?.message }}</p>
                                    <ul v-if="event.after_state?.data?.files?.length > 0" class="flex gap-2 flex-wrap py-2">
                                        <li v-for="(file, fi) of event.after_state.data.files" :key="fi">
                                            <audio v-if="file.type === 'voice'" controls preload="none" class="w-full max-w-md" :src="fileUrl(file.path)"></audio>
                                            <a v-else class="underline text-primary-600 dark:text-primary-200" target="_blank" rel="noopener" :href="file.url || fileUrl(file.path)">{{ file.name }}</a>
                                        </li>
                                    </ul>
                                    <p v-if="removedFiles(event.after_state?.data)" class="text-xs text-muted-500 dark:text-muted-400">{{ removedFiles(event.after_state?.data) }}</p>
                                </div>
                            </div>

                            <!-- everything else: an icon, when and who, what happened -->
                            <div v-else class="flex items-start gap-3 mb-3">
                                <Icon :name="iconOf(event)" class="size-5 shrink-0 mt-0.5" :class="iconColorOf(event)" />
                                <div class="min-w-0 flex-1">
                                    <p class="text-xs text-muted-500 dark:text-muted-400">
                                        <EventDate :event="event" />
                                        <NuxtLink v-if="showDeal && event.deal?.id" :to="'/deals/' + event.deal.id" class="ml-2 underline hover:text-primary-600 dark:hover:text-primary-300">№ {{ event.deal.display_id ?? event.deal.id }} {{ event.deal.label }}</NuxtLink>
                                    </p>

                                    <p v-if="event.type === DealEventType.NewDeal" class="text-muted-800 dark:text-muted-100">
                                        Сделка создана: <NuxtLink class="underline" :to="'/deals/' + (event.after_state?.data?.id ?? event.deal?.id)">{{ event.after_state?.data?.label || 'без названия' }}</NuxtLink>
                                    </p>
                                    <p v-else-if="event.type === DealEventType.NewCtrAgent" class="text-muted-800 dark:text-muted-100">
                                        Контакт добавлен в сделку: <NuxtLink class="underline" :to="'/lists/contacts/' + event.after_state?.data?.id">{{ event.after_state?.data?.username }}</NuxtLink>
                                    </p>
                                    <p v-else-if="event.type === DealEventType.NewCompany" class="text-muted-800 dark:text-muted-100">
                                        Компания добавлена в сделку: <NuxtLink class="underline" :to="'/lists/companies/' + event.after_state?.data?.id">{{ event.after_state?.data?.name }}</NuxtLink>
                                    </p>
                                    <p v-else-if="event.type === DealEventType.NewFieldValue || event.type === DealEventType.NewUpdatedFieldValue" class="text-muted-800 dark:text-muted-100">
                                        {{ fieldLabel(event.after_state?.data?.field, event.field_of, event.after_state?.data?.subject) }}:
                                        <template v-if="event.type === DealEventType.NewUpdatedFieldValue">
                                            <span class="text-muted-500 dark:text-muted-400">{{ fieldValue(event.after_state?.data?.field, event.after_state?.data?.old_value, event.after_state?.data?.old_label) }}</span> →
                                        </template>
                                        <span class="font-medium">{{ fieldValue(event.after_state?.data?.field, event.after_state?.data?.new_value, event.after_state?.data?.new_label) }}</span>
                                    </p>
                                    <div v-else-if="event.type === DealEventType.NewStage" class="text-muted-800 dark:text-muted-100">
                                        Этап:
                                        <template v-if="event.before_state?.data?.stage?.name">
                                            <span class="inline px-1 py-0.5 rounded-sm" :style="{'background-color': event.before_state.data.stage.color}">{{ event.before_state.data.stage.name }}</span> →
                                        </template>
                                        <span class="inline px-1 py-0.5 rounded-sm" :style="{'background-color': event.after_state?.data?.stage?.color}">{{ event.after_state?.data?.stage?.name ?? '—' }}</span>
                                    </div>
                                    <template v-else-if="event.type === DealEventType.NewTask">
                                        <p class="text-muted-800 dark:text-muted-100">Задача поставлена: <span class="font-medium">{{ taskTitle(event.after_state?.data) }}</span></p>
                                        <p v-if="taskMeta(event.after_state?.data)" class="text-xs text-muted-500 dark:text-muted-400">{{ taskMeta(event.after_state?.data) }}</p>
                                    </template>
                                    <template v-else-if="event.type === EVENT_TASK_UPDATE">
                                        <p class="text-muted-800 dark:text-muted-100">Задача изменена: <span class="font-medium">{{ taskTitle(event.after_state?.data) }}</span></p>
                                        <ul class="text-xs text-muted-500 dark:text-muted-400">
                                            <li v-for="(change, ci) in taskChanges(event.before_state?.data, event.after_state?.data)" :key="ci">{{ change }}</li>
                                        </ul>
                                    </template>
                                    <template v-else-if="event.type === DealEventType.NewTaskStatus">
                                        <p class="text-muted-800 dark:text-muted-100">Задача выполнена: <span class="line-through">{{ taskTitle(event.after_state?.data) }}</span></p>
                                        <p v-if="event.after_state?.data?.result" class="whitespace-pre-line text-muted-800 dark:text-muted-100">Итог: {{ event.after_state.data.result }}</p>
                                        <p v-if="taskWho(event.after_state?.data)" class="text-xs text-muted-500 dark:text-muted-400">исполнитель: {{ taskWho(event.after_state?.data) }}</p>
                                    </template>
                                    <template v-else-if="event.type === DealEventType.NewCallRecording">
                                        <p class="text-muted-800 dark:text-muted-100">
                                            {{ isOutgoing(event) ? 'Исходящий звонок' : 'Входящий звонок' }}<template v-if="durationOf(event.duration)">, {{ durationOf(event.duration) }}</template>
                                            <span v-if="event.target_user || event.target_group" class="text-muted-500 dark:text-muted-400"> · кому: {{ event.target_group?.name ?? personName(event.target_user) }}</span>
                                            <span v-if="event.after_state?.number" class="text-muted-500 dark:text-muted-400"> · {{ event.after_state.number }}</span>
                                        </p>
                                        <audio v-if="event.after_state?.path" controls preload="none" class="mt-1 w-full max-w-md" :src="fileUrl(event.after_state.path)"></audio>
                                    </template>
                                    <p v-else-if="event.type === DealEventType.NewProduct" class="text-muted-800 dark:text-muted-100">
                                        Товар добавлен: <span class="font-medium">{{ event.after_state?.data?.product?.name ?? 'товар' }}</span>
                                        <template v-if="event.after_state?.data?.quantity"> — {{ event.after_state.data.quantity }} × {{ fieldValue('price', event.after_state.data.price) }}</template>
                                    </p>
                                    <p v-else-if="event.type === DealEventType.NewSMS" class="whitespace-pre-line text-muted-800 dark:text-muted-100">
                                        SMS: {{ event.after_state?.data?.message ?? event.after_state?.data?.text ?? event.after_state?.message ?? '' }}
                                    </p>
                                    <p v-else-if="event.type === EVENT_MOVED" class="text-muted-800 dark:text-muted-100">
                                        {{ capitalize(MOVED_WHAT[event.after_state?.data?.type] ?? 'сообщение') }} перенесено в сделку
                                        <NuxtLink v-if="event.after_state?.data?.to_deal?.id" class="underline" :to="'/deals/' + event.after_state.data.to_deal.id">
                                            № {{ event.after_state.data.to_deal.display_id ?? event.after_state.data.to_deal.id }} «{{ event.after_state.data.to_deal.label }}»
                                        </NuxtLink>
                                    </p>
                                    <p v-else class="text-muted-800 dark:text-muted-100">Событие в истории</p>
                                </div>
                            </div>
                        </template>
                    </template>
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
                            <span>{{ task.start ? new Date(task.start).toLocaleString('ru') : '' }}</span>
                            <span class="ml-2">для {{ task.agent?.username || task.group?.name }}</span>
                            <span>{{ task.type?.name ?? 'Задача' }} - {{ task.label }}</span>
                        </p>
                    </summary>
                    <form method="post" class="flex items-center gap-2 mt-2 ml-6" @submit.prevent="onTaskClose">
                        <input type="hidden" name="action" :value="`${task.id}/close`">
                        <BaseInput name="result" :classes="{wrapper: 'w-full'}" placeholder="Итог: что сделано, о чём договорились" required />
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
import { type Deal, type DealEvent, DealEventType, type Task } from '~/types/deal';
import type { PaginatedResponse } from '~/types/generics';
import type { User } from '~/types/user';

import EventDate from './EventDate.vue';
import FileIcon from './FileIcon.vue';
import MoveEventButton from '~/components/deal/MoveEventButton.vue';
import { uploadUrl } from '~/utils/files';
import { sanitizeHtml } from '~/utils/sanitize';
import {
    CHANNELS,
    EVENT_MOVED,
    EVENT_TASK_UPDATE,
    MOVED_WHAT,
    type Channel,
    channelOf,
    dateTimeOf,
    dayKey,
    dayLabel,
    durationOf,
    eventTime,
    fieldLabel,
    fieldValue,
    isOutgoing,
    mapLink,
    mediaKind,
    messageKey,
    personName,
    stateOf,
    taskChanges,
    timeOf,
} from './feed';

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
const me = useState<User>('user');
const editingEventId = ref<number>();
const infiniteTarget = ref();
const chatAreaRef = ref();
const commentScrollRef = inject<Ref<HTMLElement>>('commentScrollRef', ref() as any);
const { runWithId: updateEventAsync, isLoadingMap } = useAsync();

const observer = useIntersectionObserver(infiniteTarget, async (entries) =>{
    const entry = entries[0];
    if (!entry.isIntersecting) return;
    props.intersected?.();
}, {root: chatAreaRef.value, immediate: false});

const fileUrl = uploadUrl;

// ------------------------------------------------------------------ the feed
type DayItem = { kind: 'day'; key: string; label: string };
type EventItem = { kind: 'event'; key: string; event: any };
type ChatItem = { kind: 'chat'; key: string; channel: Channel; events: any[] };
type FeedItem = DayItem | EventItem | ChatItem;

// a company's or a contact's feed spans several deals: each entry says which one
const showDeal = computed(() => !props.deal);

// events of the same moment: by id; a just-sent one (negative id, the newest) after them
const order = (event: any) => (event.id < 0 ? 1e15 - event.id : event.id);

/**
 * The loaded pages as one list in the order of time. Each page used to be drawn on its own
 * and the grouping of messages ran across pages with one shared position: a later run of
 * messages was appended to the first group, groups read newest-first and the feed broke
 * (TypeError) once an older page was loaded (DEAL-1, TG-2, MAIL-8).
 */
const feed = computed<FeedItem[]>(() => {
    const ids = new Set<number>();
    const messages = new Set<string>();
    const all: any[] = [];
    for (const page of props.events?.pages ?? []) {
        for (const event of page?.data ?? []) {
            if (!event || ids.has(event.id)) continue;
            ids.add(event.id);
            // one message written into several deals of the company: once
            const key = messageKey(event);
            if (key) {
                if (messages.has(key)) continue;
                messages.add(key);
            }
            all.push(event);
        }
    }
    all.sort((a, b) => eventTime(a) - eventTime(b) || order(a) - order(b));

    const items: FeedItem[] = [];
    let day = '';
    let block: ChatItem | null = null;
    for (const event of all) {
        const key = dayKey(eventTime(event));
        if (key !== day) {
            day = key;
            block = null;
            items.push({ kind: 'day', key: `day-${key}`, label: dayLabel(eventTime(event)) });
        }
        const channel = channelOf(event);
        if (!channel) {
            block = null;
            items.push({ kind: 'event', key: `event-${event.id}`, event });
            continue;
        }
        if (block && block.channel === channel && (!showDeal.value || block.events[0]?.deal?.id === event.deal?.id)) {
            block.events.push(event);
            continue;
        }
        block = { kind: 'chat', key: `chat-${event.id}`, channel, events: [event] };
        items.push(block);
    }
    return items;
});

const isEmpty = computed(() => feed.value.length === 0 && (props.events?.pages?.[0]?.count ?? 0) === 0);

/** The client of a conversation: the contact among the authors and addressees. */
function clientOf(events: any[]): string {
    for (const event of events) {
        for (const person of [event.originated_by, event.target_user]) {
            if (person?.role === 'ctr_agent') return personName(person);
        }
    }
    return '';
}

function messagesWord(n: number): string {
    const tens = n % 100;
    const units = n % 10;
    if (tens >= 11 && tens <= 14) return 'сообщений';
    if (units === 1) return 'сообщение';
    if (units >= 2 && units <= 4) return 'сообщения';
    return 'сообщений';
}

function capitalize(text: string): string {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function mailOf(event: any): Record<string, any> {
    return event?.after_state?.data ?? {};
}

function recipients(mail: Record<string, any>): string {
    return (mail.to ?? [])
        .map((r: any) => (typeof r === 'string' ? r : r?.value ?? r?.address ?? ''))
        .filter(Boolean)
        .join(', ');
}

// a letter in the feed: its text cleaned for v-html once per letter, and the first line as text
const mailCache = new Map<string, { body: string; snippet: string }>();
function mailView(mail: Record<string, any>): { body: string; snippet: string } {
    const body = String(mail?.body ?? '');
    const key = `${mail?.id ?? ''}:${body.length}:${body.slice(0, 32)}`;
    let view = mailCache.get(key);
    if (!view) {
        const clean = sanitizeHtml(body);
        const text = clean ? new DOMParser().parseFromString(clean, 'text/html').body.textContent ?? '' : '';
        view = { body: clean, snippet: text.replace(/\s+/g, ' ').trim().slice(0, 200) };
        mailCache.set(key, view);
    }
    return view;
}

/** «Удалён файл: прайс.pdf (23 нояб., 12:00)»: files taken off the deal after the entry was written. */
function removedFiles(data: any): string {
    const removed = data?.removed_files;
    if (!Array.isArray(removed) || !removed.length) return '';
    const names = removed.map((f: any) => `${f?.name || 'файл'}${f?.removed_at ? ` (${dateTimeOf(f.removed_at)})` : ''}`);
    return `${removed.length > 1 ? 'Удалены файлы' : 'Удалён файл'}: ${names.join(', ')}`;
}

/** «Перенесено из сделки № 12 (Анна)»: a message that came from another deal. */
function movedFrom(event: any): string {
    const moves = event?.after_state?.moved;
    if (!Array.isArray(moves) || !moves.length) return '';
    const last = moves[moves.length - 1];
    const from = last?.from_deal;
    const where = from ? `из сделки № ${from.display_id ?? from.id}${from.label ? ` «${from.label}»` : ''}` : 'из другой сделки';
    const who = last?.by?.username ? `, ${last.by.username}` : '';
    const when = last?.at ? `, ${dateTimeOf(last.at)}` : '';
    return `Перенесено ${where}${who}${when}`;
}

function taskTitle(task: any): string {
    if (!task) return 'Задача';
    const type = task.type?.name || 'Задача';
    return task.label ? `${type}: ${task.label}` : type;
}

function taskWho(task: any): string {
    return task?.agent?.username || task?.group?.name || '';
}

function taskMeta(task: any): string {
    if (!task) return '';
    const parts: string[] = [];
    const due = task.end_time || task.end || task.start_time || task.start;
    if (due) parts.push(`срок: ${dateTimeOf(due)}`);
    const who = taskWho(task);
    if (who) parts.push(`исполнитель: ${who}`);
    return parts.join(' · ');
}

function iconOf(event: any): string {
    switch (event.type) {
        case DealEventType.NewDeal: return 'ph:handshake';
        case DealEventType.NewCtrAgent: return 'ph:user-plus';
        case DealEventType.NewCompany: return 'ph:buildings';
        case DealEventType.NewFieldValue:
        case DealEventType.NewUpdatedFieldValue: return 'ph:pencil-simple';
        case DealEventType.NewStage: return 'ph:flag';
        case DealEventType.NewTask: return 'ph:check-square';
        case DealEventType.NewTaskStatus: return 'ph:check-circle';
        case DealEventType.NewCallRecording: return isOutgoing(event) ? 'ph:phone-outgoing' : 'ph:phone-incoming';
        case DealEventType.NewProduct: return 'ph:package';
        case DealEventType.NewSMS: return 'ph:chat-text';
        case EVENT_TASK_UPDATE: return 'ph:pencil-simple-line';
        case EVENT_MOVED: return 'ph:arrow-bend-up-right';
        default: return 'ph:info';
    }
}

function iconColorOf(event: any): string {
    switch (event.type) {
        case DealEventType.NewTask:
        case DealEventType.NewTaskStatus:
        case EVENT_TASK_UPDATE:
        case DealEventType.NewCallRecording:
            return 'text-primary-600 dark:text-primary-300';
        default:
            return 'text-muted-400 dark:text-muted-500';
    }
}

// ------------------------------------------------------------------ comments and tasks
/** Only the author edits or deletes a comment (the API refuses everybody else). */
function mayEdit(event: any): boolean {
    return !!props.deal && event.id > 0 && !!me.value?.id && event.originated_by?.id === me.value.id;
}

async function onCommentUpdate(e: Event) {
    if (!props.deal?.id) return;
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const action = formData.get('action') as string;
    const actionId = formData.get('action_id') as string;
    const result = await promiseResult(updateEventAsync(dealService.patch(action, formData).exec(), actionId));
    if (!result.ok) {
        toast.show({message: result.error.message, timeout: 3000, type: 'error'});
        return;
    }
    editingEventId.value = undefined;
}

/** Takes an event out of its page; the place it was at, to put it back if the API refuses. */
function takeEvent(id: number): { page: PaginatedResponse<DealEvent>; index: number; event: DealEvent } | null {
    for (const page of props.events.pages) {
        const index = page?.data?.findIndex((e) => e.id === id) ?? -1;
        if (index !== -1) return { page, index, event: page.data.splice(index, 1)[0] };
    }
    return null;
}

async function onCommentDelete(event: any) {
    if (!props.deal?.id) return;
    const action = `${props.deal.id}/comments/${event.id}`;
    const taken = takeEvent(event.id);
    const result = await promiseResult(updateEventAsync(dealService.remove(action).exec(), `delete/${action}`));
    if (!result.ok) {
        toast.show({message: result.error.message, timeout: 3000, type: 'error'});
        if (taken) taken.page.data.splice(taken.index, 0, taken.event);
    }
}

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
