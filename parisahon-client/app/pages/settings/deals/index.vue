<template>
    <div class="flex flex-col space-y-8">
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-wrap items-center gap-3">
                <TairoPopover orientation="start" class="start-0 z-20">
                    <template #default="{open}">
                        <BaseButton :loading="collectionsLoading">
                            {{ activeCollection?.name || 'Воронка' }}
                            <Icon name="ph:caret-right" class="ms-3 transition-transform duration-300" :class="open ? 'rotate-90' : ''" />
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
                        Отменить
                    </BaseButton>
                </NuxtLink>
                <BaseButton color="primary" form="stage-form" type="submit" :disabled="saving">
                    Сохранить
                </BaseButton>
            </div>
        </div>
        <form method="post" @submit.prevent="onSubmit" id="stage-form" class="dark:bg-muted-800 bg-white">
            <BasePlaceload class="h-2 w-full" v-show="isLoading" />
            <Draggable v-bind="dragOptions" item-key="id" v-model="sortedStages" tag="ul" class="flex overflow-x-scroll" ref="stageRefs" handle=".drag-handle" v-dragscroll="{ excluded: ['drag-handle', 'trigger-dropdown'] }">
                <template #item="{ element: stage, index }: {element: CustomStage, index: number}">
                    <li :key="stage.id" :id="String(stage.id)" class="border border-slate-200 dark:border-slate-700 border-r-0 last:border-r-slate-200 relative shrink-0 basis-80">
                        <div class="flex items-center justify-between relative group text-sm bg-muted-50 dark:bg-muted-800 text-muted-700 dark:text-muted-400 text-left font-sans font-semibold tracking-wider py-1">
                            <button class="cursor-move ml-2 drag-handle" type="button">
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
                            <div contenteditable class="peer whitespace-nowrap w-full p-1 outline-none text-center editable" @input="(e) => onNameChange(e, stage)">
                                {{ stage.name }}
                            </div>
                            <button @click="() => deleteStage(stage.id, stage.status)" class="shrink-0 w-6 h-6 rounded-full opacity-0 scale-0 group-hover:scale-100 group-hover:opacity-100 peer-focus:scale-100 peer-focus:opacity-100 mr-1 duration-200 hover:bg-red-100 dark:hover:bg-red-400 flex items-center justify-center" type="button">
                                <Icon
                                    class="w-4 h-4 text-red-600 dark:text-white"
                                    name="ph:trash"
                                />
                            </button>
                            <input type="color" class="border-none rounded-full w-5 h-5 bg-none shrink-0 opacity-0 scale-0 group-hover:scale-100 group-hover:opacity-100 peer-focus:scale-100 peer-focus:opacity-100 mr-3 duration-200 color-picker" v-model="stage.color">
                            <button class="absolute -right-3 -bottom-3 bg-muted-200 w-6 h-6 rounded-full z-10 flex items-center justify-center text-muted-800 hover:bg-muted-300 duration-200 dark:bg-muted-700 dark:text-white" @click="() => addStage(index + 1)" type="button">
                                <Icon
                                    class="w-4 h-4 pointer-events-none"
                                    name="ph:plus"
                                />
                            </button>
                        </div>
                        <div class="w-full h-1" :style="{'backgroundColor': stage.color}"></div>
                        <button v-if="!!stage.id" class="font-alt whitespace-nowrap text-sm text-muted-800 dark:text-white p-4 text-center w-full underline hover:bg-muted-50 dark:hover:bg-muted-900" @click="() => openHintModal(stage)" type="button">
                            {{ stage.description ? "1 подсказка" : "Добавить подсказки" }}
                        </button>
                        <ul class="flex flex-col divide-y divide-muted-200 dark:divide-muted-700 border-t border-t-slate-200 dark:border-t-slate-700 trigger-columns">
                            <li class="w-full group hover:bg-muted-50 dark:hover:bg-muted-900 transition-colors duration-300 relative" v-for="(trigger, index) in getStageTriggers(stage)" :key="index">
                                <button v-if="trigger" class="py-2.5 px-1 min-h-16 flex gap-2 text-left w-full h-full" @click="() => onStageTriggerSelect(stage, trigger, index)" type="button">
                                    <Icon v-if="trigger.type === TriggerType.CreateTask" name="ph:plus-circle" class="size-8 text-primary-600 dark:text-primary-200 shrink-0" />
                                    <Icon v-if="trigger.type === TriggerType.ChangeAgent" name="ph:user-switch" class="size-8 text-primary-600 dark:text-primary-200 shrink-0" />
                                    <Icon v-if="trigger.type === TriggerType.DeleteFiles" name="ph:folder-simple-minus" class="size-8 text-primary-600 dark:text-primary-200 shrink-0" />
                                    <Icon v-if="trigger.type === TriggerType.ChangeFields" name="ph:note-pencil" class="size-8 text-primary-600 dark:text-primary-200 shrink-0" />
                                    <Icon v-if="trigger.type === TriggerType.CloseTasks" name="ph:check-circle" class="size-8 text-primary-600 dark:text-primary-200 shrink-0" />
                                    <Icon v-if="trigger.type === TriggerType.CreateDeal" name="ph:currency-circle-dollar" class="size-8 text-primary-600 dark:text-primary-200 shrink-0" />
                                    <Icon v-if="trigger.type === TriggerType.SendEmail" name="ph:paper-plane" class="size-8 text-primary-600 dark:text-primary-200 shrink-0" />
                                    <div class="flex flex-col">
                                        <span class="text-[13px] text-muted-600 dark:text-muted-200">{{ describeWhen(trigger.apply_when_data, trigger.type) }}</span>
                                        <span
                                            v-if="trigger.id && triggerHealth[trigger.id]"
                                            class="text-[12px] text-rose-600 dark:text-rose-400"
                                            :title="triggerHealth[trigger.id]?.last_error ?? ''"
                                        >
                                            <Icon name="ph:warning-circle" class="size-3.5 -mt-0.5" />
                                            Ошибок за 7 дней: {{ triggerHealth[trigger.id]?.failed }} — подробности в «Истории запусков»
                                        </span>
                                        <div class="text-sm font-semibold text-muted-900 dark:text-white">
                                            <p v-if="trigger.type === TriggerType.CreateTask">Создать задачу: </p>
                                            <p v-if="trigger.type === TriggerType.ChangeAgent">Сменить ответственного: </p>
                                            <p v-if="trigger.type === TriggerType.CloseTasks">Завершить задачи: </p>
                                            <div v-if="trigger.type === TriggerType.DeleteFiles">
                                                Удалить файлы: 
                                                <span class="font-normal text-[13px]">{{ trigger.data.which_files.map((source) => fileSourceMap[source]).join(', ') }}</span>
                                                <p class="font-normal text-[13px] text-blue-600" v-if="trigger.data.from_bytes || trigger.data.till_bytes">
                                                    Размер: 
                                                    <span v-if="trigger.data.from_bytes">
                                                        {{ !trigger.data.till_bytes ? 'От ' : '' }}
                                                        {{ formatBytes(trigger.data.from_bytes) }}
                                                    </span>
                                                    <span v-if="trigger.data.till_bytes"> - {{ formatBytes(trigger.data.till_bytes) }}</span>
                                                </p>
                                            </div>
                                            <div v-if="trigger.type === TriggerType.ChangeFields">
                                                <span>Изменить поле: </span>
                                                <ul>
                                                    <li v-for="field in trigger.data.fields">
                                                        <span>{{ field.label }}: </span>
                                                        <span>{{ field.value }}</span>
                                                    </li>
                                                </ul>
                                            </div>
                                            <p v-if="trigger.type === TriggerType.SendEmail">Отправить письмо: </p>
                                        </div>
                                    </div>
                                </button>
                                <button v-else class="text-sm opacity-0 scale-80 w-full min-h-16 px-4 group-hover:opacity-100 group-hover:scale-100 duration-200 text-muted-800 dark:text-white h-full" @click="() => openTriggerModal({stage, position: index})" type="button">
                                    <Icon
                                        name="ph:plus"
                                        class="mr-2"
                                    />
                                    Добивить триггер
                                </button>
                                <TriggerForm 
                                    v-if="selected?.stage.id === stage.id && selected?.trigger.position === index" 
                                    :stage="selected.stage" 
                                    :stages="stages"
                                    :trigger="selected.trigger" 
                                    :users="users.data"
                                    :fillers="fillers.deal ?? []"
                                    @done="onTriggerConfigured"
                                    @cancel="selected = undefined"
                                    @remove="onTriggerRemove"
                                />
                            </li>
                        </ul>
                    </li>
                </template>
            </Draggable>
        </form>
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
import {TriggerType} from '~/types/stage';
import type { User } from '~/types/user';
import {formatBytes} from '~/utils/byte';
import {promiseResult} from '~/utils/result';

