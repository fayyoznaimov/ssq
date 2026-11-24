<script setup lang="ts">
// «Отправить письмо»: a template of any employee (GET /triggers/email-templates) with the data of the deal
// in its placeholders, from the sender's own mailbox when it is connected, else from the shared one, with
// the deal's files of the given types attached (the КП uploaded to the deal).
import { type SendEmailTrigger,type Trigger } from '~/types/stage';
import type { User } from '~/types/user';
import { placeholderHint } from './trigger';

type TemplateItem = { id: number; name: string; subject: string; owner: string | null; label?: string };

const props = defineProps<{
  trigger: Trigger & SendEmailTrigger;
  employees?: User[];
}>();

const recipients = computed(() => [
    { label: 'Контактам сделки', id: 0 },
    ...(props.employees ?? []).map((e) => ({ label: e.username, id: e.id })),
]);
const recipient = ref(recipients.value.find((r) => r.id === (props.trigger.send_email_data.send_to_user_id ?? 0)) ?? recipients.value[0]);
watch(recipient, () => {
    props.trigger.send_email_data.send_to_user_id = recipient.value.id || null;
});

// the deal's files that go with the letter, by type: «pdf, xlsx»; empty = no attachments
const attach = ref((props.trigger.send_email_data.attach_extensions ?? []).map((ext) => ext.replace(/^[.]/, '')).join(', '));
watch(attach, () => {
    props.trigger.send_email_data.attach_extensions = String(attach.value ?? '')
        .split(/[\s,;]+/)
        .map((ext) => ext.trim().replace(/^[.]+/, '').toLowerCase())
        .filter(Boolean);
}, { immediate: true });

const senders = [
    { id: 'currently_assigned', label: 'От ответственного за сделку' },
    { id: 'creator', label: 'От создателя сделки' },
];
const sender = ref(senders.find((s) => s.id === (props.trigger.send_email_data.from ?? 'currently_assigned')) ?? senders[0]);
const shared = ref(!!props.trigger.send_email_data.shared_mailbox);
watch([sender, shared], () => {
    props.trigger.send_email_data.from = sender.value.id as 'currently_assigned' | 'creator';
    props.trigger.send_email_data.shared_mailbox = shared.value;
}, { immediate: true });

const triggersService = useService('triggers', {auth: true});
const { isLoading: templatesLoading, run: runTemplates, data: templates } = useAsync<TemplateItem[]>([]);
const items = computed(() => templates.value.map((t) => ({ ...t, label: t.owner ? `${t.name} (${t.owner})` : t.name })));
const template = ref<TemplateItem>();
watch([template], () => {
    if (template.value) props.trigger.send_email_data.template_id = template.value.id;
});
watchEffect(() => {
    if (!template.value && items.value.length) {
        template.value = items.value.find((t) => t.id === props.trigger.send_email_data.template_id);
    }
});

onMounted(() => {
    runTemplates(triggersService.get('email-templates').exec());
});

</script>
<template>
    <section class="px-3 pb-3 flex flex-col gap-3 pr-[3.25rem]">
        <BaseListbox
            v-model="template"
            :items="items"
            :properties="{value: 'id', label: 'label'}"
            name="template"
            required
            placeholder="Выберите шаблон письма"
            :loading="templatesLoading"
        />
        <BaseListbox
            v-model="recipient"
            :items="recipients"
            :properties="{value: 'id', label: 'label'}"
            placeholder="Кому"
            name="recipient"
        />
        <BaseListbox
            v-model="sender"
            :items="senders"
            :properties="{value: 'id', label: 'label'}"
            name="sender"
        />
        <BaseCheckbox v-model="shared" label="Всегда с общего ящика компании" />
        <BaseInput
            v-model="attach"
            name="attach_extensions"
            label="Приложить файлы сделки этих типов"
            placeholder="например: pdf, xlsx (пусто — без вложений)"
        />
        <p class="text-xs text-muted-500">
            Письмо уходит с личного ящика отправителя, если он подключён в CRM (ответ клиента придёт ему), иначе — с общего.
            В шаблоне можно использовать: {{ placeholderHint }}.
            Вложения — самые новые файлы сделки указанных типов (до 5); если такого файла в сделке нет, письмо не уйдёт,
            а в истории сделки появится запись «Автоматика не сработала».
        </p>
    </section>
</template>
