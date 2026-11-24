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
                <div>
                    <input
                        id="filter-deleted"
                        v-model="filters.direction"
                        type="radio"
                        name="direction"
                        value="deleted"
                        class="peer apperance-none opacity-0 h-0 -z-10 absolute"
                    >
                    <label
                        for="filter-deleted"
                        class="nui-button nui-button-medium nui-button-rounded nui-button-pastel
                        dark:text-primary-200 hover:bg-primary-600/10 dark:hover:bg-primary-600/40 hover:text-primary-600
                        dark:peer-checked:bg-primary-600/40 dark:peer-checked:text-primary-200 peer-checked:bg-primary-600/10 peer-checked:text-primary-600"
                    >
                        <Icon
                            name="ph:trash"
                            class="size-5 mr-1"
                        />
                        Удалённые
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
                    v-if="seesAllMail"
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
                    Синхронизировать
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
        <!-- how the copying of the mailboxes goes: a letter that cannot be loaded no longer stops the mail silently -->
        <div
            v-if="syncStatus && (!syncStatus.ok || syncStatus.last_success_at)"
            class="-mt-6 flex flex-wrap items-center gap-2 text-xs"
            :class="syncStatus.ok ? 'text-muted-500 dark:text-muted-400' : 'text-amber-600 dark:text-amber-400'"
        >
            <Icon :name="syncStatus.ok ? 'ph:check-circle' : 'ph:warning'" class="size-4" />
            <span v-if="syncStatus.last_success_at">Почта загружена: {{ formatter.format(new Date(syncStatus.last_success_at)) }}.</span>
            <span v-else>Почта ещё не загружалась без ошибок.</span>
            <span v-for="error of syncStatus.errors" :key="error.mailbox">Папка {{ error.mailbox }}: {{ error.message }}.</span>
            <span v-if="syncStatus.failing.length">Не загружаются писем: {{ syncStatus.failing.length }} (попробуем ещё раз).</span>
            <span v-if="syncStatus.skipped.length">Писем загружено без содержимого: {{ syncStatus.skipped.length }} — их можно прочитать в почтовой программе.</span>
        </div>
        <!-- «От клиентов» / «Неразобранные» (newsletters, a new client's first letter: «Привязать» in the letter) / «Все» -->
        <div
            v-if="filters.direction === 'incoming'"
            class="-mt-4 flex flex-wrap items-center gap-2"
        >
            <BaseButton
                v-for="tab of clientTabs"
                :key="tab.value"
                size="sm"
                rounded="md"
                :variant="clientTab === tab.value ? 'solid' : 'pastel'"
                :color="clientTab === tab.value ? 'primary' : 'default'"
                @click="setClientTab(tab.value)"
            >
                {{ tab.label }}
                <span
                    v-if="tab.value === 'unsorted' && unsortedUnread > 0"
                    class="ms-1 rounded-full bg-amber-500 px-1.5 text-[11px] leading-4 text-white"
                    :title="`Непрочитанных: ${unsortedUnread}`"
                >{{ unsortedUnread }}</span>
            </BaseButton>
            <span v-if="clientTab === 'unsorted'" class="text-xs text-muted-500 dark:text-muted-400">
                Письма без контакта и сделки: откройте письмо и нажмите «Привязать»
            </span>
        </div>
        <main>
            <!-- what to do with the chosen letters -->
            <div
                v-if="selectedEmails.length"
                class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border-l-[3px] border-l-primary-600 bg-muted-100 px-3 py-2 text-sm text-muted-800 dark:border-l-primary-400 dark:bg-muted-700 dark:text-muted-100"
            >
                <span class="font-medium">Выбрано: {{ selectedEmails.length }}</span>
                <button type="button" class="inline-flex items-center gap-1" @click="addContactModal.open">
                    <Icon name="ph:user-plus" class="size-4 text-primary-600 dark:text-primary-200" />
                    Добавить контакты
                </button>
                <button type="button" class="inline-flex items-center gap-1" @click="addDealModal.open">
                    <Icon name="ph:currency-circle-dollar" class="size-4 text-blue-600 dark:text-blue-400" />
                    Создать сделку
                </button>
                <button
                    v-if="unreadCount > 0"
                    type="button"
                    class="inline-flex items-center gap-1"
                    :disabled="isLoadingMap.read"
                    @click="markAsRead"
                >
                    <Icon :name="isLoadingMap.read ? 'lucide:loader-circle' : 'ph:envelope-simple-open'" class="size-4 text-primary-600 dark:text-primary-200" :class="isLoadingMap.read ? 'animate-spin' : ''" />
                    Прочитано
                </button>
                <button
                    v-if="filters.direction === 'incoming' || filters.direction === 'outgoing'"
                    type="button"
                    class="inline-flex items-center gap-1"
                    :disabled="isLoadingMap.spamall"
                    @click="() => markAsSpam()"
                >
                    <Icon :name="isLoadingMap.spamall ? 'lucide:loader-circle' : 'lucide:octagon-alert'" class="size-4 text-yellow-700 dark:text-yellow-200" :class="isLoadingMap.spamall ? 'animate-spin' : ''" />
                    В спам
                </button>
                <button
                    v-if="filters.direction === 'spam'"
                    type="button"
                    class="inline-flex items-center gap-1"
                    :disabled="isLoadingMap.notspamall"
                    @click="() => markAsNotSpam()"
                >
                    <Icon name="ph:tray" class="size-4 text-primary-600 dark:text-primary-200" />
                    Не спам
                </button>
                <button
                    v-if="filters.direction === 'deleted'"
                    type="button"
                    class="inline-flex items-center gap-1"
                    :disabled="isLoadingMap.restoreall"
                    @click="() => restore()"
                >
                    <Icon name="ph:arrow-counter-clockwise" class="size-4 text-primary-600 dark:text-primary-200" />
                    Восстановить
                </button>
                <!-- letters of the shared mailbox: only an admin or a manager deletes them (an agent: the ones they sent) -->
                <button
                    v-if="filters.direction !== 'deleted' && selectedEmails.every(mayDelete)"
                    type="button"
                    class="inline-flex items-center gap-1"
                    :disabled="isLoadingMap.deleteall"
                    @click="() => deleteConfirmation.open({description: deleteQuestion()})"
                >
                    <Icon :name="isLoadingMap.deleteall ? 'lucide:loader-circle' : 'ph:trash'" class="size-4 text-rose-600 dark:text-rose-400" :class="isLoadingMap.deleteall ? 'animate-spin' : ''" />
                    Удалить
                </button>
                <button type="button" class="ms-auto text-muted-500 hover:text-muted-700 dark:text-muted-300" @click="selectedEmails = []">
                    Снять выбор
                </button>
            </div>
            <div class="text-sm border border-muted-200 dark:border-muted-700 rounded-md overflow-hidden">
                <!-- the header: columns on a computer; on a phone a letter is a card of two lines -->
                <div class="flex items-center gap-3 bg-muted-50 dark:bg-muted-800 px-3 py-2.5 text-xs uppercase font-semibold tracking-wider text-muted-700 dark:text-muted-400">
                    <BaseCheckbox
                        :checked="emails.data.length > 0 && selectedEmails.length === emails.data.length"
                        rounded="sm"
                        :classes="{wrapper: 'shrink-0'}"
                        title="Выбрать все на странице"
                        @change="onSelectAll"
                    />
                    <div class="mail-cols min-w-0 flex-1">
                        <span>{{ filters.direction === 'outgoing' ? 'Кому' : 'От кого' }}</span>
                        <span class="hidden lg:block">Тема и сообщение</span>
                        <span class="hidden lg:block text-right">Дата</span>
                    </div>
                </div>
                <BasePlaceload
                    v-show="emailsLoading"
                    class="h-2 w-full"
                />
                <div
                    v-if="!emailsLoading && !emails.data.length"
                    class="bg-white dark:bg-muted-800 py-4 px-3 text-center text-muted-500 dark:text-muted-400"
                >
                    {{ clientTab === 'unsorted' && filters.direction === 'incoming' ? 'Неразобранных писем нет' : 'Писем нет' }}
                </div>
                <ul
                    v-if="!emailsLoading && emails.data"
                    class="bg-white dark:bg-muted-800 divide-y divide-muted-200 dark:divide-muted-700 border-t border-t-muted-200 dark:border-t-muted-700"
                >
                    <li
                        v-for="email in emails.data"
                        :key="email.id"
                        class="flex items-start gap-3 px-3 py-2.5 hover:bg-muted-50 dark:hover:bg-muted-900 transition-colors duration-300"
                        :class="currentEmail?.id === email.id ? 'bg-primary-500/5' : ''"
                    >
                        <BaseCheckbox
                            v-model="selectedEmails"
                            :value="email"
                            rounded="sm"
                            :classes="{wrapper: 'shrink-0 mt-0.5'}"
                        />
                        <button
                            type="button"
                            class="mail-cols min-w-0 flex-1 text-left"
                            @click="() => onEmailToggle(email)"
                        >
                            <!-- who: the contact · the company, the address under it -->
                            <div class="flex min-w-0 items-start gap-2">
                                <span
                                    v-if="!email.read"
                                    class="mt-1.5 shrink-0 inline-block bg-primary-600 dark:bg-primary-200 w-2 h-2 rounded-full"
                                    title="Не прочитано"
                                />
                                <div class="flex min-w-0 flex-1 flex-col">
                                    <span class="truncate text-muted-900 dark:text-white" :class="!email.read ? 'font-semibold' : ''">{{ whoOf(email) }}</span>
                                    <span v-if="addressLine(email)" class="truncate text-xs text-muted-500 dark:text-muted-400">{{ addressLine(email) }}</span>
                                </div>
                                <span class="shrink-0 text-xs text-muted-500 dark:text-muted-400 lg:hidden">{{ shortDate(email.sent_at) }}</span>
                            </div>
                            <!-- the deal, the subject and the beginning of the text -->
                            <div class="flex min-w-0 items-center gap-2">
                                <span
                                    v-for="deal of (email.deals ?? []).slice(0, 1)"
                                    :key="deal.id"
                                    class="max-w-[10rem] lg:max-w-[14rem] shrink-0 truncate rounded-md px-1.5 text-xs leading-5"
                                    :class="deal.stage_color ? 'text-white' : 'bg-muted-100 text-muted-700 dark:bg-muted-700 dark:text-muted-200'"
                                    :style="deal.stage_color ? {backgroundColor: deal.stage_color} : undefined"
                                    :title="[`№${deal.display_id} ${deal.label}`, deal.stage, deal.closed ? 'закрыта' : '', (email.deals?.length ?? 0) > 1 ? `и ещё сделок: ${(email.deals?.length ?? 1) - 1}` : ''].filter(Boolean).join(' · ')"
                                >№{{ deal.display_id }} {{ deal.label }}</span>
                                <span class="line-clamp-1 min-w-0 flex-1 break-words">
                                    <span class="text-muted-900 dark:text-white" :class="!email.read ? 'font-semibold' : ''">{{ email.subject?.trim() || '(без темы)' }}</span>
                                    <span v-if="snippetOf(email)" class="text-muted-500 dark:text-muted-400"> — {{ snippetOf(email) }}</span>
                                </span>
                                <Icon v-if="email.files?.length" name="ph:paperclip" class="size-4 shrink-0 text-muted-400" />
                            </div>
                            <span class="hidden lg:block text-right text-xs text-muted-500 dark:text-muted-400">{{ shortDate(email.sent_at) }}</span>
                        </button>
                    </li>
                </ul>
            </div>
        </main>
        <BasePagination
            v-if="emails.count > perPage"
            v-model:current-page="currentPage"
            class="my-2"
            :item-per-page="perPage"
            :total-items="emails.count"
            :max-links-displayed="breakpoints.lg.value ? 7 : 1"
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
                    <Single :email="currentEmail" @changed="onLetterChanged" @linked="() => fetchEmails()" />
                </div>
            </div>
        </Transition>
        <AddContactModal
            id="AddContactModal"
            :emails="selectedEmails"
            @saved="() => fetchEmails()"
        />
        <AddDealModal
            id="AddDealModal"
            :emails="selectedEmails"
            @saved="onDealsCreated"
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
import moment from "moment";

import Confirmation from "~/components/common/Confirmation.vue";
import AddContactModal from "~/components/mail/AddContactModal.vue";
import AddDealModal from "~/components/mail/AddDealModal.vue";
import TairoPopover from "~/components/tairo/TairoPopover.vue";
import { useAsync } from "~/composables/useAsync";
import type { Email, MailSyncStatus } from "~/types/mail";
import { type User, UserRole } from "~/types/user";
import type { Stage } from "~/types/stage";
import { addressesOf, letterSnippet } from "~/utils/mailView";

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
    direction: "incoming" | "outgoing" | "spam" | "deleted";
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
const route = useRoute();
const app = useAppConfig();
const stagesService = useService("stages", {auth: true});
const mailsService = useService("emails", {auth: true});
const addContactModal = useModal("AddContactModal");
const addDealModal = useModal("AddDealModal");
const deleteConfirmation = useModal("DeleteConfirmation");

const isDarkMode = useDarkMode();
const router = useRouter();
const breakpoints = useTailwindBreakpoints();
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
const currentUser = useState<User>("user");
// the filter «Почты агентов» works for admin and manager (they see every letter)
const seesAllMail = computed(() => currentUser.value?.role === UserRole.Admin || currentUser.value?.role === UserRole.Manager);
const syncStatus = ref<MailSyncStatus | null>(null);
const syncStatusService = useService("emails/sync-status", {auth: true});

/**
 * «От клиентов»: letters in a deal or from a contact / a company address; «Неразобранные»: the rest
 * (newsletters, a new client's first letter). The inbox used to be mostly newsletters.
 */
type ClientTab = "clients" | "unsorted" | "all";
const clientTabs: { value: ClientTab; label: string }[] = [
    { value: "clients", label: "От клиентов" },
    { value: "unsorted", label: "Неразобранные" },
    { value: "all", label: "Все" },
];
const clientTab = ref<ClientTab>((["clients", "unsorted", "all"] as string[]).includes(String(route.query.tab)) ? route.query.tab as ClientTab : "clients");
const unsortedUnread = ref(0);

function setClientTab(tab: ClientTab) {
    if (clientTab.value === tab) return;
    clientTab.value = tab;
    currentPage.value = 1;
    selectedEmails.value = [];
    fetchEmails();
}

/** How many unsorted letters nobody of us has read: the tab shows it, so a new client is not missed. */
function fetchUnsortedUnread() {
    mailsService.find({ limit: 1, skip: 0, outgoing: false, is_spam: false, of_client: false, read: false }).exec()
        .then((page: any) => { unsortedUnread.value = Number(page?.count ?? 0); })
        .catch(() => undefined);
}

/** The contact · the company of the letter, else the name or the address (to whom, for a letter we sent). */
function whoOf(email: Email): string {
    const client = [email.client?.contact?.username, email.client?.company?.name].filter(Boolean).join(" · ");
    if (client) return client;
    if (email.outgoing) return (email.to ?? []).map((r) => r.value).join(", ") || "(без адресата)";
    return email.from_name || email.from || "(без отправителя)";
}

/** The address under the name, when the name is not the address itself. */
function addressLine(email: Email): string {
    const address = email.outgoing ? (email.to ?? []).map((r) => r.value).join(", ") : (email.from ?? "");
    return address && address !== whoOf(email) ? address : "";
}

const snippets = new WeakMap<object, string>();
function snippetOf(email: Email): string {
    if (!snippets.has(email)) snippets.set(email, letterSnippet(email));
    return snippets.get(email) ?? "";
}

const timeFormat = new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("ru", { day: "numeric", month: "short" });
const fullDateFormat = new Intl.DateTimeFormat("ru", { day: "2-digit", month: "2-digit", year: "numeric" });

/** «14:05» today, «21 нояб.» this year, «21.11.2025» before. */
function shortDate(value?: string | null): string {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const now = new Date();
    if (date.toDateString() === now.toDateString()) return timeFormat.format(date);
    if (date.getFullYear() === now.getFullYear()) return dayFormat.format(date);
    return fullDateFormat.format(date);
}

/**
 * The shared mailbox is everybody's: an admin or a manager deletes its letters, an agent the ones they
 * sent and the ones written to them alone (the server checks the same and answers 403 otherwise).
 */
function mayDelete(email: Email): boolean {
    if (seesAllMail.value) return true;
    if (email.outgoing) return email.sent_by?.id === currentUser.value?.id;
    const own = String(currentUser.value?.email ?? "").toLowerCase();
    const recipients = addressesOf([...(email.to ?? []), ...(email.cc ?? [])].map((r) => r.value));
    return !!own && recipients.length === 1 && recipients[0] === own;
}

function deleteQuestion(): string {
    const list = selectedEmails.value;
    return list.length === 1
        ? `Удалить письмо «${list[0].subject?.trim() || "без темы"}»? Оно попадёт в «Удалённые», его можно будет восстановить.`
        : `Удалить выбранные письма (${list.length})? Они попадут в «Удалённые», их можно будет восстановить.`;
}

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
        // the drawer loads the whole letter, which marks it read (for this user)
        emails.value.data = emails.value.data.map((e) => e.id === email.id ? ({...e, read: true}) : e);
        // the address of the letter, so that it can be copied and opened again (/mails/:id)
        if (String(route.params.id ?? "") !== String(email.id)) router.replace({ path: `/mails/${email.id}`, query: route.query });
    } else {
        document.documentElement.style.overflow = "auto";
        if (route.params.id) router.replace({ path: "/mails", query: route.query });
    }
    currentEmail.value = email;
}

