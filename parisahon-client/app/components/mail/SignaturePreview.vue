<template>
    <div v-if="sign" class="px-2.5 py-2 border-t border-t-muted-200 dark:border-t-muted-700 text-sm">
        <BaseCheckbox v-model="enabled" label="Добавить подпись" rounded="sm" color="primary" />
        <!-- the signature as the client will see it; the server adds it under the text when sending -->
        <div v-if="enabled" class="mt-2 max-w-full overflow-x-auto rounded-md bg-white p-3 text-muted-800" v-html="preview" />
    </div>
</template>

<script lang="ts" setup>
import DOMPurify from 'dompurify';

import type { Signature } from '~/types/mail';
import type { User } from '~/types/user';

/**
 * The sender's signature under the editor. It is not put into the text any more (the editor
 * dropped its table, colours and logo): the server adds it to the letter (with_signature=true).
 * v-model: add it or not.
 */
const enabled = defineModel<boolean>({ default: true });
const user = useState<User>('user');
const signatureService = useService('emails/signs', { auth: true });
const sign = ref('');
// cleaned like the preview of /settings/signature: inline styles stay, scripts do not
const preview = computed(() => DOMPurify.sanitize(sign.value));

onMounted(async () => {
    if (!user.value?.id) return;
    const result = await promiseResult(signatureService.get<Signature>(user.value.id).exec());
    if (result.ok) sign.value = result.value?.sign ?? '';
});
</script>
