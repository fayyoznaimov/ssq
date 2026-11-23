<template>
    <div class="flex flex-col space-y-2">
        <BaseInput
            v-if="props.withSubject"
            name="subject"
            :form="props.form"
            label="Тема *"
            icon="ph:warning-circle"
            required
            v-model="subject"
        />
        <ckeditor
            :config="config"
            :editor="ClassicEditor"
            v-model="model"
            :form="props.form"
        />
        <span v-if="props.error" class="text-[0.65rem] text-rose-500 font-medium"> {{ props.error }} </span>
        <input :form="props.form" @change="onFileSelect" type="file" name="files" ref="fileInputRef" class="appearance-none opacity-0 h-0 w-0 absolute -z-10" multiple />
        <ul class="flex gap-2 mt-2 ml-2 flex-wrap">
            <li v-for="(file, i) of uploadedFiles" class="flex items-center gap-2 p-2 rounded-md w-full text-sm basis-44 bg-muted-50 dark:bg-muted-800">
                <Icon :name="getAttachmentIcon(file.name)" class="size-6 shrink-0" />
                <div class="flex flex-col flex-1">
                    <span class="text-muted-900 line-clamp-1 dark:text-white">{{ file.name }}</span>
                </div>
                <BaseButtonClose size="xs" color="danger" @click="() => onFileDelete(i)"/>
            </li>
        </ul>
    </div>
</template>

<script lang="ts" setup>
import '@ckeditor/ckeditor5-build-classic/build/translations/ru.js';

import { Autoformat } from '@ckeditor/ckeditor5-autoformat';
import { Bold, Italic } from '@ckeditor/ckeditor5-basic-styles';
import { BlockQuote } from '@ckeditor/ckeditor5-block-quote';
import { Plugin } from '@ckeditor/ckeditor5-core';
import { ClassicEditor } from '@ckeditor/ckeditor5-editor-classic';
import { Essentials } from '@ckeditor/ckeditor5-essentials';
import { Link } from '@ckeditor/ckeditor5-link';
import { List } from '@ckeditor/ckeditor5-list';
import { Paragraph } from '@ckeditor/ckeditor5-paragraph';
import { TextTransformation } from '@ckeditor/ckeditor5-typing';
import { 
    addListToDropdown,
    ButtonView, 
    DropdownButtonView, 
    DropdownPanelView,
    DropdownView, 
    type ListDropdownItemDefinition,
    ViewModel,
} from '@ckeditor/ckeditor5-ui';
import { Collection } from '@ckeditor/ckeditor5-utils';

import type { Signature, Template } from '~/types/mail';
import type { User } from '~/types/user';
import { MAX_ATTACHMENTS_MB, megabytes } from '~/utils/mailView';

const fileInputRef = ref();
const model = defineModel();
const uploadedFiles = ref<File[]>([]);
const user = useState<User>('user');
const subject = ref();
const props = withDefaults(
    defineProps<{form?: string, error?: string, withSubject?: boolean}>(), {
        withSubject: false,
    });

const signatureService = useService('emails/signs', {auth: true});
const templateService = useService('emails/templates', {auth: true});

const toast = useToast('GlobalToast');
/** The mail server takes 10 files per letter (the API's limit) and about 20 MB of them together. */
const MAX_FILES = 10;

/** The file input holds what the list shows (a new choice replaces the input's files, so they are put back). */
function syncInput() {
    if (!fileInputRef.value) return;
    const dt = new DataTransfer();
    for (const file of uploadedFiles.value) dt.items.add(file);
    fileInputRef.value.files = dt.files;
}

function onFileSelect(e: Event) {
    const target = e.target as HTMLInputElement;
    const added = [...(target.files ?? [])];
    if (!added.length) return;
    const next = [...uploadedFiles.value, ...added];
    const total = next.reduce((sum, file) => sum + file.size, 0);
    if (next.length > MAX_FILES) {
        toast.show({ message: `К письму можно приложить не больше ${MAX_FILES} файлов`, type: 'error', timeout: 5000 });
        return syncInput();
    }
    if (total > MAX_ATTACHMENTS_MB * 1024 * 1024) {
        toast.show({
            message: `Вложения вместе ${megabytes(total)} МБ, почтовый сервер примет не больше ${MAX_ATTACHMENTS_MB} МБ: уменьшите или уберите файлы`,
            type: 'error',
            timeout: 6000,
        });
        return syncInput();
    }
    uploadedFiles.value = next;
    syncInput();
}

function onFileDelete(idx: number) {
    uploadedFiles.value.splice(idx, 1);
    syncInput();
}

// the form was sent and reset: its files are gone from the input, so from the list too
function onFormReset() {
    uploadedFiles.value = [];
}

