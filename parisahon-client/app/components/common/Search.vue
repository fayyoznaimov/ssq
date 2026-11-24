<template>
    <div class="flex flex-col sm:flex-row gap-2">
        <BaseInput
            v-model="searchQ"
            :classes="{wrapper: 'w-full min-w-0'}"
            icon="ph:list-magnifying-glass"
            :placeholder="placeholder"
            size="lg"
            type="search"
        />
        <!-- an optional narrowing: the search works without choosing a field (the first one is taken) -->
        <BaseListbox
            v-if="fields.length > 1"
            v-model="selected"
            class="w-full sm:max-w-xs"
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

/** the field the text is searched in: the chosen one, otherwise the first (nothing was searched before a choice) */
const field = computed<Field | undefined>(() => {
    const chosen = selected.value as Field | Field[];
    if (!Array.isArray(chosen) && chosen?.key) return chosen;
    return props.fields[0];
});

const placeholder = computed(() => props.fields.length === 1 ? `Поиск: ${props.fields[0].label}` : "Поиск");

// a new choice of fields keeps the text and searches again; the fields of the page do not reset what was found
const update = deb(emitQuery, props.debounce);
watch(searchQ, update);
watch(selected, () => {
    if (searchQ.value.trim()) emitQuery();
});

function initSelection() {
    if (props.multiple) selected.value = props.fields;
    else if (props.fields.length === 1) selected.value = props.fields[0];
}
initSelection();
watch(() => props.fields.map((f) => f.key).join("|"), initSelection);

// useService encodes the query string itself; encoding here as well sent
// Cyrillic as "%25D0%25..." and the search found nothing
function toQ(f: Field, text: string) {
    if (props.ilike) return {[f.key]: {$iLike: `%${text}%`}};
    return {[f.key]: text};
}

function emitQuery() {
    const text = searchQ.value.trim();
    if (!text) {
        return emit("update:modelValue", {});
    }
    let query: Record<string, any> = {};
    if (props.multiple && Array.isArray(selected.value) && selected.value.length) {
        query = {$or: selected.value.map((f) => toQ(f, text))};
    } else if (field.value) {
        query = toQ(field.value, text);
    }
    emit("update:modelValue", query);
}
</script>
