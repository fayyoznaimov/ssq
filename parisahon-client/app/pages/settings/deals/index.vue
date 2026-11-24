<template>
    <div class="flex flex-col space-y-8">
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-wrap items-center gap-3">
                <TairoPopover v-if="isAdmin" orientation="start" class="start-0 z-20">
                    <template #default="{open}">
                        <BaseButton :loading="collectionsLoading" title="Выбрать, переименовать или добавить воронку">
                            Воронка: {{ activeCollection?.name || '—' }}
                            <Icon name="ph:caret-down" class="ms-3 transition-transform duration-300" :class="open ? 'rotate-180' : ''" />
                        </BaseButton>
                    </template>
                    <template #content={close}>
                        <ul class="flex flex-col divide-y divide-muted-200 dark:divide-muted-600">
                            <li v-for="collection in collections" class="text-sm flex items-center justify-between">
                                <BaseInput v-if="editingCollection === collection.id" :classes="{input: 'border-none !outline-none !h-auto !py-4 !px-5 dark:!bg-transparent'}" v-model="collection.name" />
                                <button v-else class="px-5 py-4 leading-5 block w-full text-left" :class="collection.is_active ? 'text-blue-600' : 'text-muted-600 dark:text-white'" @click="onActivate(collection.id, close)">{{ collection.name }}</button>
                                <div class="flex shrink-0 mr-3 gap-1">
                                    <BaseButtonIcon v-if="editingCollection === collection.id" size="sm" class="border-none !outline-none" @click="onCollectionDelete(collection.id)">
                                        <Icon v-if="isLoadingMap['removingCollection' + collection.id]" name="lucide:loader-circle" class="size-4 animate-spin" />
                                        <Icon v-else name="ph:trash" class="size-4 text-rose-500" />
                                    </BaseButtonIcon>
                                    <BaseButtonIcon v-if="editingCollection != collection.id" size="sm" @click="editingCollection = collection.id" class="border-none !outline-none">
                                        <Icon name="ph:pencil" class="size-4" />
                                    </BaseButtonIcon>
                                    <BaseButtonIcon v-else size="sm" class="border-none !outline-none" @click="onUpdateCollection(collection)">
                                        <Icon v-if="isLoadingMap['updatingCollection' + collection.id]" name="lucide:loader-circle" class="size-4 animate-spin" />
                                        <Icon v-else name="ph:check" class="size-4" />
                                    </BaseButtonIcon>
                                </div>
                            </li>
                            <li>
                                <form class="flex items-center justify-between gap-2" @submit.prevent="onCollectionCreate">
                                    <BaseInput :key="resetKey" name="name" placeholder="Добавить воронку" :classes="{input: 'border-none !outline-none !h-auto !py-4 !px-5 dark:!bg-transparent', wrapper: 'peer'}" autocomplete="off" required />
                                    <BaseButtonIcon size="sm" class="group relative shrink-0 mr-3" type="submit" :loading="isLoadingMap.savingCollection">
                                        <Icon name="ph:plus" class="size-4 transition-transform duration-200 peer-has-[:focus-within]:group-[]:scale-0" />
                                        <Icon name="ph:check" class="absolute size-4 scale-0 transition-transform duration-200 !ml-0 peer-has-[:focus-within]:group-[]:scale-100" />
                                    </BaseButtonIcon>
                                </form>
                            </li>
                        </ul>
                    </template>
                </TairoPopover>
                <span v-else class="text-sm font-medium text-muted-700 dark:text-muted-200">Воронка: {{ activeCollection?.name || '—' }}</span>
                <!-- where a deal goes when nobody chose its stage: Telegram, WhatsApp, calls, mail, the bot -->
                <div class="flex items-center gap-2 text-sm text-muted-600 dark:text-muted-300">
                    <span class="whitespace-nowrap">Этап для новых сделок:</span>
                    <BaseListbox
                        class="w-56"
                        :items="defaultStageOptions"
                        :properties="{ label: 'name', value: 'id' }"
                        :model-value="selectedDefaultStage"
                        :disabled="!isAdmin || defaultStageSaving"
                        :loading="defaultStageSaving"
                        placeholder="Не выбран"
                        @update:model-value="onDefaultStageChange"
                    />
                </div>
            </div>
            <div class="flex gap-3">
                <NuxtLink :to="route.query.from">
                    <BaseButton :disabled="saving">
                        {{ canEditTriggers ? 'Отменить' : 'Назад' }}
                    </BaseButton>
                </NuxtLink>
                <BaseButton v-if="canEditTriggers" color="primary" form="stage-form" type="submit" :disabled="saving">
                    Сохранить
                </BaseButton>
            </div>
        </div>
        <!-- stages are the admin's (the API: ADMIN_LEVEL), the triggers of a stage also the manager's -->
        <p v-if="!isAdmin" class="!mt-4 rounded-md bg-muted-100 px-4 py-2 text-sm text-muted-600 dark:bg-muted-800 dark:text-muted-300">
            {{ canEditTriggers
                ? 'Этапы и воронки меняет администратор; триггеры этапов вы можете добавлять, менять и переставлять.'
                : 'Только просмотр: этапы и триггеры настраивают администратор и руководитель.' }}
        </p>
        <!-- triggers that name something deleted (a dismissed employee, a template...), of every pipeline -->
        <div v-if="brokenTriggers.length" class="!mt-4 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
            <p class="font-medium">Не сработают триггеры ({{ brokenTriggers.length }}): исправьте их, иначе автоматика молча стоит</p>
            <ul class="mt-1 list-disc ps-5">
                <li v-for="item in brokenTriggers.slice(0, 8)" :key="item.id">
                    Этап «{{ item.stage }}», «{{ item.action }}»: {{ item.problems.join('; ') }}
                </li>
            </ul>
            <p v-if="brokenTriggers.length > 8" class="mt-1 text-xs">и ещё {{ brokenTriggers.length - 8 }}</p>
        </div>
        <div class="!mt-4 flex items-center justify-between gap-2 text-xs text-muted-500 dark:text-muted-400">
            <span>Триггеры этапа выполняются сверху вниз. Этапы листаются вбок:</span>
            <div class="flex gap-1">
                <BaseButtonIcon size="sm" type="button" title="Влево" @click="scrollStages(-1)"><Icon name="ph:caret-left" class="size-4" /></BaseButtonIcon>
                <BaseButtonIcon size="sm" type="button" title="Вправо" @click="scrollStages(1)"><Icon name="ph:caret-right" class="size-4" /></BaseButtonIcon>
            </div>
        </div>
        <form method="post" @submit.prevent="onSubmit" id="stage-form" class="!mt-2 dark:bg-muted-800 bg-white">
            <BasePlaceload class="h-2 w-full" v-show="isLoading" />
            <Draggable v-bind="dragOptions" item-key="id" v-model="sortedStages" tag="ul" class="flex overflow-x-auto" ref="stageRefs" handle=".drag-handle" v-dragscroll="{ excluded: ['drag-handle', 'trigger-dropdown'] }">
                <template #item="{ element: stage, index }: {element: CustomStage, index: number}">
                    <li :key="stage.id" :id="String(stage.id)" class="border border-slate-200 dark:border-slate-700 border-r-0 last:border-r-slate-200 relative shrink-0 basis-64">
                        <div class="flex items-center justify-between relative group text-sm bg-muted-50 dark:bg-muted-800 text-muted-700 dark:text-muted-400 text-left font-sans font-semibold tracking-wider py-1">
                            <button v-if="isAdmin" class="cursor-move ml-2 drag-handle" type="button" title="Перетащите, чтобы поменять этапы местами">
                                <Icon
                                    class="w-4 h-4 pointer-events-none"
                                    name="ph:list"
                                />
                            </button>
                            <input type="hidden" name="stages" :value="stage.id">
                            <input type="hidden" :name="'stage.' + stage.id + '.status'" :value="stage.status">
                            <input type="hidden" :name="'stage.' + stage.id + '.color'" :value="stage.color">
                            <input type="hidden" :name="'stage.' + stage.id + '.name'" :value="names[stage.id]">
                            <input type="hidden" :name="'stage.' + stage.id + '.description'" :value="stage.description">
                            <input type="hidden" :name="'stage.' + stage.id + '.order'" :value="index">
                            <div :contenteditable="isAdmin" :class="isAdmin ? 'cursor-text' : ''" class="peer whitespace-nowrap overflow-hidden text-ellipsis w-full p-1 outline-none text-center editable" :title="stage.kind ? stageKindHints[stage.kind] : ''" @input="(e) => onNameChange(e, stage)">
                                {{ stage.name }}
                            </div>
                            <!-- a system stage (new, won, lost...) is needed by every pipeline: renamed, never deleted -->
                            <span v-if="stage.is_system" class="shrink-0 mr-1 flex" :title="stage.kind ? stageKindHints[stage.kind] : ''"><Icon name="ph:lock-simple" class="size-4 text-muted-400" /></span>
                            <button v-if="!stage.is_system && isAdmin" @click="() => deleteStage(stage.id, stage.status)" title="Удалить этап" class="shrink-0 w-6 h-6 rounded-full opacity-60 hover:opacity-100 mr-1 duration-200 hover:bg-red-100 dark:hover:bg-red-400 flex items-center justify-center" type="button">
                                <Icon
                                    class="w-4 h-4 text-red-600 dark:text-white"
                                    name="ph:trash"
                                />
                            </button>
                            <input v-if="isAdmin" type="color" title="Цвет этапа" class="border-none rounded-full w-5 h-5 bg-none shrink-0 mr-3 duration-200 color-picker cursor-pointer" v-model="stage.color">
                            <button v-if="isAdmin" title="Добавить этап после этого" class="absolute -right-3 -bottom-3 bg-muted-200 w-6 h-6 rounded-full z-10 flex items-center justify-center text-muted-800 hover:bg-muted-300 duration-200 dark:bg-muted-700 dark:text-white" @click="() => addStage(index + 1)" type="button">
                                <Icon
                                    class="w-4 h-4 pointer-events-none"
                                    name="ph:plus"
                                />
                            </button>
                        </div>
                        <div class="w-full h-1" :style="{'backgroundColor': stage.color}"></div>
                        <button v-if="!!stage.id && (isAdmin || stage.description)" class="font-alt whitespace-nowrap text-sm text-muted-800 dark:text-white p-4 text-center w-full underline hover:bg-muted-50 dark:hover:bg-muted-900" @click="() => openHintModal(stage)" type="button">
                            {{ stage.description ? "1 подсказка" : "Добавить подсказки" }}
                        </button>
                        <ul class="flex flex-col divide-y divide-muted-200 dark:divide-muted-700 border-t border-t-slate-200 dark:border-t-slate-700">
                            <li
                                v-for="(trigger, index) in stage.triggers"
                                :key="trigger.id"
                                class="group relative w-full transition-colors duration-300 hover:bg-muted-50 dark:hover:bg-muted-900"
                                :class="trigger.id > 0 && triggerProblems[trigger.id]?.length ? 'bg-rose-50/60 dark:bg-rose-500/5' : ''"
                            >
                                <button class="flex w-full gap-2 py-2.5 ps-2 text-left" :class="canEditTriggers && stage.triggers.length > 1 ? 'pe-8' : 'pe-2'" @click="() => onStageTriggerSelect(stage, trigger, index)" type="button">
                                    <span class="mt-1.5 w-4 shrink-0 text-right text-xs text-muted-400" title="Порядок выполнения">{{ index + 1 }}.</span>
                                    <Icon :name="triggerIcon(trigger.type)" class="size-7 text-primary-600 dark:text-primary-200 shrink-0" />
                                    <div class="flex min-w-0 flex-col">
                                        <span class="text-[13px] text-muted-600 dark:text-muted-200">{{ describeWhen(trigger.apply_when_data, trigger.type) }}</span>
                                        <span class="text-sm font-semibold text-muted-900 dark:text-white break-words">{{ describeAction(trigger) }}</span>
                                        <span v-if="describeConditions(trigger)" class="text-[12px] text-muted-500 dark:text-muted-400 break-words">Если {{ describeConditions(trigger) }}</span>
                                        <span v-if="trigger.id > 0 && triggerProblems[trigger.id]?.length" class="text-[12px] text-rose-600 dark:text-rose-400 break-words">
                                            <Icon name="ph:warning-octagon" class="size-3.5 -mt-0.5" />
                                            Не сработает: {{ triggerProblems[trigger.id]?.join('; ') }}
                                        </span>
                                        <span
                                            v-if="trigger.id && triggerHealth[trigger.id]"
                                            class="text-[12px] text-rose-600 dark:text-rose-400"
                                            :title="triggerHealth[trigger.id]?.last_error ?? ''"
                                        >
                                            <Icon name="ph:warning-circle" class="size-3.5 -mt-0.5" />
                                            Ошибок за 7 дней: {{ triggerHealth[trigger.id]?.failed }} — подробности в «Истории запусков»
                                        </span>
                                        <span v-if="trigger.status === 'new' || trigger.status === 'changed'" class="text-[12px] text-amber-600 dark:text-amber-400">Не сохранено — нажмите «Сохранить»</span>
                                    </div>
                                </button>
                                <div v-if="canEditTriggers && stage.triggers.length > 1" class="absolute end-1 top-1.5 flex flex-col">
                                    <button type="button" :disabled="index === 0" title="Выполнять раньше" class="rounded p-0.5 text-muted-400 hover:text-primary-600 disabled:opacity-25 dark:hover:text-primary-200" @click="moveTrigger(stage, index, -1)">
                                        <Icon name="ph:caret-up-bold" class="size-4" />
                                    </button>
                                    <button type="button" :disabled="index === stage.triggers.length - 1" title="Выполнять позже" class="rounded p-0.5 text-muted-400 hover:text-primary-600 disabled:opacity-25 dark:hover:text-primary-200" @click="moveTrigger(stage, index, 1)">
                                        <Icon name="ph:caret-down-bold" class="size-4" />
                                    </button>
                                </div>
                            </li>
                            <li v-if="canEditTriggers">
                                <button class="flex w-full items-center justify-center gap-2 px-4 py-3 text-sm font-medium text-primary-600 hover:bg-muted-50 dark:text-primary-200 dark:hover:bg-muted-900" @click="() => openTriggerModal({stage, position: stage.triggers.length})" type="button">
                                    <Icon name="ph:plus" class="size-4" />
                                    Добавить триггер
                                </button>
                            </li>
                            <li v-else-if="!stage.triggers.length" class="px-4 py-3 text-center text-xs text-muted-400">Триггеров нет</li>
                        </ul>
                    </li>
                </template>
            </Draggable>
        </form>
        <TriggerForm
            v-if="selected"
            :stage="selected.stage"
            :stages="stages"
            :trigger="selected.trigger"
            :users="users.data"
            :fillers="fillers.deal ?? []"
            :problems="selected.trigger.id > 0 ? (triggerProblems[selected.trigger.id] ?? []) : []"
            :readonly="!canEditTriggers"
            @done="onTriggerConfigured"
            @cancel="selected = undefined"
            @remove="onTriggerRemove"
        />
        <StageHintModal v-if="currentStage" :stage="currentStage" id="StageHintModal" @update="onStageHintUpdate" />
        <StageTriggerModal id="StageTriggerModal" @selected="onTriggerSelected"/>
    </div>