import {toTrigger} from '~/components/trigger/trigger';
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

// failed runs of the last 7 days per trigger (GET /stages/:id/triggers): a trigger that does not work is seen here
const triggerHealth = ref<Record<number, { failed: number; last_error: string | null }>>({});
async function loadTriggerHealth() {
    const saved = (stages.value ?? []).filter((stage) => stage.id && stage.status !== 'new' && stage.triggers?.length);
    const answers = await Promise.all(saved.map((stage) => promiseResult(stagesService.get(`${stage.id}/triggers`).exec())));
    const health: Record<number, { failed: number; last_error: string | null }> = {};
    for (const answer of answers) {
        if (!answer.ok || !Array.isArray(answer.value)) continue;
        for (const trigger of answer.value as any[]) {
            if (trigger?.runs?.failed) health[trigger.id] = { failed: trigger.runs.failed, last_error: trigger.runs.last_error ?? null };
        }
    }
    triggerHealth.value = health;
}

const activeCollection = computed(() => {
    return collections.value.find((c) => c.is_active);
});

// «Этап для новых сделок»: a working (not closing) saved stage of the active pipeline; admins change it
const currentUser = useState<User>('user');
const isAdmin = computed(() => currentUser.value?.role === 'admin');
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

function getStageTriggers(stage: CustomStage) {
    const items = Array<StageTrigger | undefined>(15).fill(undefined);
    for (let i = 0, len = stage.triggers.length; i < len; i++) {
        const trigger = stage.triggers[i];
        items[i] = trigger;
    }

    return items;
}

