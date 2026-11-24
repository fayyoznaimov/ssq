<template>
    <!--
        The history of a deal, a company or a contact as a conversation (DEAL-9, DEAL-10, TG-12, WA-5, MAIL-12,
        AUDIT-9): oldest at the top and the newest next to the composer, a separator per day, messages of the
        client on the left and of the manager on the right, calls in one line with a player, what the CRM did
        (stages, fields, tasks) in small grey lines, long runs of them folded.
        The card takes the height its parent gives it (the deal page: the screen next to the form) and scrolls
        by itself; the filters and the planned tasks stay above the scrolled part, so nothing covers the feed.
    -->
    <BaseCard :class="['relative flex min-h-0 flex-col overflow-hidden', classes?.wrapper ?? 'h-[75vh] min-h-[22rem] lg:h-auto lg:flex-1']" rounded="md">
        <slot name="header" />
        <HistoryToolbar
            v-if="filters"
            :model-value="filters"
            :scope="scope"
            :client-deals="clientDeals"
            @update:model-value="emits('update:filters', $event)"
            @update:scope="emits('update:scope', $event)"
        />
        <PlannedTasks v-if="openTasks.length" :tasks="openTasks" @changed="emits('task-closed')" />
        <div ref="chatAreaRef" class="relative min-h-0 flex-1 overflow-y-auto overscroll-contain" @scroll.passive="onScroll">
            <div class="mx-auto flex w-full max-w-4xl flex-col px-3 pb-6 pt-3 sm:px-5">
                <div v-if="eventsLoading && !feed.length" class="w-full py-6 text-center text-sm text-muted-500 dark:text-muted-300">Загрузка...</div>
                <div v-else-if="isEmpty" class="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-500 dark:text-muted-400">
                    <Icon :name="filtering ? 'ph:magnifying-glass' : 'ph:clock-counter-clockwise'" class="size-8 text-muted-300 dark:text-muted-600" />
                    <p v-if="filtering">Ничего не найдено. Выберите «Всё» или другие слова поиска.</p>
                    <p v-else>{{ deal ? 'Здесь появится история сделки: сообщения, звонки, письма, задачи и заметки' : 'Здесь появятся звонки, письма, сообщения, задачи и заметки по клиенту' }}</p>
                </div>
                <div ref="infiniteTarget"></div>
                <div v-if="eventsLoading && feed.length" class="py-2 text-center text-xs text-muted-500 dark:text-muted-400">Загрузка более ранних событий...</div>
                <ul ref="listRef" class="flex flex-col break-words text-[15px] leading-relaxed text-muted-700 dark:text-muted-200">
                    <li v-for="item in feed" :key="item.key">
                        <!-- ============================== the day -->
                        <div v-if="item.kind === 'day'" data-feed="day" class="my-3 flex items-center gap-3 text-xs text-muted-500 dark:text-muted-400">
                            <span class="h-px flex-1 bg-muted-200 dark:bg-muted-700"></span>
                            <span class="rounded-full bg-muted-100 px-3 py-0.5 font-medium dark:bg-muted-700/70">{{ item.label }}</span>
                            <span class="h-px flex-1 bg-muted-200 dark:bg-muted-700"></span>
                        </div>

                        <!-- ============================== a conversation: Telegram, WhatsApp, e-mail -->
                        <div v-else-if="item.kind === 'chat'" class="mb-3 flex flex-col gap-1.5">
                            <p v-if="dealOf(item.events[0])" class="text-xs text-muted-500 dark:text-muted-400">
                                <NuxtLink :to="'/deals/' + dealOf(item.events[0]).id" class="underline hover:text-primary-600 dark:hover:text-primary-300">
                                    № {{ dealOf(item.events[0]).display_id ?? dealOf(item.events[0]).id }} {{ dealOf(item.events[0]).label }}
                                </NuxtLink>
                            </p>
                            <div v-for="(e, ei) in item.events" :key="e.id" class="flex" :class="isOutgoing(e) ? 'justify-end' : 'justify-start'">
                                <!-- a letter: folded to its subject and first line, its own text when opened, the quote on demand -->
                                <div v-if="e.type === DealEventType.NewEmail" class="w-full min-w-0 max-w-[94%] sm:max-w-[85%]">
                                    <div v-if="e.after_state?.hidden" class="flex items-center gap-2 rounded-xl border border-dashed border-muted-300 p-2.5 text-[13px] dark:border-muted-600">
                                        <Icon name="ph:envelope-simple" class="size-5 shrink-0" />
                                        <span>{{ timeOf(e.created_at) }} · {{ isOutgoing(e) ? 'Исходящее письмо' : 'Входящее письмо' }} — нет доступа к почте</span>
                                    </div>
                                    <details
                                        v-else
                                        class="group rounded-2xl border border-muted-200 dark:border-muted-600"
                                        :class="isOutgoing(e) ? 'rounded-br-md bg-primary-500/5 dark:bg-primary-500/10' : 'rounded-bl-md bg-white dark:bg-muted-800/60'"
                                        @toggle="onMailToggle(e, $event)"
                                    >
                                        <summary class="flex cursor-pointer list-none gap-2 p-3">
                                            <div class="min-w-0 flex-1">
                                                <p class="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-500 dark:text-muted-400">
                                                    <Icon :name="CHANNELS.email.icon" class="size-3.5" :class="CHANNELS.email.color" />
                                                    <span class="font-medium text-muted-700 dark:text-muted-200">{{ mailOf(e).from || personName(e.originated_by) }}</span>
                                                    <span v-if="recipients(mailOf(e))" class="break-all">→ {{ recipients(mailOf(e)) }}</span>
                                                    <span :title="dateTimeOf(mailOf(e).sent_at || e.created_at)">{{ timeOf(mailOf(e).sent_at || e.created_at) }}</span>
                                                    <MoveEventButton v-if="canMove(e)" :event="e" :deal-id="deal!.id" @moved="removeEvent(e.id)" @click.stop.prevent />
                                                </p>
                                                <p class="mt-0.5 font-medium text-muted-900 dark:text-white">{{ mailOf(e).subject || '(без темы)' }}</p>
                                                <p class="line-clamp-2 text-[14px] text-muted-600 group-open:hidden dark:text-muted-300">{{ mailParts(e).snippet }}</p>
                                            </div>
                                            <Icon name="ph:caret-down" class="mt-1 size-4 shrink-0 text-muted-400 transition-transform group-open:rotate-180" />
                                        </summary>
                                        <div class="flex flex-col px-3 pb-3">
                                            <div v-if="mailParts(e).html" class="mail-body max-w-none break-words text-muted-900 dark:text-white" v-html="mailParts(e).main"></div>
                                            <p v-else class="whitespace-pre-line break-words text-muted-900 dark:text-white">{{ mailParts(e).main }}</p>
                                            <template v-if="mailParts(e).quote">
                                                <button type="button" class="mt-2 self-start text-xs text-primary-600 underline dark:text-primary-300" @click="quotes[e.id] = !quotes[e.id]">
                                                    {{ quotes[e.id] ? 'Скрыть цитату' : 'Показать цитату' }}
                                                </button>
                                                <div v-if="quotes[e.id]" class="mt-1 border-s-2 border-muted-300 ps-3 text-[14px] text-muted-500 dark:border-muted-600 dark:text-muted-400">
                                                    <div v-if="mailParts(e).html" class="mail-body break-words" v-html="mailParts(e).quote"></div>
                                                    <p v-else class="whitespace-pre-line break-words">{{ mailParts(e).quote }}</p>
                                                </div>
                                            </template>
                                            <p v-else-if="mailOf(e).quoted" class="mt-2 text-xs text-muted-500 dark:text-muted-400">Предыдущие письма переписки — отдельными записями истории и в разделе «Почта».</p>
                                            <ul v-if="mailOf(e).files?.length" class="flex flex-wrap items-center gap-2 pt-3">
                                                <li v-for="file of mailOf(e).files" :key="file.id ?? file.path">
                                                    <a v-if="mediaKind(file) === 'image'" :href="fileUrl(file.path)" target="_blank" rel="noopener">
                                                        <img :src="fileUrl(file.path)" :alt="file.name" class="h-24 max-w-[10rem] rounded-md object-cover" loading="lazy" />
                                                    </a>
                                                    <a v-else :href="fileUrl(file.path)" target="_blank" rel="noopener" class="inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-muted-200 bg-muted-50 px-3 py-1 text-[13px] dark:border-muted-600 dark:bg-muted-800">
                                                        <FileIcon :file-name="file.name" class="size-4 shrink-0" />
                                                        <span class="truncate text-muted-900 dark:text-white">{{ file.name }}</span>
                                                    </a>
                                                </li>
                                            </ul>
                                            <p v-if="removedFiles(mailOf(e))" class="mt-1 text-xs text-muted-500 dark:text-muted-400">{{ removedFiles(mailOf(e)) }}</p>
                                            <p v-if="movedFrom(e)" class="mt-1 text-xs text-muted-500 dark:text-muted-400">{{ movedFrom(e) }}</p>
                                        </div>
                                    </details>
                                </div>

                                <!-- a message or a call in a messenger: a bubble with the channel, the author and the time -->
                                <div
                                    v-else
                                    class="min-w-0 max-w-[88%] rounded-2xl px-3.5 py-2 sm:max-w-[78%]"
                                    :class="isOutgoing(e) ? 'rounded-br-md bg-primary-500/10 dark:bg-primary-500/20' : 'rounded-bl-md bg-muted-100 dark:bg-muted-700/60'"
                                >
                                    <p class="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-500 dark:text-muted-400">
                                        <Icon :name="CHANNELS[item.channel].icon" class="size-3.5" :class="CHANNELS[item.channel].color" />
                                        <span v-if="showAuthor(item.events, ei)" class="font-medium text-muted-700 dark:text-muted-200" :title="e.originated_by?.deleted_at ? 'Учётная запись удалена' : undefined">{{ personName(e.originated_by) }}</span>
                                        <span v-if="isOutgoing(e) && e.target_user && showAuthor(item.events, ei)">→ {{ personName(e.target_user) }}</span>
                                        <span :title="dateTimeOf(e.created_at)">{{ timeOf(e.created_at) }}</span>
                                        <span v-if="stateOf(e).edited" :title="stateOf(e).original_message ? 'было: ' + stateOf(e).original_message : undefined">(изменено)</span>
                                        <MoveEventButton v-if="canMove(e) && e.type !== DealEventType.NewTelegramCall" :event="e" :deal-id="deal!.id" @moved="removeEvent(e.id)" />
                                    </p>
                                    <template v-if="e.type === DealEventType.NewTelegramCall">
                                        <p class="mt-0.5 flex items-center gap-1 text-muted-800 dark:text-muted-100">
                                            <Icon :name="isOutgoing(e) ? 'ph:phone-outgoing' : 'ph:phone-incoming'" class="size-4" />
                                            {{ isOutgoing(e) ? 'Исходящий звонок' : 'Входящий звонок' }} в Telegram<template v-if="durationOf(e.duration)"> · {{ durationOf(e.duration) }}</template>
                                        </p>
                                        <CallPlayer v-if="e.after_state?.path" class="mt-1" :src="fileUrl(e.after_state.path)" :duration-ms="e.duration" />
                                    </template>
                                    <template v-else>
                                        <p v-if="stateOf(e).message" class="mt-0.5 whitespace-pre-line break-words text-muted-900 dark:text-muted-50">{{ stateOf(e).message }}</p>
                                        <ul v-if="stateOf(e).files?.length" class="mt-1 flex flex-col gap-1.5">
                                            <li v-for="(file, fi) of stateOf(e).files" :key="fi">
                                                <CallPlayer v-if="mediaKind(file) === 'audio'" :src="file.url || fileUrl(file.path)" :duration-ms="file.duration ? Number(file.duration) * 1000 : null" />
                                                <a v-else-if="mediaKind(file) === 'image'" :href="file.url || fileUrl(file.path)" target="_blank" rel="noopener" class="inline-block">
                                                    <img :src="file.url || fileUrl(file.path)" :alt="file.name" class="max-h-56 max-w-full rounded-lg" loading="lazy" />
                                                </a>
                                                <video v-else-if="mediaKind(file) === 'video'" controls preload="metadata" class="max-h-56 max-w-full rounded-lg" :src="file.url || fileUrl(file.path)"></video>
                                                <a v-else class="inline-flex max-w-full items-center gap-1.5 rounded-full border border-muted-200 bg-white px-3 py-1 text-[13px] text-primary-700 dark:border-muted-600 dark:bg-muted-800 dark:text-primary-200" target="_blank" rel="noopener" :href="file.url || fileUrl(file.path)">
                                                    <FileIcon :file-name="file.name || ''" class="size-4 shrink-0" /><span class="truncate">{{ file.name || 'Файл' }}</span>
                                                </a>
                                                <p v-if="file.caption && file.caption !== stateOf(e).message" class="whitespace-pre-line text-[14px]">{{ file.caption }}</p>
                                            </li>
                                        </ul>
                                        <a v-if="mapLink(stateOf(e).location)" :href="mapLink(stateOf(e).location) ?? undefined" target="_blank" rel="noopener noreferrer" class="mt-1 inline-flex items-center gap-1 text-primary-600 underline dark:text-primary-300">
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
                            </div>
                        </div>

                        <!-- ============================== what the CRM and the people did: small grey lines, a long run folded -->
                        <ul v-else-if="item.kind === 'system'" class="mb-3 flex flex-col gap-0.5">
                            <li v-if="item.events.length > SYSTEM_SHOWN && !expanded[item.key]">
                                <button type="button" class="ms-6 text-xs text-primary-600 underline dark:text-primary-300" @click="expanded[item.key] = true">
                                    Показать ещё {{ item.events.length - SYSTEM_SHOWN }} {{ eventsWord(item.events.length - SYSTEM_SHOWN) }}
                                </button>
                            </li>
                            <li
                                v-for="event in (item.events.length > SYSTEM_SHOWN && !expanded[item.key] ? item.events.slice(-SYSTEM_SHOWN) : item.events)"
                                :key="'s' + event.id"
                                class="flex items-start gap-2 text-[13px] leading-5 text-muted-500 dark:text-muted-400"
                            >
                                <Icon :name="iconOf(event)" class="mt-0.5 size-4 shrink-0" :class="iconColorOf(event)" />
                                <div class="min-w-0 flex-1">
                                    <span class="tabular-nums" :title="dateTimeOf(event.created_at)">{{ timeOf(event.created_at) }}</span>
                                    <span class="mx-1">·</span>
                                    <span class="font-medium text-muted-600 dark:text-muted-300">{{ whoOf(event) }}</span>
                                    <span class="mx-1">·</span>
                                    <template v-if="event.type === DealEventType.NewDeal">
                                        Сделка создана: <NuxtLink class="underline" :to="'/deals/' + (event.after_state?.data?.id ?? event.deal?.id)">{{ event.after_state?.data?.label || 'без названия' }}</NuxtLink>
                                    </template>
                                    <template v-else-if="event.type === DealEventType.NewCtrAgent">
                                        Контакт добавлен в сделку: <NuxtLink class="underline" :to="'/lists/contacts/' + event.after_state?.data?.id">{{ event.after_state?.data?.username }}</NuxtLink>
                                    </template>
                                    <template v-else-if="event.type === DealEventType.NewCompany">
                                        Компания добавлена в сделку: <NuxtLink class="underline" :to="'/lists/companies/' + event.after_state?.data?.id">{{ event.after_state?.data?.name }}</NuxtLink>
                                    </template>
                                    <template v-else-if="event.type === DealEventType.NewFieldValue || event.type === DealEventType.NewUpdatedFieldValue">
                                        {{ fieldLabel(event.after_state?.data?.field, event.field_of, event.after_state?.data?.subject) }}:
                                        <template v-if="event.type === DealEventType.NewUpdatedFieldValue">
                                            <span class="line-through decoration-muted-400/60">{{ fieldValue(event.after_state?.data?.field, event.after_state?.data?.old_value, event.after_state?.data?.old_label) }}</span> →
                                        </template>
                                        <span class="font-medium text-muted-700 dark:text-muted-200">{{ fieldValue(event.after_state?.data?.field, event.after_state?.data?.new_value, event.after_state?.data?.new_label) }}</span>
                                    </template>
                                    <template v-else-if="event.type === DealEventType.NewStage">
                                        Этап:
                                        <template v-if="event.before_state?.data?.stage?.name">
                                            <StageName :name="event.before_state.data.stage.name" :color="event.before_state.data.stage.color" /> →
                                        </template>
                                        <StageName :name="event.after_state?.data?.stage?.name ?? '—'" :color="event.after_state?.data?.stage?.color" />
                                    </template>
                                    <template v-else-if="event.type === DealEventType.NewTask">
                                        Задача поставлена: <span class="font-medium text-muted-700 dark:text-muted-200">«{{ taskTitle(event.after_state?.data) }}»</span>
                                        <template v-if="taskMeta(event.after_state?.data)"> · {{ taskMeta(event.after_state?.data) }}</template>
                                        <template v-if="event.after_state?.data?.via === 'bot'"> · через Telegram-бот</template>
                                    </template>
                                    <template v-else-if="event.type === EVENT_TASK_UPDATE">
                                        Задача изменена: <span class="font-medium text-muted-700 dark:text-muted-200">«{{ taskTitle(event.after_state?.data) }}»</span><template v-if="taskChanges(event.before_state?.data, event.after_state?.data).length">: {{ taskChanges(event.before_state?.data, event.after_state?.data).join('; ') }}</template>
                                        <template v-if="event.after_state?.data?.via === 'bot'"> · через Telegram-бот</template>
                                    </template>
                                    <template v-else-if="event.type === DealEventType.NewTaskStatus">
                                        Задача выполнена: <span class="font-medium text-muted-700 dark:text-muted-200">«{{ taskTitle(event.after_state?.data) }}»</span>
                                        <template v-if="taskWho(event.after_state?.data)"> · исполнитель: {{ taskWho(event.after_state?.data) }}</template>
                                        <template v-if="event.after_state?.data?.via === 'bot'"> · через Telegram-бот</template>
                                        <!-- a task closed without a result had an empty «Итог:» -->
                                        <span v-if="resultOf(event)" class="mt-0.5 block whitespace-pre-line text-[14px] text-muted-700 dark:text-muted-200">Итог: {{ resultOf(event) }}</span>
                                    </template>
                                    <template v-else-if="event.type === DealEventType.NewProduct">
                                        Товар добавлен: <span class="font-medium text-muted-700 dark:text-muted-200">{{ event.after_state?.data?.product?.name ?? 'товар' }}</span>
                                        <template v-if="event.after_state?.data?.quantity"> — {{ event.after_state.data.quantity }} × {{ fieldValue('price', event.after_state.data.price) }}</template>
                                    </template>
                                    <template v-else-if="event.type === EVENT_MOVED">
                                        {{ capitalize(MOVED_WHAT[event.after_state?.data?.type] ?? 'сообщение') }} перенесено в сделку
                                        <NuxtLink v-if="event.after_state?.data?.to_deal?.id" class="underline" :to="'/deals/' + event.after_state.data.to_deal.id">
                                            № {{ event.after_state.data.to_deal.display_id ?? event.after_state.data.to_deal.id }} «{{ event.after_state.data.to_deal.label }}»
                                        </NuxtLink>
                                    </template>
                                    <template v-else>Событие в истории</template>
                                    <NuxtLink v-if="dealOf(event)" :to="'/deals/' + dealOf(event).id" class="ms-1.5 whitespace-nowrap underline hover:text-primary-600 dark:hover:text-primary-300">№ {{ dealOf(event).display_id ?? dealOf(event).id }}</NuxtLink>
                                    <NuxtLink v-else-if="showDealChips && event.contact?.id" :to="'/lists/contacts/' + event.contact.id" class="ms-1.5 underline hover:text-primary-600 dark:hover:text-primary-300">{{ personName(event.contact) }}</NuxtLink>
                                </div>
                            </li>
                        </ul>

                        <!-- ============================== one event of the conversation -->
                        <template v-else-if="item.kind === 'event'">
                            <template v-for="event in [item.event]" :key="'e' + event.id">
                                <!-- a call: one line with the direction, the length and a player -->
                                <div v-if="event.type === DealEventType.NewCallRecording" class="mb-3 flex" :class="isOutgoing(event) ? 'justify-end' : 'justify-start'">
                                    <div class="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1.5 rounded-2xl border border-muted-200 px-3 py-2 text-[14px] dark:border-muted-700 sm:max-w-[85%]">
                                        <Icon :name="isOutgoing(event) ? 'ph:phone-outgoing' : 'ph:phone-incoming'" class="size-5 shrink-0 text-primary-600 dark:text-primary-300" />
                                        <span class="font-medium text-muted-800 dark:text-muted-100">{{ isOutgoing(event) ? 'Исходящий звонок' : 'Входящий звонок' }}</span>
                                        <span v-if="durationOf(event.duration)" class="tabular-nums">· {{ durationOf(event.duration) }}</span>
                                        <span class="text-xs text-muted-500 dark:text-muted-400">
                                            <span :title="dateTimeOf(event.created_at)">{{ timeOf(event.created_at) }}</span>
                                            <template v-if="event.target_user || event.target_group"> · {{ event.target_group?.name ?? personName(event.target_user) }}</template>
                                            <template v-else-if="event.originated_by"> · {{ personName(event.originated_by) }}</template>
                                            <template v-if="event.after_state?.number"> · {{ event.after_state.number }}</template>
                                        </span>
                                        <NuxtLink v-if="dealOf(event)" :to="'/deals/' + dealOf(event).id" class="text-xs underline hover:text-primary-600 dark:hover:text-primary-300">№ {{ dealOf(event).display_id ?? dealOf(event).id }}</NuxtLink>
                                        <CallPlayer class="basis-full" :src="event.after_state?.path ? fileUrl(event.after_state.path) : ''" :duration-ms="event.duration" />
                                    </div>
                                </div>

                                <!-- a note: the text in full lines, the editor only while it is edited -->
                                <div v-else-if="event.type === DealEventType.NewComment" class="mb-3 rounded-xl border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
                                    <div class="flex items-start gap-2.5">
                                        <Icon name="ph:note-pencil" class="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
                                        <div class="flex w-full min-w-0 flex-col">
                                            <p class="text-xs text-muted-500 dark:text-muted-400">
                                                <EventDate :event="event" />
                                                <span class="ml-2">{{ event.deal || deal ? 'примечание' : 'заметка' }}</span>
                                                <span v-if="event.after_state?.data?.edited_at" class="ml-2" :title="'изменено ' + dateTimeOf(event.after_state.data.edited_at)">(изменено)</span>
                                                <NuxtLink v-if="dealOf(event)" :to="'/deals/' + dealOf(event).id" class="ml-2 underline hover:text-primary-600 dark:hover:text-primary-300">№ {{ dealOf(event).display_id ?? dealOf(event).id }} {{ dealOf(event).label }}</NuxtLink>
                                                <NuxtLink v-else-if="showDealChips && event.contact?.id" :to="'/lists/contacts/' + event.contact.id" class="ml-2 underline hover:text-primary-600 dark:hover:text-primary-300">{{ personName(event.contact) }}</NuxtLink>
                                            </p>
                                            <form v-if="editingEventId === event.id" class="mt-1 flex flex-col gap-2" @submit.prevent="onCommentSave(event)">
                                                <BaseTextarea v-model="draft" name="comment" :rows="3" autogrow class="w-full" />
                                                <div class="flex flex-wrap gap-2">
                                                    <BaseButton size="sm" type="submit" color="primary" :disabled="draft.trim().length < 2 || isLoadingMap[`patch/${event.id}`]" :loading="isLoadingMap[`patch/${event.id}`]">Сохранить</BaseButton>
                                                    <BaseButton size="sm" @click="editingEventId = undefined">Отмена</BaseButton>
                                                    <BaseButton size="sm" color="danger" :disabled="isLoadingMap[`delete/${event.id}`]" :loading="isLoadingMap[`delete/${event.id}`]" @click="onCommentDelete(event)">Удалить</BaseButton>
                                                </div>
                                            </form>
                                            <template v-else>
                                                <p
                                                    v-if="event.after_state?.data?.comment"
                                                    class="mt-1 whitespace-pre-line break-words text-muted-900 dark:text-muted-50"
                                                    :class="{ 'line-clamp-6': isLongText(event.after_state.data.comment) && !expanded[event.id] }"
                                                >{{ event.after_state.data.comment }}</p>
                                                <p v-if="isLongText(event.after_state?.data?.comment) || mayEdit(event)" class="mt-1 flex gap-3 text-xs">
                                                    <button v-if="isLongText(event.after_state?.data?.comment)" type="button" class="underline text-primary-600 dark:text-primary-300" @click="expanded[event.id] = !expanded[event.id]">
                                                        {{ expanded[event.id] ? 'Свернуть' : 'Показать полностью' }}
                                                    </button>
                                                    <button v-if="mayEdit(event)" type="button" class="underline text-muted-500 hover:text-primary-600 dark:text-muted-400 dark:hover:text-primary-300" @click="startEdit(event)">Изменить</button>
                                                </p>
                                            </template>
                                            <!-- the files of a note: seen without opening it, pictures as pictures -->
                                            <ul v-if="event.after_state?.data?.files?.length > 0" class="flex flex-wrap gap-2 py-2">
                                                <li v-for="file of event.after_state.data.files" :key="file.id ?? file.path ?? file.url">
                                                    <a v-if="mediaKind(file) === 'image'" :href="file.url || fileUrl(file.path)" target="_blank" rel="noopener">
                                                        <img :src="file.url || fileUrl(file.path)" :alt="file.name" class="max-h-40 max-w-full rounded-md" loading="lazy" />
                                                    </a>
                                                    <CallPlayer v-else-if="mediaKind(file) === 'audio'" :src="file.url || fileUrl(file.path)" />
                                                    <a v-else class="inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-muted-200 bg-white px-3 py-1 text-[13px] text-primary-700 dark:border-muted-600 dark:bg-muted-800 dark:text-primary-200" target="_blank" rel="noopener" :href="file.url || fileUrl(file.path)">
                                                        <FileIcon :file-name="file.name || ''" class="size-4 shrink-0" /><span class="truncate">{{ file.name }}</span>
                                                    </a>
                                                </li>
                                            </ul>
                                            <p v-if="removedFiles(event.after_state?.data)" class="text-xs text-muted-500 dark:text-muted-400">{{ removedFiles(event.after_state?.data) }}</p>
                                        </div>
                                    </div>
                                </div>

                                <!-- an inner chat message between employees -->
                                <div v-else-if="event.type === DealEventType.NewChatMessage" class="mb-3 flex items-start gap-3">
                                    <BaseAvatar
                                        :text="event.originated_by?.username?.[0] ?? '?'"
                                        :src="event.originated_by?.avatar ? fileUrl(event.originated_by.avatar) : undefined"
                                        size="xs"
                                        class="shrink-0 bg-primary-400 text-white"
                                    />
                                    <div class="flex w-full min-w-0 flex-col rounded-2xl rounded-tl-md border border-dashed border-muted-300 px-3 py-2 dark:border-muted-600">
                                        <p class="text-xs text-muted-500 dark:text-muted-400 space-x-2">
                                            <EventDate :event="event" />
                                            <span>внутренний чат →</span>
                                            <span v-if="event.target_group">{{ event.target_group.name }}</span>
                                            <span v-else-if="event.target_user">{{ personName(event.target_user) }}</span>
                                            <span v-else>всем</span>
                                            <NuxtLink v-if="dealOf(event)" :to="'/deals/' + dealOf(event).id" class="underline hover:text-primary-600 dark:hover:text-primary-300">№ {{ dealOf(event).display_id ?? dealOf(event).id }} {{ dealOf(event).label }}</NuxtLink>
                                        </p>
                                        <p class="mt-0.5 whitespace-pre-line break-words text-muted-900 dark:text-muted-50">{{ event.after_state?.data?.message }}</p>
                                        <ul v-if="event.after_state?.data?.files?.length > 0" class="flex flex-wrap gap-2 py-2">
                                            <li v-for="(file, fi) of event.after_state.data.files" :key="fi">
                                                <CallPlayer v-if="file.type === 'voice'" :src="file.url || fileUrl(file.path)" />
                                                <a v-else class="underline text-primary-600 dark:text-primary-200" target="_blank" rel="noopener" :href="file.url || fileUrl(file.path)">{{ file.name }}</a>
                                            </li>
                                        </ul>
                                        <p v-if="removedFiles(event.after_state?.data)" class="text-xs text-muted-500 dark:text-muted-400">{{ removedFiles(event.after_state?.data) }}</p>
                                    </div>
                                </div>

                                <!-- an SMS -->
                                <div v-else class="mb-3 flex items-start gap-2 text-[14px]">
                                    <Icon name="ph:chat-text" class="mt-1 size-4 shrink-0 text-muted-400" />
                                    <div class="min-w-0">
                                        <p class="text-xs text-muted-500 dark:text-muted-400"><EventDate :event="event" /></p>
                                        <p class="whitespace-pre-line text-muted-800 dark:text-muted-100">SMS: {{ event.after_state?.data?.message ?? event.after_state?.data?.text ?? event.after_state?.message ?? '' }}</p>
                                    </div>
                                </div>
                            </template>
                        </template>
                    </li>
                </ul>
                <div ref="commentScrollRef"></div>
            </div>
        </div>
        <!-- scrolled up: back to the newest in one click -->
        <button
            v-if="awayFromNewest"
            type="button"
            class="absolute bottom-3 end-3 z-10 inline-flex items-center gap-1 rounded-full bg-primary-500 px-3 py-1.5 text-xs font-medium text-white shadow-lg hover:bg-primary-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
            @click="toNewest"
        >
            <Icon name="ph:arrow-down" class="size-4" />К последнему сообщению
        </button>
    </BaseCard>
