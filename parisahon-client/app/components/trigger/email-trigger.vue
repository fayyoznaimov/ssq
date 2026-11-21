<script setup lang="ts">
import type { Template } from '~/types/mail';
import { type SendEmailTrigger,type Trigger } from '~/types/stage';
import type { User } from '~/types/user';

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

const templateService = useService('emails/templates', {auth: true});
const { isLoading: templatesLoading, run: runTemplates, data: templates } = useAsync<Template[]>([]);
const template = ref<Template>();
watch([template], () => {
    if (template.value) props.trigger.send_email_data.template_id = template.value.id;
});
watchEffect(() => {
    if (!template.value && templates.value.length) {
        template.value = templates.value.find((t) => t.id === props.trigger.send_email_data.template_id);
    }
});

onMounted(() => {
    runTemplates(templateService.find().exec());
});

</script>
<template>
    <section class="px-3 pb-3 flex flex-col gap-3 pr-[3.25rem]">
        <BaseListbox 
            v-model="template"
            :items="templates"
            :properties="{value: 'id', label: 'name'}"
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
    </section>
</template>