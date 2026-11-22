<script setup lang="ts">
import DOMPurify from 'dompurify';

/**
 * The company e-mail signature (setting.mail_signature): one template for everybody, with the
 * manager's name, phone and e-mail filled in. A manager with a signature of their own keeps it.
 */
definePageMeta({
    authRoute: true,
    layout: 'account',
    verbose: 'Подпись в письмах'
});

useHead({
    title: 'Подпись в письмах'
});

const settingsService = useService('settings', { auth: true });
const toast = useToast('GlobalToast');
const user = useState<any>('user');
const template = ref('');
const saving = ref(false);
const loaded = ref(false);

const EXAMPLE = `<table cellpadding="0" cellspacing="0" style="font-family: Arial, sans-serif; font-size: 13px; color: #334155">
  <tr>
    <td style="padding-right: 14px; vertical-align: top">
      <div style="font-size: 20px; font-weight: bold; letter-spacing: 3px; color: #0d9488">PARISA</div>
      <div style="font-size: 10px; letter-spacing: 4px; color: #64748b">HOME</div>
    </td>
    <td style="border-left: 2px solid #14b8a6; padding-left: 14px; line-height: 1.5">
      <b style="font-size: 15px; color: #0f172a">{{name}}</b><br>
      Менеджер по продажам · Parisa Home<br>
      {{phone}} · WhatsApp · Telegram<br>
      <a href="mailto:{{email}}" style="color: #0d9488">{{email}}</a> · <a href="https://parisahome.com" style="color: #0d9488">parisahome.com</a>
    </td>
  </tr>
</table>`;

const preview = computed(() => {
    const filled = template.value
        .replace(/\{\{\s*name\s*\}\}/g, user.value?.username ?? 'Имя Менеджера')
        .replace(/\{\{\s*phone\s*\}\}/g, user.value?.phone ?? '+998 90 123 45 67')
        .replace(/\{\{\s*email\s*\}\}/g, user.value?.email ?? 'manager@parisahome.com');
    return DOMPurify.sanitize(filled);
});

onMounted(async () => {
    const result = await promiseResult(settingsService.find().exec());
    if (result.ok) template.value = (result.value as any)?.mail_signature ?? '';
    loaded.value = true;
});

async function save() {
    saving.value = true;
    const result = await promiseResult(settingsService.patch('', { mail_signature: template.value }).exec());
    saving.value = false;
    if (!result.ok) return toast.show({ message: result.error.message, type: 'error', timeout: 4000 });
    toast.show({ message: 'Подпись сохранена', type: 'success', timeout: 3000 });
    const fresh = await promiseResult(settingsService.find().exec());
    if (fresh.ok) template.value = (fresh.value as any)?.mail_signature ?? '';
}
</script>

<template>
    <div class="flex flex-col gap-8">
        <div class="flex flex-col gap-1">
            <h1 class="text-xl">Подпись в письмах</h1>
            <p class="text-sm text-muted-500 dark:text-muted-400">
                Одна подпись для всей компании. В письмо подставятся имя, телефон и почта менеджера:
                <code v-pre>{{name}}</code>, <code v-pre>{{phone}}</code>, <code v-pre>{{email}}</code>.
                У менеджера со своей подписью остаётся своя.
            </p>
        </div>
        <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <BaseCard class="flex flex-col gap-4 p-6">
                <BaseHeading as="h3" size="md" weight="semibold" class="text-muted-800 dark:text-white">Шаблон (HTML)</BaseHeading>
                <BaseTextarea
                    v-model="template"
                    :rows="14"
                    label="Шаблон подписи"
                    placeholder="HTML подписи"
                    :disabled="!loaded"
                    class="font-mono text-xs"
                />
                <div class="flex flex-wrap gap-2">
                    <BaseButton color="primary" :loading="saving" @click="save">Сохранить</BaseButton>
                    <BaseButton variant="pastel" @click="template = EXAMPLE">Вставить образец</BaseButton>
                    <BaseButton variant="pastel" @click="template = ''">Очистить</BaseButton>
                </div>
                <p class="text-xs text-muted-400">
                    Скрипты, формы и обработчики событий удаляются при сохранении. В образце логотип текстом; чтобы
                    поставить картинку, замените его на &lt;img src="https://…"&gt; со ссылкой на логотип в интернете.
                </p>
            </BaseCard>
            <BaseCard class="flex flex-col gap-4 p-6">
                <BaseHeading as="h3" size="md" weight="semibold" class="text-muted-800 dark:text-white">Как увидит клиент</BaseHeading>
                <div class="rounded-md bg-white p-4 text-muted-800">
                    <p class="mb-4 text-sm">Здравствуйте! Направляю предложение по полотенцам 70×140.</p>
                    <!-- sanitised with DOMPurify -->
                    <div v-if="template" v-html="preview" />
                    <p v-else class="text-sm text-muted-400">Подпись не задана.</p>
                </div>
            </BaseCard>
        </div>
    </div>
</template>
