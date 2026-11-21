import { type StageTrigger, type StageTriggers, type Trigger, type Triggers,TriggerType } from '~/types/stage';

export function toStageTrigger(tr: Trigger): StageTrigger {
    let trigger: StageTriggers = {
        type: TriggerType.CreateDeal,
        data: {}
    };

    switch (tr.type) {
        case TriggerType.ChangeAgent: trigger = {type: TriggerType.ChangeAgent, data: tr.change_agent_data}; break;
        case TriggerType.ChangeFields: trigger = {type: TriggerType.ChangeFields, data: tr.change_fields_data}; break;
        case TriggerType.CloseTasks: trigger = {type: TriggerType.CloseTasks, data: tr.close_tasks_data}; break;
        case TriggerType.CreateDeal: trigger = {type: TriggerType.CreateDeal, data: tr.create_deal_data}; break;
        case TriggerType.CreateTask: trigger = {type: TriggerType.CreateTask, data: tr.create_task_data}; break;
        case TriggerType.DeleteFiles: trigger = {type: TriggerType.DeleteFiles, data: tr.delete_files_data}; break;
        case TriggerType.SendEmail: trigger = {type: TriggerType.SendEmail, data: tr.send_email_data}; break;
        default:
            break;
    }

    return {
        id: tr.id,
        position: tr.position,
        apply_when: tr.apply_when.when,
        apply_when_data: tr.apply_when,
        is_delayed: false,
        is_recurring: false,
        deal_filters: tr.deal_filters ?? [],
        status: tr.status,
        ...trigger
    };
}

export function toTrigger(base: StageTrigger): Trigger {
    let trigger: Triggers = {
        type: TriggerType.CreateDeal,
        create_deal_data: {}
    };

    switch (base.type) {
        case TriggerType.ChangeAgent: trigger = {type: TriggerType.ChangeAgent, change_agent_data: base.data}; break;
        case TriggerType.ChangeFields: trigger = {type: TriggerType.ChangeFields, change_fields_data: base.data}; break;
        case TriggerType.CloseTasks: trigger = {type: TriggerType.CloseTasks, close_tasks_data: base.data}; break;
        case TriggerType.CreateDeal: trigger = {type: TriggerType.CreateDeal, create_deal_data: base.data}; break;
        case TriggerType.CreateTask: trigger = {type: TriggerType.CreateTask, create_task_data: base.data}; break;
        case TriggerType.DeleteFiles: trigger = {type: TriggerType.DeleteFiles, delete_files_data: base.data}; break;
        case TriggerType.SendEmail: trigger = {type: TriggerType.SendEmail, send_email_data: base.data}; break;
        default:
            break;
    }

    return {
        id: base.id, 
        position: base.position, 
        apply_when: base.apply_when_data, 
        deal_filters: base.deal_filters, 
        status: base.status,
        ...trigger
    };
}