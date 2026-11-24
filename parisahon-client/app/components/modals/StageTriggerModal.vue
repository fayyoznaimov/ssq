<template>
    <Modal :id="props.id" size="2xl" @shown="onShown">
        <template #header>
            <div class="flex">
                <h2>
                    Добавить триггер
                </h2>
            </div>
        </template>
        <form class="flex flex-col space-y-6" id="stage-trigger-modal" @submit.prevent="onSubmit">
            <ul class="grid grid-cols-3 xs:grid-cols-2 gap-3">
                <li class="bg-muted-100 p-3 rounded-md flex flex-col gap-3 dark:bg-muted-700">
                    <div class="bg-muted-200 w-14 h-14 rounded-full flex items-center justify-center text-muted-900 dark:bg-muted-800 dark:text-white">
                        <Icon name="ph:plus-circle" class="size-7"/>
                    </div>
                    <BaseButton name="_action" :value="TriggerType.CreateTask" type="submit">
                        <Icon name="ph:plus" class="me-2"/>
                        Создать задачу
                    </BaseButton>
                </li>
                <li class="bg-muted-100 p-3 rounded-md flex flex-col gap-3 dark:bg-muted-700">
                    <div class="bg-muted-200 w-14 h-14 rounded-full flex items-center justify-center text-muted-900 dark:bg-muted-800 dark:text-white">
                        <Icon name="ph:currency-circle-dollar" class="size-7"/>
                    </div>
                    <BaseButton name="_action" :value="TriggerType.CreateDeal" type="submit">
                        <Icon name="ph:plus" class="me-2"/>
                        Создать сделку
                    </BaseButton>
                </li>
                <li class="bg-muted-100 p-3 rounded-md flex flex-col gap-3 dark:bg-muted-700">
                    <div class="bg-muted-200 w-14 h-14 rounded-full flex items-center justify-center text-muted-900 dark:bg-muted-800 dark:text-white">
                        <Icon name="ph:paper-plane" class="size-7"/>
                    </div>
                    <BaseButton name="_action" :value="TriggerType.SendEmail" type="submit">
                        <Icon name="ph:plus" class="me-2"/>
                        Отправить письмо
                    </BaseButton>
                </li>
                <li class="bg-muted-100 p-3 rounded-md flex flex-col gap-3 dark:bg-muted-700">
                    <div class="bg-muted-200 w-14 h-14 rounded-full flex items-center justify-center text-muted-900 dark:bg-muted-800 dark:text-white">
                        <Icon name="ph:check-circle" class="size-7"/>
                    </div>
                    <BaseButton name="_action" :value="TriggerType.CloseTasks" type="submit">
                        <Icon name="ph:plus" class="me-2"/>
                        Завершить задачи
                    </BaseButton>
                </li>
                <li class="bg-muted-100 p-3 rounded-md flex flex-col gap-3 dark:bg-muted-700">
                    <div class="bg-muted-200 w-14 h-14 rounded-full flex items-center justify-center text-muted-900 dark:bg-muted-800 dark:text-white">
                        <Icon name="ph:user-switch" class="size-7"/>
                    </div>
                    <BaseButton class="!px-0" name="_action" :value="TriggerType.ChangeAgent" type="submit">
                        <Icon name="ph:plus" class="me-2"/>
                        Сменить ответственного
                    </BaseButton>
                </li>
                <li class="bg-muted-100 p-3 rounded-md flex flex-col gap-3 dark:bg-muted-700">
                    <div class="bg-muted-200 w-14 h-14 rounded-full flex items-center justify-center text-muted-900 dark:bg-muted-800 dark:text-white">
                        <Icon name="ph:note-pencil" class="size-7"/>
                    </div>
                    <BaseButton class="!px-0" name="_action" :value="TriggerType.ChangeFields" type="submit">
                        <Icon name="ph:plus" class="me-2"/>
                        Изменить поле
                    </BaseButton>
                </li>
                <li class="bg-muted-100 p-3 rounded-md flex flex-col gap-3 dark:bg-muted-700">
                    <div class="bg-muted-200 w-14 h-14 rounded-full flex items-center justify-center text-muted-900 dark:bg-muted-800 dark:text-white">
                        <Icon name="ph:folder-simple-minus" class="size-7"/>
                    </div>
                    <BaseButton class="!px-0" name="_action" :value="TriggerType.DeleteFiles" type="submit">
                        <Icon name="ph:plus" class="me-2"/>
                        Удалить файлы
                    </BaseButton>
                </li>
                <li class="bg-muted-100 p-3 rounded-md flex flex-col gap-3 dark:bg-muted-700">
                    <div class="bg-muted-200 w-14 h-14 rounded-full flex items-center justify-center text-muted-900 dark:bg-muted-800 dark:text-white">
                        <Icon name="ph:arrow-fat-right" class="size-7"/>
                    </div>
                    <BaseButton class="!px-0" name="_action" :value="TriggerType.MoveStage" type="submit">
                        <Icon name="ph:plus" class="me-2"/>
                        Перевести в этап
                    </BaseButton>
                </li>
                <li class="bg-muted-100 p-3 rounded-md flex flex-col gap-3 dark:bg-muted-700">
                    <div class="bg-muted-200 w-14 h-14 rounded-full flex items-center justify-center text-muted-900 dark:bg-muted-800 dark:text-white">
                        <Icon name="ph:bell-ringing" class="size-7"/>
                    </div>
                    <BaseButton class="!px-0" name="_action" :value="TriggerType.Notify" type="submit">
                        <Icon name="ph:plus" class="me-2"/>
                        Уведомить
                    </BaseButton>
                </li>
            </ul>
        </form>
    </Modal>
