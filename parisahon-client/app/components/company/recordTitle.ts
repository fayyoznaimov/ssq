import type { Ref } from "vue";

/**
 * The name of the open record in the browser tab and in the last crumb of the layout: «QA-ТЕСТ Компания 2»,
 * not «Редактировать компанию» / «Новый контакт» on a saved contact. `fallback`: a new record, or the
 * record is not loaded yet.
 */
export function useRecordTitle(label: Ref<string | null | undefined>, fallback: string) {
    const route = useRoute();
    const crumbTitle = useState<{ path: string; label: string } | null>("crumbTitle", () => null);
    const title = computed(() => String(label.value ?? "").trim() || fallback);
    watch(title, (value) => {
        crumbTitle.value = { path: route.path, label: value };
    }, { immediate: true });
    onBeforeUnmount(() => {
        if (crumbTitle.value?.path === route.path) crumbTitle.value = null;
    });
    useHead({ title });
    return title;
}