</template>

<script lang="ts" setup>

const dragOptions = {
    animation: 200,
    ghostClass: 'ghost',
};

const colors = ['#99ccff', '#ffff99', '#ffcc66', '#CCFF66', '#D5D8DB'];
import Draggable from 'vuedraggable';

import BaseInput from '~/components/form/BaseInput.vue';
import StageHintModal from '~/components/modals/StageHintModal.vue';
import StageTriggerModal from '~/components/modals/StageTriggerModal.vue';
import TairoPopover from '~/components/tairo/TairoPopover.vue';
import {useAsync} from '~/composables/useAsync';
import type { Filler } from '~/types/filler';
import type {Modify, PaginatedResponse} from '~/types/generics';
import {FileSource, type Stage, type StageCollection,type StageTrigger, type Trigger} from '~/types/stage';
import {stageKindHints, TriggerType} from '~/types/stage';
import type { User } from '~/types/user';
import {formatBytes} from '~/utils/byte';
import {promiseResult} from '~/utils/result';

import {type AnyStage, actionNames, sourceNames, toTrigger} from '~/components/trigger/trigger';
import TriggerForm from '~/components/trigger/trigger-form.vue';

type CustomStage = Modify<Stage, {
    status: string;
}>

type SelectedTrigger = {
    trigger: Trigger;
    stage: Stage;
}

definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Настроить воронку',
    subject: 'Deal'
});

useHead({
    title: 'Настроить воронку'
});

const route = useRoute();
const router = useRouter();

const toast = useToast('GlobalToast');
const stagesService = useService('stages', {auth: true});
const triggersService = useService('triggers', {auth: true});
const userService = useService('users', {auth: true});
const fillerService = useService('fillers', {auth: true});
const collectionService = useService('stages/collections', {auth: true});
const stageHintModal = useModal('StageHintModal');
const stageTriggerModal = useModal('StageTriggerModal');
const currentStage = ref<CustomStage>();
const sortedStages = ref<CustomStage[]>([]);
const stageRefs = ref<HTMLUListElement & {targetDomElement: any}>();
const names = ref<Record<string, string>>({});
const deleted = ref<number[]>([]);
const deletedTriggers = ref<number[]>([]);
// stages whose triggers were reordered (or lost one): the order goes to the API on «Сохранить»
const orderChanged = ref(new Set<number>());
const selected = ref<SelectedTrigger>();
const resetKey = ref(0);
const editingCollection = ref();

const { run: runFillers, data: fillers } = useAsync<{ deal: Filler[] }>({ deal: [] });
const { run, isLoading, data: stages, runAsync } = useAsync<CustomStage[]>();
const { runWithId, isLoading: saving, isLoadingMap, runAsync: saveAsync } = useAsync();
const { run: runUsers, data: users, isLoading: usersLoading } = useAsync<PaginatedResponse<User>>({
    count: 0,
    data: [],
    last_page: 0,
    page_size: 1000,
    current_page: 0,
});
const { run: runCollections, data: collections, isLoading: collectionsLoading } = useAsync<StageCollection[]>([]);

