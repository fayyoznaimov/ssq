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
                <div class="flex flex-wrap items-center gap-2 px-2.5 py-2 border-t border-t-muted-200 dark:border-t-muted-700">
                    <span class="text-xs text-muted-500 dark:text-muted-300">Помощник:</span>
                    <BaseButton
                        v-for="item of assistActions"
                        :key="item.action"
                        size="sm"
                        variant="pastel"
                        :color="item.action === 'check' ? 'primary' : 'default'"
                        :loading="assisting === item.action"
                        :disabled="!!assisting"
                        @click="onAssist(item.action)"
                    >
                        {{ item.label }}
                    </BaseButton>
                </div>
                <div
                    v-if="assistIssues.length || assistSummary"
                    class="mx-2.5 mb-2.5 flex flex-col gap-2 rounded-md border border-muted-200 p-3 text-sm dark:border-muted-700"
                >
                    <div v-for="(issue, index) of assistIssues" :key="index" class="flex flex-wrap items-start gap-2">
                        <span class="font-semibold" :class="ISSUE_KINDS[issue.kind].class">{{ ISSUE_KINDS[issue.kind].label }}</span>
                        <span class="flex-1 text-muted-700 dark:text-muted-200">{{ issue.message }}</span>
                        <BaseButton v-if="issue.from && issue.to" size="sm" variant="pastel" @click="applyFix(index)">
                            Исправить
                        </BaseButton>
                    </div>
                    <div v-if="assistSummary" class="text-muted-500 dark:text-muted-400">{{ assistSummary }}</div>
                    <div class="text-xs text-muted-400">Помощник только предлагает: письмо отправляете вы.</div>
                </div>
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
    dealId?: number;
}>(), {
    replyOptions: () => [],
    dealId: undefined,
});

// --- writing assistant (POST /emails/assist) ---
type AssistAction = 'check' | 'polite' | 'shorter' | 'english' | 'draft' | 'reply';
type AssistIssue = { kind: 'spelling' | 'meaning' | 'tone'; message: string; from?: string; to?: string };
const ISSUE_KINDS = {
    spelling: { label: 'Орфография', class: 'text-orange-500' },
    meaning: { label: 'Смысл', class: 'text-orange-500' },
    tone: { label: 'Тон', class: 'text-primary-500' },
};
const assistActions = computed(() => [
    { action: 'check' as const, label: 'Проверить' },
    { action: 'polite' as const, label: 'Вежливее' },
    { action: 'shorter' as const, label: 'Короче' },
    { action: 'english' as const, label: 'На английский' },
    { action: 'draft' as const, label: 'Письмо по заметкам' },
    ...(props.dealId ? [{ action: 'reply' as const, label: 'Ответ клиенту' }] : []),
]);
const assisting = ref<AssistAction | null>(null);
const assistIssues = ref<AssistIssue[]>([]);
const assistSummary = ref('');

/** The editor's HTML without the signature, as plain text (DOMParser runs no scripts). */
function letterText(): string {
    let html = body.value || '';
    const sign = signature.value?.sign;
    if (sign && html.includes(sign)) html = html.replace(sign, '');
    const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n'), 'text/html');
    return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function escapeText(text: string): string {
    return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** Plain text back into the editor: paragraphs, then the signature. */
function setLetter(text: string) {
    const html = text.split(/\n{2,}/).map((p) => `<p>${escapeText(p).replace(/\n/g, '<br>')}</p>`).join('');
    body.value = html + (signature.value?.sign ? `<br>${signature.value.sign}` : '');
}

async function onAssist(action: AssistAction) {
    assisting.value = action;
    assistIssues.value = [];
    assistSummary.value = '';
    const result = await promiseResult(mailService.post('assist', {
        action,
        subject: subject.value || undefined,
        body: letterText() || undefined,
        deal_id: props.dealId,
    }).exec());
    assisting.value = null;
    if (!result.ok) return toast.show({ message: result.error.message, type: 'error', timeout: 4000 });
    const data: any = result.value;
    if (action === 'check') {
        assistIssues.value = data.issues ?? [];
        assistSummary.value = data.issues?.length ? data.summary : 'Замечаний нет.';
        return;
    }
    if (data.text) setLetter(data.text);
    if (data.subject && !subject.value) subject.value = data.subject;
}

function applyFix(index: number) {
    const issue = assistIssues.value[index];
    if (!issue?.from || issue.to === undefined) return;
    if (body.value.includes(issue.from)) body.value = body.value.replace(issue.from, escapeText(issue.to));
    assistIssues.value.splice(index, 1);
}
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