onMounted(() => fileInputRef.value?.form?.addEventListener('reset', onFormReset));
onBeforeUnmount(() => fileInputRef.value?.form?.removeEventListener('reset', onFormReset));

function FileInputPlugin(editor: ClassicEditor) {
    editor.ui.componentFactory.add('file-input', (locale) => {
        const button = new ButtonView(locale);
        const t = editor.t;

        button.set({
            label: t('Open file manager'),
            icon: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="#000000" viewBox="0 0 256 256"><path d="M209.66,122.34a8,8,0,0,1,0,11.32l-82.05,82a56,56,0,0,1-79.2-79.21L147.67,35.73a40,40,0,1,1,56.61,56.55L105,193A24,24,0,1,1,71,159L154.3,74.38A8,8,0,1,1,165.7,85.6L82.39,170.31a8,8,0,1,0,11.27,11.36L192.93,81A24,24,0,1,0,159,47L59.76,147.68a40,40,0,1,0,56.53,56.62l82.06-82A8,8,0,0,1,209.66,122.34Z"></path></svg>',
            tooltip: true,
        });

        button.on('execute', () => {
            fileInputRef.value.click();
        });

        return button;
    });
}

class SignatureUI extends Plugin {
    public static get pluginName() {
        return 'SignatureUI' as const;
    }

    async init() {
        const editor = this.editor;
        const signature = await promiseResult(signatureService.get<Signature>(user.value.id).exec());
        if (!signature.ok) return;
        editor.ui.componentFactory.add('signature', (locale) => {
            const t = editor.t;
            const button = new DropdownButtonView(locale);
            button.set({
                label: t('Add signature'),
                icon: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="#000000" viewBox="0 0 256 256"><path d="M227.32,73.37,182.63,28.69a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31l83.67-83.66,3.48,13.9-36.8,36.79a8,8,0,0,0,11.31,11.32l40-40a8,8,0,0,0,2.11-7.6l-6.9-27.61L227.32,96A16,16,0,0,0,227.32,73.37ZM48,179.31,76.69,208H48Zm48,25.38L51.31,160,136,75.31,180.69,120Zm96-96L147.32,64l24-24L216,84.69Z"></path></svg>',
                tooltip: true,
            });
            const items: Collection<ListDropdownItemDefinition> = new Collection();
            const panelView = new DropdownPanelView(locale);
            const dropdown = new DropdownView(locale, button, panelView);

            const item: ListDropdownItemDefinition = {
                type: 'button',
                model: new ViewModel({
                    label: signature.value.username,
                    class: 'signature-class',
                    role: 'menuitemradio',
                    withText: true,
                })
            };

            item.model.set({ commandValue: signature.value.sign });
            items.add(item);

            addListToDropdown(dropdown, items, { role: 'menu' });

            dropdown.extendTemplate({ attributes: { class: ['ck-signature-dropdown'] } });

            dropdown.on('execute', (e) => {
                const { commandValue } = e.source as any;
                let data = editor.getData();
                let newLines = Array(3).fill(0).map(() => '<br />').join('');
                data += newLines + commandValue;
                editor.setData(data);
            });
            return dropdown;
        });
    }
}

class TemplateUI extends Plugin {
    public static get pluginName() {
        return 'TemplateUI' as const;
    }

    async init() {
        const editor = this.editor;
        const templates = await promiseResult(templateService.find<Template[]>().exec());
        if (!templates.ok) return;
        editor.ui.componentFactory.add('template', (locale) => {
            const t = editor.t;
            const button = new DropdownButtonView(locale);
            button.set({
                label: 'Шаблоны',
                tooltip: true,
                withText: true,
            });
            const items: Collection<ListDropdownItemDefinition> = new Collection();
            const panelView = new DropdownPanelView(locale);
            const dropdown = new DropdownView(locale, button, panelView);

            for (const template of templates.value) {
                const item: ListDropdownItemDefinition = {
                    type: 'button',
                    model: new ViewModel({
                        label: template.name,
                        class: 'signature-class',
                        role: 'menuitemradio',
                        withText: true,
                    })
                };

                item.model.set({ value: template });
                items.add(item);
            }

            addListToDropdown(dropdown, items, { role: 'menu' });

            dropdown.extendTemplate({ attributes: { class: ['ck-signature-dropdown'] } });

            dropdown.on('execute', (e) => {
                const { value } = e.source as any;
                editor.setData(value.template_body);
                subject.value = value.subject;
            });
            return dropdown;
        });
    }
}

class SignaturePlugin extends Plugin {
    public static get requires() {
        return [SignatureUI] as const;
    }