const fileSourceMap: Record<FileSource, string> = {
    [FileSource.FromComments]: 'в примечаниях',
    [FileSource.FromEmails]: 'в почте',
    [FileSource.FromFilesTab]: 'во вкладке файлов',
    [FileSource.FromMessages]: 'в сообщениях',
};

const WEEK_DAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** When a trigger fires, for the stage list (with how often it may act for one deal). */
function describeWhen(when: any, type?: TriggerType): string {
    if (!when) return 'После перехода в этап';
    const dir = when.outgoing === true ? 'исходящем' : when.outgoing === false ? 'входящем' : 'любом';
    const dirCall = when.outgoing === true ? 'исходящего' : when.outgoing === false ? 'входящего' : 'любого';
    const repeat = describeRepeat(when, type);
    switch (when.when) {
        case 'at_exact_time': return `${String(when.date ?? '').slice(0, 10).split('-').reverse().join('.')} в ${when.time}`;
        case 'every_day': return `Ежедневно в ${when.time}`;
        case 'every_week': return `Еженедельно, ${WEEK_DAYS[(when.week_day ?? 1) - 1]} в ${when.time}`;
        case 'every_month': return `Ежемесячно, ${when.day}-го в ${when.time}`;
        case 'every_year': return `Ежегодно, ${when.day} ${MONTHS[(when.month ?? 1) - 1]} в ${when.time}`;
        case 'tg_message_received': return `При ${dir} сообщении Telegram${repeat}`;
        case 'wa_message_received': return `При ${dir} сообщении WhatsApp${repeat}`;
        case 'email_received': return `При ${dir} письме${repeat}`;
        case 'call_recorded': return `При записи ${dirCall} звонка${repeat}`;
        case 'no_reply': return `Если клиент ждёт ответа ${Number(when.after_minutes ?? 0)} мин (рабочее время)${repeat}`;
        case 'right_away':
        case undefined:
        case null: {
            const m = Number(when.after_minutes ?? 0);
            if (!m) return `Сразу после создания или перехода в этап${repeat}`;
            const text = m % 1440 === 0 ? `${m / 1440} дн.` : m % 60 === 0 ? `${m / 60} ч` : `${m} мин`;
            return `Через ${text} после перехода в этап${repeat}`;
        }
        default: return `Условие «${when.when}»`;
    }
}