</template>

<script lang="ts" setup>
import BaseButton from '~/components/base/BaseButton.vue';
import BaseTextarea from '~/components/form/BaseTextarea.vue';
import { useIntersectionObserver } from '~/composables/useIntersectionObserver';
import { type Deal, type DealEvent, DealEventType, type Task } from '~/types/deal';
import type { PaginatedResponse } from '~/types/generics';
import type { User } from '~/types/user';

import EventDate from './EventDate.vue';
import FileIcon from './FileIcon.vue';
import MoveEventButton from '~/components/deal/MoveEventButton.vue';
import CallPlayer from '~/components/history/CallPlayer.vue';
import HistoryToolbar from '~/components/history/HistoryToolbar.vue';
import PlannedTasks from '~/components/history/PlannedTasks.vue';
import StageName from '~/components/history/StageName.vue';
import { type HistoryFilters, filtersActive } from '~/components/history/history';
import { taskWhen } from '~/components/task/taskText';
import { uploadUrl } from '~/utils/files';
import { letterSnippet, letterView } from '~/utils/mailView';
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
    isEmptyNote,
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
    tasks?: Task[];
    classes?: {
        wrapper?: string | string[]
    },
    // the filters and the search on top (v-model:filters); not given: no toolbar
    filters?: HistoryFilters | null;
    // the deal page: «Эта сделка / Весь клиент» (v-model:scope), shown when the client has other deals
    scope?: 'deal' | 'client';
    clientDeals?: number;
    // which deal an entry is of; by default in the feeds of several deals (no `deal`)
    showDeal?: boolean;
}>(), {
    events: () => ({pages: []}),
    startObserver: false,
    tasks: () => [],
    filters: null,
    scope: 'deal',
    clientDeals: 0,
    showDeal: undefined,
});

