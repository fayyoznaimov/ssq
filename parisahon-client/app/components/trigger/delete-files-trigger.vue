<script setup lang="ts">
import BaseInput from '~/components/form/BaseInput.vue';
import type BaseSelect from '~/components/form/BaseSelect.vue';
import { type DeleteFilesTrigger, FileSource,type Trigger } from '~/types/stage';
import { getUnit,toBytes, toUnit, Unit } from '~/utils/byte';

const props = defineProps<{
  trigger: Trigger & DeleteFilesTrigger;
}>();

const whichFilesOptions = [
    {
        label: 'Прикрепленные в примечаниях',
        value: FileSource.FromComments,
    },
    {
        label: 'Прикрепленные в сообщениях',
        value: FileSource.FromMessages,
    },
    {
        label: 'Загруженные на вкладке файлов',
        value: FileSource.FromFilesTab,
    },
    {
        label: 'Присланные в почте',
        value: FileSource.FromEmails
    }
];

const extensionOptions = [
    {
        label: 'Картинки (.png, .jpg, .gif, .webp)',
        value: ['.png', '.jpg', '.gif', '.webp'],
    },
    {
        label: 'Документы (.pdf, .doc, .xlsx)',
        value: ['.pdf', '.doc', '.docx', '.xlsx'],
    },
    {
        label: 'Другие',
        value: ['.js', '.ts'],
    },
];

const unit = ref(getUnit(props.trigger.delete_files_data.till_bytes || 1024 * 1024));

const from = ref(toUnit(unit.value, props.trigger.delete_files_data.from_bytes));
const to = ref((toUnit(unit.value, props.trigger.delete_files_data.till_bytes)));
const whichFiles = ref(whichFilesOptions.filter((opt) => props.trigger.delete_files_data.which_files.some((source) => opt.value === source)));
const withExtensions = ref<typeof extensionOptions[0][]>(extensionOptions.filter((opt) => opt.value.every((ext) => props.trigger.delete_files_data.with_extensions.includes(ext))));

watch([withExtensions, whichFiles, from, to, unit], () => {
    props.trigger.delete_files_data.which_files = whichFiles.value.map((v) => v.value);
    props.trigger.delete_files_data.with_extensions = withExtensions.value.map((v) => v.value).flat();

    // an empty or zero size is «no limit» (0 was sent as a size and the API refused the trigger)
    const fromValue = Number(String(from.value ?? '').replace(',', '.'));
    const toValue = Number(String(to.value ?? '').replace(',', '.'));
    props.trigger.delete_files_data.from_bytes = !fromValue || isNaN(fromValue) || fromValue < 0 ? undefined : toBytes(unit.value, fromValue);
    props.trigger.delete_files_data.till_bytes = !toValue || isNaN(toValue) || toValue < 0 ? undefined : toBytes(unit.value, toValue);
});

</script>
<template>
    <section class="px-3 pb-3 flex flex-col gap-3 pr-[3.25rem]">
        <p class="text-xs leading-snug text-rose-600 dark:text-rose-400">
            Файлы удаляются без корзины: из сделки и её истории, а если больше нигде не используются — и с сервера.
            Какие файлы удалены, видно в истории сделки и в «Истории запусков» триггера. Без условий по источнику, типу или размеру ничего не удаляется.
        </p>
        <BaseListbox 
            v-model="whichFiles"
            :items="whichFilesOptions"
            :properties="{value: 'value', label: 'label'}"
            placeholder="Не выбран"
            label="Удалить файлы:"
            name="which_files"
            :multiple="true"
            :multipleLabel="(value, prop) => {
                if (!value.length) return;
                else return `${value.map(v => v[prop]).join(', ')}`;
            }"
        />
        <BaseListbox 
            v-model="withExtensions"
            :items="extensionOptions"
            :properties="{value: 'value', label: 'label'}"
            placeholder="Не выбран"
            label="Для всех файлов, у которых тип:"
            name="with_extensions"
            :multiple="true"
            :multipleLabel="(value, prop) => {
                if (!value.length) return;
                else return `${value.map(v => v[prop]).join(', ')}`;
            }"
        />
        <div class="flex">
            <div>
                <span class="text-[0.825rem] inline-block pb-0.5 text-muted-400">Для всех файлов, у которых размер:</span>
                <div class="flex items-center gap-2">
                    <BaseInput placeholder="От" v-model="from" />
                    <span>-</span>
                    <BaseInput placeholder="До" v-model="to" />
                    <BaseSelect v-model="unit" :classes="{wrapper: 'shrink-0'}">
                        <option :value="Unit.MB">МБ</option>
                        <option :value="Unit.KB">КБ</option>
                        <option :value="Unit.GB">ГБ</option>
                        <option :value="Unit.B">Байт</option>
                    </BaseSelect>
                </div>
            </div>
        </div>
    </section>
</template>