/** «, один раз для сделки» / «, не чаще раза в сутки»: the API's defaults when the trigger does not say. */
function describeRepeat(when: any, type?: TriggerType): string {
    const once = typeof when.once_per_deal === 'boolean' ? when.once_per_deal : type === TriggerType.CreateDeal;
    if (once) return ', один раз для сделки';
    const set = when.cooldown_minutes !== undefined && when.cooldown_minutes !== null;
    const m = set ? Number(when.cooldown_minutes) || 0 : type === TriggerType.SendEmail ? 1440 : 0;
    if (!m) return '';
    const text = m === 1440 ? 'сутки' : m % 1440 === 0 ? `${m / 1440} дн.` : m % 60 === 0 ? `${m / 60} ч` : `${m} мин`;
    return `, не чаще раза в ${text}`;
}

// failed runs of the last 7 days per trigger and what it names that is gone (GET /stages/:id/triggers):
// a trigger that does not work, or cannot, is seen here
const triggerHealth = ref<Record<number, { failed: number; last_error: string | null }>>({});
const triggerProblems = ref<Record<number, string[]>>({});
async function loadTriggerHealth() {
    const saved = (stages.value ?? []).filter((stage) => stage.id && stage.status !== 'new' && stage.triggers?.length);
    const answers = await Promise.all(saved.map((stage) => promiseResult(stagesService.get(`${stage.id}/triggers`).exec())));
    const health: Record<number, { failed: number; last_error: string | null }> = {};
    const problems: Record<number, string[]> = {};
    for (const answer of answers) {
        if (!answer.ok || !Array.isArray(answer.value)) continue;
        for (const trigger of answer.value as any[]) {
            if (trigger?.runs?.failed) health[trigger.id] = { failed: trigger.runs.failed, last_error: trigger.runs.last_error ?? null };
            if (Array.isArray(trigger?.problems) && trigger.problems.length) problems[trigger.id] = trigger.problems;
        }
    }
    triggerHealth.value = health;
    triggerProblems.value = problems;
    if (canEditTriggers.value) {
        const broken = await promiseResult(triggersService.get('broken').exec());
        brokenTriggers.value = broken.ok && Array.isArray(broken.value) ? (broken.value as BrokenTrigger[]) : [];
    }
}

type BrokenTrigger = { id: number; stage_id: number; stage: string; action: string; problems: string[] };
const brokenTriggers = ref<BrokenTrigger[]>([]);

// the names a trigger card shows: the stages of every pipeline, the letter templates of every employee
const { run: runAllStages, data: allStages } = useAsync<AnyStage[]>([]);
const { run: runTemplates, data: templates } = useAsync<{ id: number; name: string }[]>([]);

const TRIGGER_ICONS: Record<number, string> = {
    [TriggerType.CreateTask]: 'ph:plus-circle',
    [TriggerType.CreateDeal]: 'ph:currency-circle-dollar',
    [TriggerType.SendEmail]: 'ph:paper-plane',
    [TriggerType.CloseTasks]: 'ph:check-circle',
    [TriggerType.ChangeAgent]: 'ph:user-switch',
    [TriggerType.ChangeFields]: 'ph:note-pencil',
    [TriggerType.DeleteFiles]: 'ph:folder-simple-minus',
    [TriggerType.MoveStage]: 'ph:arrow-fat-right',
    [TriggerType.Notify]: 'ph:bell-ringing',
};
const triggerIcon = (type: number) => TRIGGER_ICONS[type] ?? 'ph:lightning';

const userName = (id: unknown) => users.value.data.find((u) => String(u.id) === String(id))?.username ?? `сотрудник №${id}`;
const stageName = (id: unknown) => allStages.value.find((s) => s.id === Number(id))?.name
    ?? (stages.value ?? []).find((s) => s.id === Number(id))?.name ?? `этап №${id}`;
const FIELD_NAMES: Record<string, string> = { agent_id: 'Ответственный', budget: 'Бюджет', label: 'Название', source: 'Источник сделки' };
const OP_NAMES: Record<string, string> = { eq: '=', ne: '≠', gt: '>', lt: '<', contains: 'содержит' };