const emits = defineEmits<{
    (e: 'task-closed'): void;
    (e: 'update:filters', value: HistoryFilters): void;
    (e: 'update:scope', value: 'deal' | 'client'): void;
}>();

// a message moved to another deal leaves this deal's history
function removeEvent(id: number) {
    for (const page of props.events.pages) {
        if (page?.data) page.data = page.data.filter((e) => e.id !== id);
    }
}
const toast = useToast('GlobalToast');
const dealService = useService('deals', { auth: true });
const companyService = useService('companies', { auth: true });
const userService = useService('users', { auth: true });
const me = useState<User>('user');
const editingEventId = ref<number>();
const infiniteTarget = ref();
const chatAreaRef = ref<HTMLElement>();
const listRef = ref<HTMLElement>();
const commentScrollRef = inject<Ref<HTMLElement>>('commentScrollRef', ref() as any);
const { runWithId: updateEventAsync, isLoadingMap } = useAsync();

const observer = useIntersectionObserver(infiniteTarget, async (entries) =>{
    const entry = entries[0];
    if (!entry.isIntersecting) return;
    props.intersected?.();
}, {root: chatAreaRef.value, immediate: false});

const fileUrl = uploadUrl;
const filtering = computed(() => filtersActive(props.filters));
const openTasks = computed(() => (props.tasks ?? []).filter((task) => !task.closed_at));