/** The letter in the drawer moved (spam, not spam, restored): it leaves this folder. */
function onLetterChanged(id: number) {
    emails.value.data = emails.value.data.filter((email) => email.id !== id);
}

/** Deals made from the chosen letters: the list shows them at the letters. */
function onDealsCreated() {
    selectedEmails.value = [];
    fetchEmails();
}

/** /mails/:id opens the letter over the list (pages/mails/index.vue has no <NuxtPage>). */
async function openFromRoute() {
    const id = Number(route.params.id);
    if (!id) {
        // back in the browser from /mails/:id: the drawer closes
        if (currentEmail.value) {
            document.documentElement.style.overflow = "auto";
            currentEmail.value = undefined;
        }
        return;
    }
    if (currentEmail.value?.id === id) return;
    const result = await promiseResult(mailsService.get(id).exec());
    if (!result.ok) return toast.show({message: result.error.message, type: "error", timeout: 4000});
    onEmailToggle(result.value as Email);
}

async function restore(emailId?: number) {
    const ids = emailId ? [emailId] : selectedEmails.value.map((email) => email.id);
    const results = await promiseResult(runWithId(Promise.all(ids.map((id) => mailsService.patch(`${id}/restore`, {}).exec())) as any, emailId ? "restore" + emailId : "restoreall"));
    if (!results.ok) return toast.show({message: results.error.message, type: "error", timeout: 4000});
    emails.value.data = emails.value.data.filter((email) => !ids.includes(email.id));
    selectedEmails.value = selectedEmails.value.filter((email) => !ids.includes(email.id));
    toast.show({message: ids.length === 1 ? "Письмо восстановлено" : `Восстановлено писем: ${ids.length}`, type: "success", timeout: 3000});
}