function onStageTriggerSelect(stage: CustomStage, stageTrigger: StageTrigger, position: number)  {
    currentStage.value = stage;
    selected.value = { stage, trigger: toTrigger(Object.assign(stageTrigger, {position})) };
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
    const stage = currentStage.value;
    if (!stage) return;
    stage.triggers = stage.triggers.filter((t) => t.id !== trigger.id);
    if (stage.status === 'new') return;
    if (trigger.status !== 'new') deletedTriggers.value.push(trigger.id, stage.id);
    selected.value = undefined;
}

async function onSave(formData: FormData) {
    const stageIds = formData.getAll('stages');
    const promises = deleted.value.map((id) => stagesService.remove(id).exec());

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
    const triggerPromises = [];
    for (const stage of stages.value) {
        for (const stageTrigger of stage.triggers) {
            // only what was added or changed: a PATCH of every trigger on each save used to void the
            // planned runs of all of them; a saved one is not sent again by the next «Сохранить»
            if (stageTrigger.status === 'new') {
                triggerPromises.push(stagesService.post(`/${stage.id}/triggers`, toTrigger(stageTrigger)).exec().then((created: any) => {
                    if (created?.id) stageTrigger.id = created.id;
                    stageTrigger.status = undefined;
                }));
            } else if (stageTrigger.status === 'changed') {
                triggerPromises.push(stagesService.patch(`${stage.id}/triggers/${stageTrigger.id}`, toTrigger(stageTrigger)).exec().then(() => {
                    stageTrigger.status = undefined;
                }));
            }
        }
    }

    return await Promise.all(triggerPromises);
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
    run(stagesService.find().exec());
    // the stage for new deals moved to the new pipeline (the same name or «Неразобранное»)
    fetchDefaultStage();
}

async function onSubmit(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const result = await promiseResult(saveAsync(onSave(formData)));
    if (!result.ok) {
        toast.show({type: 'error', message: [result.error.message].flat().join('; '), timeout: 6000});
        deleted.value = [];
        deletedTriggers.value = [];
        run(stagesService.find().exec());
    }
    else {
        const from = [route.query.from].flat()[0];
        if (from) router.push(from);
    }
}

function onTriggerSelected(data: SelectedTrigger) {
    selected.value = data;
}

function onStageHintUpdate(update: {id: string, description: string}) {
    sortedStages.value = sortedStages.value.map((stage) => stage.id == Number(update.id) ? ({...stage, description: update.description }) : stage);
}

// HACK: absolutely trash way to adjust heights, but can't figure how to do that without this 
// and make drag and drop work correctly right now.
const TRIGGER_PADDING = 10;
function adjustColumnHeights() {
    const triggerColumns = stageRefs.value?.targetDomElement.querySelectorAll('.trigger-columns');
    if (!triggerColumns.length) return;
    const ylen = triggerColumns[0].children.length;
    const xlen = triggerColumns.length;
    for (let i = 0; i < ylen; i++) {
        let tallest = 0;
        for (let j = 0; j < xlen; j++) {
            tallest = Math.max(triggerColumns[j].children[i].scrollHeight, tallest);
        }
        for (let j = 0; j < xlen; j++) {
            const overflowing = triggerColumns[j].children[i].offsetHeight < triggerColumns[j].children[i].scrollHeight;
            if (overflowing) tallest += TRIGGER_PADDING;
            triggerColumns[j].children[i].style.height = tallest + 'px';
        }
    }
}

function onTriggerConfigured() {
    nextTick(adjustColumnHeights);
    selected.value = undefined;
}

watch(stages, () => {
    for (let stage of stages.value) {
        names.value[stage.id] = stage.name;
    }
    sortedStages.value = (stages.value?.sort((a, b) => a.order - b.order) || []).map((s) => !s.color ? ({...s, color: colors[Math.floor(Math.random() * colors.length)] || '#D5D8DB'}) : s);
    nextTick(adjustColumnHeights);
    void loadTriggerHealth();
});

onMounted(() => {
    run(stagesService.find().exec());
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