/** What a trigger does, in one line of its card. */
function describeAction(trigger: StageTrigger): string {
    const data: any = trigger.data ?? {};
    const action = actionNames[trigger.type] ?? 'Действие';
    switch (trigger.type) {
        case TriggerType.CreateTask:
            return `${action}: «${data.label || 'Задача по триггеру'}»`;
        case TriggerType.ChangeAgent:
            return data.rotate_user_ids?.length > 1
                ? `${action}: по очереди — ${data.rotate_user_ids.map(userName).join(', ')}`
                : `${action}: ${data.agent_id ? userName(data.agent_id) : '—'}`;
        case TriggerType.ChangeFields:
            return `${action}: ${(data.fields ?? []).map((f: any) => `${f.is_filler ? f.label || f.field : FIELD_NAMES[f.field] ?? f.field} = ${!f.is_filler && f.field === 'agent_id' ? userName(f.value) : f.value}`).join(', ')}`;
        case TriggerType.CreateDeal:
            return `${action} в этапе «${stageName(data.stage_id)}»`;
        case TriggerType.MoveStage:
            return `${action} «${stageName(data.stage_id)}»`;
        case TriggerType.SendEmail: {
            const template = templates.value.find((t) => t.id === Number(data.template_id))?.name;
            const files = data.attach_extensions?.length ? ` + файлы ${data.attach_extensions.join(', ')}` : '';
            return `${action}${template ? `: «${template}»` : ''}${files}`;
        }
        case TriggerType.Notify: {
            const whom = data.user_id ? userName(data.user_id) : data.to === 'managers' ? 'руководителям' : data.to === 'both' ? 'ответственному и руководителям' : 'ответственному';
            return `${action} ${whom}: «${String(data.text ?? '').slice(0, 60)}»`;
        }
        case TriggerType.DeleteFiles: {
            const sources = (data.which_files ?? []).map((source: FileSource) => fileSourceMap[source]).filter(Boolean).join(', ');
            const size = data.from_bytes || data.till_bytes
                ? `, размер ${data.from_bytes ? `от ${formatBytes(data.from_bytes)}` : ''}${data.till_bytes ? ` до ${formatBytes(data.till_bytes)}` : ''}`
                : '';
            return `${action}${sources ? `: ${sources}` : ''}${data.with_extensions?.length ? ` (${data.with_extensions.join(', ')})` : ''}${size}`;
        }
        default:
            return action;
    }
}

/** The conditions of a trigger, short: «Бюджет > 500 и Источник сделки = Telegram». */
function describeConditions(trigger: StageTrigger): string {
    return (trigger.deal_filters ?? [])
        .map((f) => {
            const name = f.is_filler ? f.label || f.field : FIELD_NAMES[f.field] ?? f.field;
            const value = !f.is_filler && f.field === 'agent_id' ? userName(f.value)
                : !f.is_filler && f.field === 'source' ? sourceNames[String(f.value)] ?? f.value
                    : f.value;
            return `${name} ${OP_NAMES[f.op ?? 'eq'] ?? '='} ${value}`;
        })
        .join(' и ');
}

/** «Выше» / «ниже»: the triggers of a stage run in the order of the list. */
function moveTrigger(stage: CustomStage, index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= stage.triggers.length) return;
    const list = [...stage.triggers];
    [list[index], list[to]] = [list[to], list[index]];
    stage.triggers = list;
    renumber(stage);
}

function renumber(stage: CustomStage) {
    stage.triggers.forEach((trigger, i) => { trigger.position = i; });
    if (stage.status !== 'new') orderChanged.value.add(stage.id);
}

function scrollStages(direction: number) {
    const el = stageRefs.value?.targetDomElement as HTMLElement | undefined;
    el?.scrollBy({ left: direction * Math.max(240, el.clientWidth * 0.8), behavior: 'smooth' });
}

const activeCollection = computed(() => {
    return collections.value.find((c) => c.is_active);
});

// «Этап для новых сделок»: a working (not closing) saved stage of the active pipeline; admins change it
const currentUser = useState<User>('user');
const isAdmin = computed(() => currentUser.value?.role === 'admin');
// the triggers of a stage: admins and managers (руководитель продаж) build them, the others see them
const canEditTriggers = computed(() => currentUser.value?.role === 'admin' || currentUser.value?.role === 'manager');
const defaultStage = ref<Stage | null>(null);
const defaultStageSaving = ref(false);
const defaultStageOptions = computed(() => (stages.value || []).filter((stage: any) => !stage.is_closing && stage.status !== 'new'));
const selectedDefaultStage = computed(() => defaultStageOptions.value.find((stage) => stage.id === defaultStage.value?.id) ?? defaultStage.value);

async function fetchDefaultStage() {
    const result = await promiseResult(stagesService.get('default').exec());
    defaultStage.value = result.ok ? ((result.value as Stage | null) || null) : null;
}

async function onDefaultStageChange(stage: Stage | null) {
    if (!stage?.id || stage.id === defaultStage.value?.id) return;
    const previous = defaultStage.value;
    defaultStage.value = stage;
    defaultStageSaving.value = true;
    const result = await promiseResult(stagesService.patch('default', { stage_id: stage.id }).exec());
    defaultStageSaving.value = false;
    if (!result.ok) {
        defaultStage.value = previous;
        return toast.show({type: 'error', message: [result.error.message].flat().join('; '), timeout: 5000});
    }
    toast.show({type: 'success', message: `Новые сделки без выбранного этапа попадают в «${stage.name}»`, timeout: 3000});
}