async function markAsNotSpam(emailId?: number) {
    const ids = emailId ? [emailId] : selectedEmails.value.map((email) => email.id);
    const results = await promiseResult(runWithId(Promise.all(ids.map((id) => mailsService.patch(`${id}/not-spam`, {}).exec())) as any, emailId ? "notspam" + emailId : "notspamall"));
    if (!results.ok) return toast.show({message: results.error.message, type: "error", timeout: 4000});
    emails.value.data = emails.value.data.filter((email) => !ids.includes(email.id));
    selectedEmails.value = selectedEmails.value.filter((email) => !ids.includes(email.id));
}

function showSyncProblems(status?: MailSyncStatus | null) {
    if (!status) return;
    syncStatus.value = status;
    if (status.ok) return;
    const problems = [
        ...status.errors.map((error) => `${error.mailbox}: ${error.message}`),
        status.failing.length ? `не загружаются писем: ${status.failing.length}` : "",
    ].filter(Boolean);
    toast.show({message: `Почта загружена не полностью — ${problems.join("; ")}`, type: "error", timeout: 7000});
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
    const promises = selectedEmails.value.map((email) => mailsService.remove(email.id).exec());
    const result = await promiseResult(runWithId(Promise.all(promises) as any, "deleteall"));
    if (!result.ok) toast.show({message: result.error.message, type: "error", timeout: 4000});
    // deleted letters go to the Trash mailbox of the server: «Удалённые» shows them and brings them back
    else toast.show({message: "Письма перенесены в «Удалённые»", type: "success", timeout: 3000});
    fetchEmails();
    selectedEmails.value = [];
}