// ------------------------------------------------------------------ the feed
type DayItem = { kind: 'day'; key: string; label: string };
type EventItem = { kind: 'event'; key: string; event: any };
type ChatItem = { kind: 'chat'; key: string; channel: Channel; events: any[] };
type SystemItem = { kind: 'system'; key: string; events: any[] };
type FeedItem = DayItem | EventItem | ChatItem | SystemItem;

// a company's or a contact's feed spans several deals (and the deal page's «Весь клиент»): each entry says which one
const showDealChips = computed(() => props.showDeal ?? !props.deal);

/** The deal an entry is of, when the feed spans several — not for the entries of the open deal itself. */
function dealOf(event: any): any {
    if (!showDealChips.value || !event?.deal?.id) return null;
    if (props.deal?.id && event.deal.id === props.deal.id) return null;
    return event.deal;
}

/** Moving to another deal: only an entry of the open deal (not one of the client's other deals). */
function canMove(event: any): boolean {
    return !!props.deal?.id && event.id > 0 && (!event.deal?.id || event.deal.id === props.deal.id);
}

// what the CRM did and the people changed: a small grey line; the conversation (messages, calls, notes) is not
const SYSTEM_TYPES = new Set<number>([
    DealEventType.NewDeal,
    DealEventType.NewCtrAgent,
    DealEventType.NewCompany,
    DealEventType.NewFieldValue,
    DealEventType.NewUpdatedFieldValue,
    DealEventType.NewStage,
    DealEventType.NewTask,
    DealEventType.NewTaskStatus,
    DealEventType.NewProduct,
    EVENT_TASK_UPDATE,
    EVENT_MOVED,
]);
const CONVERSATION_TYPES = new Set<number>([
    DealEventType.NewComment,
    DealEventType.NewChatMessage,
    DealEventType.NewCallRecording,
    DealEventType.NewSMS,
]);
const isSystem = (event: any) => SYSTEM_TYPES.has(event?.type) || !CONVERSATION_TYPES.has(event?.type);
// a run of more grey lines than this is folded to its last ones
const SYSTEM_SHOWN = 3;