function addStage(index: number) {
    let order = index === stages.value.length  ? index + 1 : index;
    stages.value.splice(index, 0, {
        name: '', 
        description: '', 
        order, 
        id: Math.floor(Math.random() * 99999999),
        status: 'new', 
        created_at: new Date().toISOString(),
        triggers: [],
        color: '#D5D8DB',
        collection_id: activeCollection.value?.id,
    });
    nextTick(() => {
        let item = stageRefs.value?.targetDomElement.children[index];
        if (!item) return;
        let editable = item.querySelector('.editable');
        if (editable) editable.focus();
    });
}

function onStageTriggerSelect(stage: CustomStage, stageTrigger: StageTrigger, position: number)  {
    currentStage.value = stage;
    // the form works on a copy: «Отменить» leaves the trigger as it was
    const copy = JSON.parse(JSON.stringify(stageTrigger)) as StageTrigger;
    copy.position = position;
    selected.value = { stage, trigger: toTrigger(copy) };
}

function deleteStage(id: number, status: string) {
    stages.value = stages.value.filter((stage) => stage.id !== id);
    if (status !== 'new') deleted.value.push(id);
}

function onNameChange(e: Event, stage: CustomStage) {
    let target = e.target as HTMLDivElement;
    names.value[stage.id] = target.innerText;
}

function openHintModal(stage: CustomStage){
    currentStage.value = stage;
    stageHintModal.open();
}

function openTriggerModal({stage, position}: {stage: CustomStage, position: number}) {
    currentStage.value = stage;
    stageTriggerModal.open({stage, position});
}

function onTriggerRemove(trigger: Trigger) {
    const stage = selected.value?.stage as CustomStage | undefined;
    selected.value = undefined;
    if (!stage) return;
    stage.triggers = stage.triggers.filter((t) => t.id !== trigger.id);
    renumber(stage);
    if (stage.status !== 'new' && trigger.status !== 'new' && trigger.id > 0) deletedTriggers.value.push(trigger.id, stage.id);
}

/**
 * «Сохранить»: the stages (the admin's), then each added or changed trigger on its own and the order of
 * the reordered stages. A trigger the API refuses (it names a dismissed employee, a deleted template)
 * does not keep the others from saving: the answer is the list of what was not saved, by trigger.
 */
async function onSave(formData: FormData): Promise<string[]> {
    const stageIds = isAdmin.value ? formData.getAll('stages') : [];
    const promises: Promise<unknown>[] = isAdmin.value ? deleted.value.map((id) => stagesService.remove(id).exec()) : [];

    for (let i = 0, len = deletedTriggers.value.length; i < len; i += 2) {
        const triggerId = deletedTriggers.value[i];
        const stageId = deletedTriggers.value[i + 1];
        promises.push(stagesService.remove(`${stageId}/triggers/${triggerId}`).exec());
    }

    const newStages: (() => Promise<void>)[] = [];

    for (const id of stageIds) {
        const status = formData.get(`stage.${id}.status`) ;
        const name = formData.get(`stage.${id}.name`);
        const order = Number(formData.get(`stage.${id}.order`) || 0);
        const color = formData.get(`stage.${id}.color`);
        const description = formData.get(`stage.${id}.description`) || null;
        const existing = stages.value.find((s: any) => s.id == id);
        if (status === 'new') newStages.push(
            () => stagesService.create<Stage>({ name, order, description, color, collection_id: activeCollection.value?.id }).exec().then((result) => {
                if (existing) existing.id = result.id;
            })
        );
        else promises.push(stagesService.patch(id as string, { name, order, description, color, collection_id: activeCollection.value?.id }).exec());
    }

    await Promise.all(promises);
    deleted.value = [];
    deletedTriggers.value = [];
    for (const createStage of newStages) await createStage();

    const failures: string[] = [];
    const errorText = (error: any) => [error?.message ?? String(error)].flat().join('; ');
    const triggerPromises: Promise<void>[] = [];
    // the stages as the page shows them: the form changes the triggers of these very objects
    const pageStages = sortedStages.value;
    for (const stage of pageStages) {
        for (const stageTrigger of stage.triggers) {
            const name = `«${actionNames[stageTrigger.type] ?? 'Триггер'}» этапа «${names.value[stage.id] || stage.name}»`;
            const fail = (error: any) => { failures.push(`${name}: ${errorText(error)}`); };
            // only what was added or changed: a PATCH of every trigger on each save used to void the
            // planned runs of all of them; a saved one is not sent again by the next «Сохранить»
            if (stageTrigger.status === 'new') {
                triggerPromises.push(stagesService.post(`/${stage.id}/triggers`, toTrigger(stageTrigger)).exec().then((created: any) => {
                    if (created?.id) stageTrigger.id = created.id;
                    stageTrigger.status = undefined;
                }, fail));
            } else if (stageTrigger.status === 'changed') {
                triggerPromises.push(stagesService.patch(`${stage.id}/triggers/${stageTrigger.id}`, toTrigger(stageTrigger)).exec().then(() => {
                    stageTrigger.status = undefined;
                }, fail));
            }
        }
    }
    await Promise.all(triggerPromises);

    // the order the triggers of a reordered stage run in (only the order: a broken trigger moves too)
    for (const stage of pageStages) {
        if (!orderChanged.value.has(stage.id) || stage.status === 'new') continue;
        const ids = stage.triggers.filter((t) => t.id > 0 && t.status !== 'new').map((t) => t.id);
        await stagesService.patch(`${stage.id}/trigger-order`, { ids }).exec().then(
            () => { orderChanged.value.delete(stage.id); },
            (error: any) => { failures.push(`Порядок триггеров этапа «${names.value[stage.id] || stage.name}»: ${errorText(error)}`); },
        );
    }
    return failures;
}