    public static get pluginName() {
        return 'Signature' as const;
    }
}

class TemplatePlugin extends Plugin {
    public static get requires() {
        return [TemplateUI] as const;
    }

    public static get pluginName() {
        return 'Template' as const;
    }
}

function getAttachmentIcon(fileName: string): string {
    const extension = fileName?.split('.').pop()?.toLowerCase() || '';
    switch (extension) {
        case 'pdf':
            return 'ph:file-pdf';
        case 'doc':
        case 'docx':
            return 'ph:file-doc';
        case 'js':
            return 'ph:file-js';
        case 'xls':
        case 'xlsx':
            return 'ph:file-xls';
        case 'ppt':
        case 'pptx':
            return 'ph:file-ppt';
        case 'jpg':
        case 'jpeg':
        case 'png':
        case 'gif':
            return 'ph:image-square';
        default:
            return 'ph:file';
    }
}

const config = ref({
    toolbar: {
        items: [
            'undo', 'redo',
            '|', 'bold', 'italic',
            'link', 'file-input',
            '|', 'bulletedList', 'numberedList'
        ],
    },
    language: 'ru',
    plugins: [
        Essentials,
        Bold,
        Italic,
        Paragraph,
        Link,
        FileInputPlugin,
        BlockQuote,
        Autoformat,
        List,
        TextTransformation,
        // SignaturePlugin,
        // TemplatePlugin
    ]
});

</script>

<style>
.ck-editor__editable_inline {
    min-height: 8rem;
}

.ck-powered-by {
  display: none;
}

.ck-toolbar {
    @apply dark:!bg-transparent;
}

.ck-content {
    @apply dark:!bg-transparent;
}

.signature-box {
    margin-top: 8rem;
}

:root {
    --primary-200: 8, 176, 156;
    --primary-300: 6, 132, 116;
    --primary-400: 4, 87, 77;
    --primary-500: 2, 43, 38;
    --primary-600: 2, 39, 34;
    --primary-700: 2, 34, 30;
    --primary-800: 1, 30, 27;
    --ck-border-radius: 0.375rem;

    --ck-custom-border: transparent;
    --ck-custom-background: white;
    --ck-custom-foreground: hsl(255, 3%, 18%);
    --ck-custom-button-on-background: rgba(var(--primary-600), 0.1);
    --ck-custom-button-on-hover-background: rgba(var(--primary-600), 0.1);
    --ck-custom-button-on-active-background: var(--ck-custom-button-on-hover-background);
    --ck-custom-button-on-color: rgb(var(--primary-600));

    --ck-color-text: rgb(148, 163, 184);

    --ck-color-button-default-hover-background: var(--ck-custom-button-on-hover-background);

    --ck-color-button-on-background: var(--ck-custom-button-on-background);
    --ck-color-button-on-hover-background: var(--ck-custom-button-on-hover-background);
    --ck-color-button-on-active-background: var(--ck-custom-button-on-active-background);
    --ck-color-button-on-active-shadow: hsl(240, 3%, 19%);
    --ck-color-button-on-disabled-background: var(--ck-custom-foreground);
    --ck-color-button-on-color: var(--ck-custom-button-on-color);

    --ck-color-focus-border: var(--ck-custom-border);
    --ck-inner-shadow: none;

    --ck-color-base-foreground: var(--ck-custom-background);
    --ck-color-button-default-background: var(--ck-custom-background);
    --ck-color-button-default-disabled-background: var(--ck-custom-background);
    --ck-color-dropdown-panel-background: var(--ck-custom-background);
    --ck-color-input-background: var(--ck-custom-background);
    --ck-color-labeled-field-label-background: var(--ck-custom-background);
    --ck-color-list-background: var(--ck-custom-background);
    --ck-color-panel-background: var(--ck-custom-background);
    --ck-color-toolbar-background: var(--ck-custom-background);

    --ck-color-input-border: var(--ck-custom-border);
    --ck-color-panel-border: var(--ck-custom-border);
    --ck-color-toolbar-border: var(--ck-custom-border);
    --ck-color-base-border: var(--ck-custom-border);
    --ck-color-widget-blurred-border: hsl(0, 0%, 87%);
    --ck-color-widget-hover-border: hsl(43, 100%, 68%);

}

:root.dark {
    --ck-custom-background: transparent;
    --ck-custom-foreground: hsl(255, 3%, 18%);

    --ck-custom-button-on-background: rgb(var(--primary-400));
    --ck-custom-button-on-hover-background: rgb(var(--primary-400));
    --ck-custom-button-on-color: white;
    --ck-custom-button-on-active-background: rgb(var(--primary-400));
}

</style>