// events of the same moment: by id; a just-sent one (negative id, the newest) after them
const order = (event: any) => (event.id < 0 ? 1e15 - event.id : event.id);

/**
 * The loaded pages as one list in the order of time, a day separator, messages of one channel in a row as
 * one block, grey lines in a row as one (foldable) run. Each page used to be drawn on its own (DEAL-1).
 */
const feed = computed<FeedItem[]>(() => {
    const ids = new Set<number>();
    const messages = new Set<string>();
    const all: any[] = [];
    for (const page of props.events?.pages ?? []) {
        for (const event of page?.data ?? []) {
            if (!event || ids.has(event.id)) continue;
            ids.add(event.id);
            // a note without text and files was an empty dark bar
            if (isEmptyNote(event)) continue;
            // one message written into several deals of the client: once
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
    let run: SystemItem | null = null;
    for (const event of all) {
        const key = dayKey(eventTime(event));
        if (key !== day) {
            day = key;
            block = null;
            run = null;
            items.push({ kind: 'day', key: `day-${key}`, label: dayLabel(eventTime(event)) });
        }
        const channel = channelOf(event);
        if (channel) {
            run = null;
            if (block && block.channel === channel && (!showDealChips.value || block.events[0]?.deal?.id === event.deal?.id)) {
                block.events.push(event);
                continue;
            }
            block = { kind: 'chat', key: `chat-${event.id}`, channel, events: [event] };
            items.push(block);
            continue;
        }
        block = null;
        if (isSystem(event)) {
            if (run) {
                run.events.push(event);
                continue;
            }
            // the key of a run is its first event: a run that grows keeps its folding state
            run = { kind: 'system', key: `system-${event.id}`, events: [event] };
            items.push(run);
            continue;
        }
        run = null;
        items.push({ kind: 'event', key: `event-${event.id}`, event });
    }
    return items;
});

const isEmpty = computed(() => feed.value.length === 0 && !props.eventsLoading && (props.events?.pages?.[0]?.count ?? 0) === 0);

/** The author over a bubble: the first of a run of messages of one person. */
function showAuthor(events: any[], index: number): boolean {
    if (index === 0) return true;
    const prev = events[index - 1];
    const cur = events[index];
    return (prev?.originated_by?.id ?? null) !== (cur?.originated_by?.id ?? null) || isOutgoing(prev) !== isOutgoing(cur);
}

/** Who did it: a person, else the CRM itself (a trigger, the autopilot, a channel). */
function whoOf(event: any): string {
    return event?.originated_by ? personName(event.originated_by) : 'Автоматически';
}

function capitalize(text: string): string {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function eventsWord(n: number): string {
    const tens = n % 100;
    const units = n % 10;
    if (tens >= 11 && tens <= 14) return 'событий';
    if (units === 1) return 'событие';
    if (units >= 2 && units <= 4) return 'события';
    return 'событий';
}

/** The result of a closed task, when there is one (a result of spaces showed as an empty «Итог:»). */
function resultOf(event: any): string {
    const result = event?.after_state?.data?.result;
    return typeof result === 'string' ? result.trim() : '';
}

/** A received letter opened in the history is «прочитано» for this user in Mail too (PATCH /emails/read). */
const readLetters = new Set<number>();
const mailReadService = useService('emails', { auth: true });
function onMailToggle(event: any, domEvent: Event) {
    const id = Number(mailOf(event).id);
    if (!(domEvent.target as HTMLDetailsElement)?.open || !id || isOutgoing(event) || readLetters.has(id)) return;
    readLetters.add(id);
    mailReadService.patch('read', { ids: [id] }).exec().catch(() => undefined);
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

// a letter in the feed: its own text and the quote (cleaned for v-html), the first line; once per letter
const quotes = reactive<Record<number, boolean>>({});
const mailCache = new Map<string, { html: boolean; main: string; quote: string; snippet: string }>();
function mailParts(event: any): { html: boolean; main: string; quote: string; snippet: string } {
    const mail = mailOf(event);
    const body = String(mail?.body ?? '');
    const html = String(mail?.html ?? '');
    const key = `${mail?.id ?? event.id}:${body.length}:${html.length}:${body.slice(0, 32)}`;
    let view = mailCache.get(key);
    if (!view) {
        const parts = letterView(mail as any);
        view = { ...parts, snippet: letterSnippet(mail as any) };
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

/** «срок: пт 21.11 15:00 · исполнитель: Анна» (no seconds). */
function taskMeta(task: any): string {
    if (!task) return '';
    const parts: string[] = [];
    const due = task.end_time || task.end || task.start_time || task.start;
    if (due) parts.push(`срок: ${taskWhen(due, !!task.allDay)}`);
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
        case DealEventType.NewProduct: return 'ph:package';
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
            return 'text-primary-500 dark:text-primary-300';
        default:
            return 'text-muted-400 dark:text-muted-500';
    }
}

// ------------------------------------------------------------------ comments
const draft = ref('');
// notes opened in full («Показать полностью») and runs of grey lines unfolded
const expanded = reactive<Record<string | number, boolean>>({});

/** A note longer than six lines is folded. */
function isLongText(text: unknown): boolean {
    const value = String(text ?? '');
    return value.split('\n').length > 6 || value.length > 600;
}

/**
 * Where a note is changed: a note of a deal through the deal, a note in the card of a company or a
 * contact (no deal, POST /companies/:id/comments, /users/:id/comments) through that card.
 */
function commentRoute(event: any): { service: ReturnType<typeof useService>; path: string; form: boolean } | null {
    const dealId = event.deal?.id ?? props.deal?.id;
    if (dealId) return { service: dealService, path: `${dealId}/comments/${event.id}`, form: true };
    // a contact's note carries the contact's company too: changed through the contact
    if (event.contact_id) return { service: userService, path: `${event.contact_id}/comments/${event.id}`, form: false };
    if (event.company_id) return { service: companyService, path: `${event.company_id}/comments/${event.id}`, form: false };
    return null;
}

/** Only the author edits or deletes a note (the API refuses everybody else). */
function mayEdit(event: any): boolean {
    return event.id > 0 && !!me.value?.id && event.originated_by?.id === me.value.id && !!commentRoute(event);
}

function startEdit(event: any) {
    draft.value = event.after_state?.data?.comment ?? '';
    editingEventId.value = event.id;
}

async function onCommentSave(event: any) {
    const route = commentRoute(event);
    const text = draft.value.trim();
    if (!route || text.length < 2) return;
    let body: FormData | { comment: string } = { comment: text };
    if (route.form) {
        body = new FormData();
        body.append('comment', text);
    }
    const result = await promiseResult(updateEventAsync(route.service.patch(route.path, body).exec(), `patch/${event.id}`));
    if (!result.ok) {
        toast.show({message: result.error.message, timeout: 3000, type: 'error'});
        return;
    }
    event.after_state = {
        ...(event.after_state ?? {}),
        data: { ...(event.after_state?.data ?? {}), comment: text, edited_at: new Date().toISOString() },
    };
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
    const route = commentRoute(event);
    if (!route || !window.confirm('Удалить запись из истории?')) return;
    const taken = takeEvent(event.id);
    const result = await promiseResult(updateEventAsync(route.service.remove(route.path).exec(), `delete/${event.id}`));
    if (!result.ok) {
        toast.show({message: result.error.message, timeout: 3000, type: 'error'});
        if (taken) taken.page.data.splice(taken.index, 0, taken.event);
        return;
    }
    editingEventId.value = undefined;
}

watchEffect(() => {
    if (props.startObserver) observer.resume();
});

/*
 * Paging of the feed like a chat: it opens at the newest events (next to the composer); an older page
 * is loaded when the reader scrolls up to the top, and the view stays on the same messages while it is
 * inserted above. The observer only fires when the top marker comes into view, so after every page it
 * is re-armed: a page that does not fill the card loads the next one at once.
 */
const cardEl = (): HTMLElement | undefined => chatAreaRef.value;
// the newest event at the bottom edge of the scrolled part
const scrollToNewest = (el: HTMLElement, smooth = false) => {
    const top = Math.max(0, el.scrollHeight - el.clientHeight);
    if (smooth && typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: 'smooth' });
    else el.scrollTop = top;
};
let beforeInsert: { height: number; top: number } | undefined;
let openedAtNewest = false;
watch(() => props.events.pages.length, () => {
    const el = cardEl();
    beforeInsert = el ? { height: el.scrollHeight, top: el.scrollTop } : undefined;
}, { flush: 'pre' });
watch(() => props.events.pages.length, async (count, previous) => {
    await nextTick();
    const el = cardEl();
    if (el && count > 0) {
        if (previous && beforeInsert && count > previous) el.scrollTop = beforeInsert.top + (el.scrollHeight - beforeInsert.height);
    }
    beforeInsert = undefined;
    if (!count) openedAtNewest = false;
}, { flush: 'post' });
// after every load the top marker is watched anew: if it is still in view (a short page), the next
// older page is asked at once — the parent ignores the call while loading or when there is no more
watch(() => props.eventsLoading, async (loading) => {
    if (loading || !props.startObserver || !props.events.pages.length) return;
    await nextTick();
    observer.pause();
    observer.resume();
});
// open at the newest once the feed is drawn (the first page may come before or after the card)
watch(() => feed.value.length > 0 && !props.eventsLoading, async (ready) => {
    if (!ready || openedAtNewest) return;
    openedAtNewest = true;
    await nextTick();
    requestAnimationFrame(() => {
        const el = cardEl();
        if (el) scrollToNewest(el);
        onScroll();
    });
}, { immediate: true, flush: 'post' });

// «К последнему сообщению»: shown when the reader is more than about a screen above the newest
const awayFromNewest = ref(false);
function onScroll() {
    const el = cardEl();
    if (!el) return;
    awayFromNewest.value = el.scrollHeight - el.scrollTop - el.clientHeight > Math.max(240, el.clientHeight * 0.6);
}
function toNewest() {
    const el = cardEl();
    if (el) scrollToNewest(el, true);
}
// a new message (live, or just sent) while the reader is at the bottom: it stays in view
const newestKey = computed(() => {
    const last = feed.value[feed.value.length - 1] as any;
    if (!last) return '';
    const events = last.events ?? (last.event ? [last.event] : []);
    return `${last.key}:${events.length}`;
});
watch(newestKey, async (key, previous) => {
    if (!key || !previous || !openedAtNewest || awayFromNewest.value) return;
    await nextTick();
    const el = cardEl();
    if (el) scrollToNewest(el);
}, { flush: 'post' });
</script>

<style scoped>
/* a letter's own HTML: readable paragraphs and tables, nothing wider than the bubble */
.mail-body :deep(p) {
    margin: 0 0 0.5em;
}
.mail-body :deep(table) {
    max-width: 100%;
    border-collapse: collapse;
}
.mail-body :deep(td),
.mail-body :deep(th) {
    padding: 2px 6px;
    vertical-align: top;
}
.mail-body :deep(img) {
    max-width: 100%;
    height: auto;
}
.mail-body :deep(a) {
    text-decoration: underline;
}
summary::-webkit-details-marker {
    display: none;
}
</style>