/** «Прочитано» for this user only (a colleague in Cc keeps the letter unread for themselves). */
async function markAsRead() {
    const ids = selectedEmails.value.filter((email) => !email.read).map((email) => email.id);
    if (!ids.length) return;
    const result = await promiseResult(runWithId(mailsService.patch("read", { ids }).exec() as any, "read"));
    if (!result.ok) return toast.show({message: result.error.message, type: "error", timeout: 4000});
    emails.value.data = emails.value.data.map((email) => ids.includes(email.id) ? ({...email, read: true}) : email);
    selectedEmails.value = [];
    fetchUnsortedUnread();
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
        sort: { sent_at: -1 },
        skip: (currentPage.value - 1) * perPage.value,
        limit: perPage.value,
        is_spam: isSpam,
    };
    // «Удалённые»: every direction; the other folders by direction
    if (filters.direction === "deleted") query.deleted = true;
    else query.outgoing = outgoing;

    // «От клиентов» / «Неразобранные» of the inbox
    if (filters.direction === "incoming" && clientTab.value !== "all") {
        query.of_client = clientTab.value === "clients";
    }
    if (filters.direction === "incoming") fetchUnsortedUnread();

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
        mailsService.get("sync", query).exec().then((page: any) => {
            showSyncProblems(page?.sync);
            return page;
        }).catch((e: any) => {
            toast.show({
                message: `Не удалось получить новую почту: ${e?.message ?? "ошибка сервера"}`,
                type: "error",
                timeout: 5000,
            });
            return mailsService.find(query).exec();
        }) as Promise<any>,
    );
}

watch(() => [currentPage.value, perPage.value, filters.direction], () => {
    selectedEmails.value = [];
    fetchEmails();
});


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

watch(() => route.params.id, () => openFromRoute());

onMounted(() => {
    runStages(stagesService.find().exec());
    fetchEmails();
    if (seesAllMail.value) fetchAgentEmails();
    openFromRoute();
    syncStatusService.find().exec().then((status: any) => { syncStatus.value = status; }).catch(() => undefined);
});

onUnmounted(() => {
    document.documentElement.style.overflow = "auto";
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

/* a letter: on a phone two lines (who and the date, then the subject); on a computer three columns,
   the date always on screen (it used to be pushed past the right edge by fixed widths) */
.mail-cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    row-gap: 0.125rem;
}
@media (min-width: 1025px) {
    .mail-cols {
        grid-template-columns: minmax(12rem, 18rem) minmax(0, 1fr) 6.5rem;
        column-gap: 1rem;
        align-items: center;
    }
}

</style>
