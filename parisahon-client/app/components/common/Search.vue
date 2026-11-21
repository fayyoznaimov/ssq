<template>
    <div class="flex flex-col md:flex-row gap-2">
        <BaseInput
            v-model="searchQ"
            :classes="{wrapper: 'w-full'}"
            icon="ph:list-magnifying-glass"
            placeholder="Поиск"
            size="lg"
        />
        <BaseListbox
            v-if="fields.length > 1"
            v-model="selected"
            class="max-w-xs"
            size="lg"
            :items="fields"
            :properties="{ value: 'key', label: 'label' }"
            placeholder="Поиск по ..."
            :multiple="props.multiple"
            :multiple-label="(value, prop) => {
                if (!value.length) return;
                else return `${value.map(v => v[prop]).join(', ')}`;
            }"
        />
    </div>
</template>

<script lang="ts" setup>
import {debounce as deb} from "~/utils/search";

type Field = {
    key: string;
    label: string;
}
interface Props {
    modelValue: Record<string, any>;
    debounce: number;
    fields: Field[];
    ilike?: boolean;
    multiple?: boolean;
}

const props = withDefaults(defineProps<Props>(), {fields: () => [], debounce: 300});
const emit = defineEmits(["update:modelValue"]);

const searchQ = ref("");
const selected = ref<Field[] | Field>([]);

watch([searchQ, selected], deb(update, props.debounce));
watchEffect(() => {
    if (props.multiple) selected.value = props.fields;
    else if (props.fields.length === 1) selected.value = props.fields[0];
});

// useService encodes the query string itself; encoding here as well sent
// Cyrillic as "%25D0%25..." and the search found nothing
function toQ(field: Field) {
    if (props.ilike) return {[field.key]: {$iLike: `%${searchQ.value}%`}};
    return {[field.key]: searchQ.value};
}

function update() {
    if (!searchQ.value.length) {
        return emit("update:modelValue", {});
    }
    let query: Record<string, any> = {};
    if (!props.multiple && searchQ.value && Object.keys(selected.value).length) {
        query = {...toQ(selected.value as unknown as Field)};
    } else if (props.multiple && Array.isArray(selected.value) && selected.value.length) {
        query = {$or: selected.value.map(toQ)};
    }
    emit("update:modelValue", query);
}
</script>