</template>

<script lang="ts" setup>
import Modal from '~/components/common/Modal.vue';
import { type Stage,type Trigger, type Triggers, TriggerType } from '~/types/stage';

const props = defineProps<{ id: string }>();
const data = ref<Partial<{position: number, stage: Stage, trigger: Trigger}>>({
    position: 0,
});

const emits = defineEmits<{
    (e: 'selected', data: {stage: Stage, trigger: Trigger}): void,
}>();

let fakeId = -1;
const modal = useModal(props.id);

function onShown({position, stage}: {position: number, stage: Stage})  {
    data.value.position = position;
    data.value.stage = stage;
}

function onSubmit(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target, (e as Event & {submitter: HTMLElement}).submitter);
    const action = Number(formData.get('_action'));

    let triggers: Triggers = {
        type: TriggerType.CreateDeal,
        create_deal_data: {}
    };
    switch(action) {
        case TriggerType.ChangeAgent: {
            triggers = {
                type: TriggerType.ChangeAgent,
                change_agent_data: {
                    agent_id: 0,
                    rotate_user_ids: [],
                    transfer_tasks: true,
                }
            };
        } break;
        case TriggerType.CreateTask: {
            triggers = {
                type: TriggerType.CreateTask,
                create_task_data: {
                    label: '',
                    end_time_in_minutes: 0,
                    type_id: 0,
                    all_day: false,
                    responsible: {
                        user: ''
                    }
                }
            };
        } break;
        case TriggerType.ChangeFields: {
            triggers = {
                type: TriggerType.ChangeFields,
                change_fields_data: {
                    fields: []
                }
            };
        } break;
        case TriggerType.DeleteFiles: {
            triggers = {
                type: TriggerType.DeleteFiles,
                delete_files_data: {
                    with_extensions: [],
                    which_files: [],
                }
            };
        } break;
        case TriggerType.CloseTasks: {
            triggers = {
                type: TriggerType.CloseTasks,
                close_tasks_data: {
                    result: '',
                    type_id: 0,
                    with_task_end_times: []
                }
            };
        } break;
        case TriggerType.SendEmail: {
            triggers = {
                type: TriggerType.SendEmail,
                send_email_data: {
                    send_to_user_id: null,
                    template_id: 0,
                    from: 'currently_assigned'
                }
            };
        } break;
        case TriggerType.CreateDeal: {
            triggers = {
                type: TriggerType.CreateDeal,
                create_deal_data: { stage_id: undefined, label: '', copy_fields: true, copy_products: true }
            };
        } break;
        case TriggerType.MoveStage: {
            triggers = {
                type: TriggerType.MoveStage,
                move_stage_data: { stage_id: undefined }
            };
        } break;
        case TriggerType.Notify: {
            triggers = {
                type: TriggerType.Notify,
                notify_data: { text: '', to: 'responsible', user_id: null }
            };
        } break;
        default:
            console.error('Unhanlded trigger type: ', action);
            break;
    }

    emits('selected', {
        stage: data.value.stage!,
        trigger: {
            id: --fakeId,
            ...triggers,
            position: data.value.position || 0,
            deal_filters: [],
            apply_when: {
                when: 'right_away',
                after_minutes: 0
            }
        }
    });
    modal.close();
}
</script>
