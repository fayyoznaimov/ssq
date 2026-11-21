<template>
    <form class="rounded-md bg-white pb-2.5" @submit.prevent="onSend">
        <details ref="detailsRef" class="group">
            <summary class="p-2.5 text-sm group-open:hidden">
                <span class="text-muted-500 dark:text-muted-300">Email для: </span>
                <select v-if="props.replyOptions.length > 1" name="to[]" class="outline-none bg-transparent appearance-none" v-model="to" disabled>
                    <option v-for="email of props.replyOptions" :value="email">
                        {{ email }}
                    </option>
                </select>
                <template v-else-if="props.replyOptions.length === 1">
                    <span class="text-muted-900 dark:text-white">{{ props.replyOptions[0] }}</span>
                    <input type="hidden" name="to[]" v-model="props.replyOptions[0]" disabled>
                </template>
                <input v-else name="to[]" disabled/>
            </summary>
            <div class="text-sm" v-bind="$attrs">
                <ul class="border-b border-b-muted-200 dark:border-b-muted-700">
                    <li class="p-2.5 text-sm">
                        <span class="text-muted-500 dark:text-muted-300">Email для: </span>
                        <select v-if="props.replyOptions.length > 1" name="to[]" class="outline-none bg-transparent" v-model="to">
                            <option v-for="email of props.replyOptions" :value="email" :selected="email === to">
                                {{ email }}
                            </option>
                        </select>
                        <template v-else-if="props.replyOptions.length === 1">
                            <span class="text-muted-900 dark:text-white">{{ props.replyOptions[0] }}</span>
                            <input type="hidden" name="to[]" v-model="props.replyOptions[0]">
                        </template>
                        <input v-else name="to[]" />
                    </li>
                    <li class="flex items-center space-x-2 px-2.5 border-t border-t-muted-200 dark:border-t-muted-700">
                        <label class="text-muted-500 dark:text-muted-300" for="cc">Копия: </label>
                        <input id="cc" class="outline-none py-2 text-muted-900 w-full bg-transparent dark:text-white" name="cc[]" />
                    </li>
                    <li class="flex items-center space-x-2 px-2.5 border-t border-t-muted-200 dark:border-t-muted-700">
                        <label class="text-muted-500 dark:text-muted-300" for="subject">Тема: </label>
                        <input id="subject" class="outline-none py-2 text-muted-900 w-full bg-transparent dark:text-white" v-model="subject" name="subject" />
                    </li>
                    <li class="flex items-center px-2.5 border-t border-t-muted-200 dark:border-t-muted-700">
                        <label class="text-muted-500 dark:text-muted-300" for="subject">От: </label>
                        <select id="subject" class="p-2 outline-none text-muted-900 appearance-none w-full bg-transparent dark:text-white dark:bg-muted-800" name="transporter_id">
                            <option v-for="transporter in transporters" :value="transporter.id">
                                {{ transporter.email }}
                            </option>
                        </select>
                    </li>
                    <li class="flex items-center px-2.5 border-t border-t-muted-200 dark:border-t-muted-700" v-if="!templatesLoading && templates.length">
                        <label class="text-muted-500 dark:text-muted-300" for="subject">Шаблон: </label>
                        <select class="p-2 outline-none text-muted-900 appearance-none w-full bg-transparent dark:text-white dark:bg-muted-800" @change="onTemplateChange">
                            <option value="">...</option>
                            <option :value="template.id" v-for="template in templates">
                                {{ template.name }}
                            </option>
                        </select>
                    </li>
                </ul>
                <Editor v-model="body" />
                <div class="flex gap-2">
                    <BaseButton color="primary" type="submit" class="ml-2.5" :disabled="sending">Отправить</BaseButton>
                    <BaseButton variant="pastel" @click="toggleEditor">Отменить</BaseButton>
                </div>
            </div>
        </details>
    </form>
</template>
<script lang="ts" setup>
import type { Signature, Template, Transporter } from '~/types/mail';
import Editor from '~/components/common/Editor.vue';
import type { User } from '~/types/user';

const detailsRef = ref();
const body = defineModel('body', {default: ''})
const subject = defineModel('subject', {default: ''})
const to = defineModel('to', {default: ''});
const mailService = useService('emails', {auth: true});
const toast = useToast('GlobalToast');
const templateService = useService('emails/templates', {auth: true});
const transporterService = useService('emails/transporters', {auth: true});
const signatureService = useService('emails/signs', {auth: true});
const emits = defineEmits(['canceled', 'sent']);
const props = withDefaults(defineProps<{
    replyOptions: string[];
}>(), {
    replyOptions: () => []
});
const { runAsync, isLoading: sending } = useAsync();

const { data: templates, isLoading: templatesLoading, run: runTemplates } = useAsync<Template[]>([]);
const { data: transporters, run: runTransporters } = useAsync<Transporter[]>([]);
const { data: signature, run: runSignature } = useAsync<Signature>();

const user = useState<User>('user');
let lastTemplate: Template;

function onTemplateChange(e: Event) {
    const target = e.target as HTMLFormElement;
    const template = templates.value.find((t) => t.id === Number(target.value));
    // let body = emailBody.value;
    // if (lastTemplate.value) body = body.slice(lastTemplate.value.template_body.length);
    if (template) {
        body.value = template.template_body + body.value;
        subject.value = template.subject;
        lastTemplate = template;
    } 
}

async function onSend(e: Event) {
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    const cc = formData.get('cc[]');
    if (!cc) formData.delete('cc[]');
    formData.append('body', body.value);
    const result = await promiseResult(runAsync(mailService.create(formData).exec()));
    if (!result.ok) return toast.show({message: result.error.message, type: 'error', timeout: 3000});
    toast.show({message: 'Письмо отправлено', type: 'success', timeout: 3000});
    target.reset();
    emits('sent')
}

function toggleEditor() {
    detailsRef.value.removeAttribute('open');
}

watchEffect(() => {
    if (signature.value?.sign) {
        body.value = `<br>${signature.value.sign}`;
    }
});

onMounted(() => {
    runTemplates(templateService.find().exec());
    runTransporters(transporterService.find().exec());
    runSignature(signatureService.get(user.value.id).exec());
});
</script>