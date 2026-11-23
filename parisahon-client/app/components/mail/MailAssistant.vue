<template>
    <div>
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
    </div>
</template>

<script lang="ts" setup>
/**
 * The writing assistant of a letter (POST /emails/assist): check, rewrite, translate (English,
 * Russian, Uzbek), a letter from notes, and an answer to the client — from the deal's
 * correspondence (e-mails included) or to the letter being answered (Mail).
 * The signature is not in the text: the server adds it when the letter is sent.
 */
type AssistAction = 'check' | 'polite' | 'shorter' | 'english' | 'russian' | 'uzbek' | 'draft' | 'reply';
type AssistIssue = { kind: 'spelling' | 'meaning' | 'tone'; message: string; from?: string; to?: string };

const body = defineModel<string>('body', { default: '' });
const subject = defineModel<string>('subject', { default: '' });
const props = withDefaults(defineProps<{
    dealId?: number;
    replyToEmailId?: number;
}>(), {
    dealId: undefined,
    replyToEmailId: undefined,
});

const mailService = useService('emails', { auth: true });
const toast = useToast('GlobalToast');

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
    { action: 'russian' as const, label: 'На русский' },
    { action: 'uzbek' as const, label: 'На узбекский' },
    { action: 'draft' as const, label: 'Письмо по заметкам' },
    ...(props.dealId || props.replyToEmailId ? [{ action: 'reply' as const, label: 'Ответ клиенту' }] : []),
]);
const assisting = ref<AssistAction | null>(null);
const assistIssues = ref<AssistIssue[]>([]);
const assistSummary = ref('');

/** The editor's HTML as plain text (DOMParser runs no scripts). */
function letterText(): string {
    const html = body.value || '';
    const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n'), 'text/html');
    return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function escapeText(text: string): string {
    return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** Plain text back into the editor, as paragraphs. */
function setLetter(text: string) {
    body.value = text.split(/\n{2,}/).map((p) => `<p>${escapeText(p).replace(/\n/g, '<br>')}</p>`).join('');
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
        reply_to_email_id: props.replyToEmailId,
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
</script>