async function onCollectionCreate(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const name = formData.get('name') as string;
    const result = await promiseResult(runWithId(collectionService.create({name}).exec(), 'savingCollection'));
    if (!result.ok) return toast.show({type: 'error', message: result.error.message, timeout: 3000});
    collections.value.push(result.value as StageCollection);
    target.reset();
    resetKey.value++;
}

async function onCollectionDelete(id: number) {
    const result = await promiseResult(runWithId(collectionService.remove(id).exec(), 'removingCollection' + id));
    if (!result.ok) return toast.show({type: 'error', message: result.error.message, timeout: 3000});
    collections.value = collections.value.filter((c) => c.id !== id);
}

async function onUpdateCollection(collection: StageCollection) {
    const result = await promiseResult(runWithId(collectionService.patch(collection.id, {name: collection.name}).exec(), 'updatingCollection' + collection.id));
    if (!result.ok) return toast.show({type: 'error', message: result.error.message, timeout: 3000});
    editingCollection.value = undefined;
}

async function onActivate(id: number, close: Function) {
    collections.value = collections.value.map((c) => c.id === id ? ({...c, is_active: true}) : {...c, is_active: false});
    close();
    const result = await promiseResult(collectionService.patch(id + '/activate', {}).exec());
    if (!result.ok) return toast.show({type: 'error', message: result.error.message, timeout: 3000});
    reloadStages();
    // the stage for new deals moved to the new pipeline (the same name or «Неразобранное»)
    fetchDefaultStage();
}

async function onSubmit(e: Event) {
    if (!canEditTriggers.value) return;
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const result = await promiseResult(saveAsync(onSave(formData)));
    if (!result.ok) {
        toast.show({type: 'error', message: [result.error.message].flat().join('; '), timeout: 6000});
        deleted.value = [];
        deletedTriggers.value = [];
        reloadStages();
    }
    else if ((result.value as string[])?.length) {
        // the rest is saved; these triggers stay marked «Не сохранено» to be fixed
        toast.show({type: 'error', message: `Не сохранено: ${(result.value as string[]).join('; ')}`, timeout: 12000});
        void loadTriggerHealth();
    }
    else {
        const from = [route.query.from].flat()[0];
        if (from) router.push(from);
        else {
            toast.show({type: 'success', message: 'Сохранено', timeout: 3000});
            reloadStages();
        }
    }
}

function onTriggerSelected(data: SelectedTrigger) {
    selected.value = data;
}

function onStageHintUpdate(update: {id: string, description: string}) {
    // in place: a copy of the stage would leave its triggers behind
    const stage = sortedStages.value.find((s) => s.id == Number(update.id));
    if (stage) stage.description = update.description;
}

function onTriggerConfigured() {
    selected.value = undefined;
}

// the triggers of a stage in the order they run (position, then id)
const byPosition = (a: StageTrigger, b: StageTrigger) => (Number(a.position) || 0) - (Number(b.position) || 0) || a.id - b.id;

watch(stages, () => {
    for (let stage of stages.value) {
        names.value[stage.id] = stage.name;
        stage.triggers = [...(stage.triggers ?? [])].sort(byPosition);
    }
    // the same objects, not copies (a stage without a colour used to become a copy, and the triggers
    // added to it in the form were not the ones «Сохранить» sent)
    sortedStages.value = (stages.value?.sort((a, b) => a.order - b.order) || []).map((s) => {
        if (!s.color) s.color = colors[Math.floor(Math.random() * colors.length)] || '#D5D8DB';
        return s;
    });
    void loadTriggerHealth();
});

/** The stages as the API has them again: what was reordered locally is gone with the local state. */
function reloadStages() {
    orderChanged.value.clear();
    run(stagesService.find().exec());
}

onMounted(() => {
    run(stagesService.find().exec());
    runAllStages(triggersService.get('stages').exec());
    runTemplates(triggersService.get('email-templates').exec());
    runUsers(userService.find({limit: 1000}).exec());
    runFillers(fillerService.find().exec());
    runCollections(collectionService.find({limit: 1000}).exec());
    fetchDefaultStage();
});

</script>

<style scoped>
.ghost {
    opacity: 0.5;
}

.color-picker::-webkit-color-swatch-wrapper {
    padding: 0;
}

.color-picker::-webkit-color-swatch {
    border: none;
    border-radius: 999999px;
}
</style>