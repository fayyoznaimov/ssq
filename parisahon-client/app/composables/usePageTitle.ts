/**
 * The name of the open page for the header of the layout and the browser tab: «Сделки», «Корзина сделок»,
 * the name of an open record («QA-ТЕСТ Компания 2», set by useRecordTitle), «Новая компания» on /new.
 * The header said «Parisa CRM» on every page.
 */
export const APP_NAME = 'Parisa CRM';

export function usePageTitle() {
    const route = useRoute();
    const crumbTitle = useState<{ path: string; label: string } | null>('crumbTitle', () => null);
    return computed(() => {
        if (crumbTitle.value?.label && crumbTitle.value.path === route.path) return crumbTitle.value.label;
        const meta = route.meta as Record<string, unknown>;
        const isNew = route.path.split('/').pop() === 'new';
        const title = (isNew && meta.verboseNew) || meta.verbose || meta.title;
        return typeof title === 'string' && title ? title : APP_NAME;
    });
}
