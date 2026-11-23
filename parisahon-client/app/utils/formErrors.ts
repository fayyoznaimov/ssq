import { nextTick } from 'vue';

/** The error states of the form fields: input, autocomplete, listbox, textarea and select */
const ERROR_SELECTOR = '.nui-input-error, .nui-autocomplete-error-text, .nui-listbox-error-text, .nui-textarea-error, .nui-select-error';

/**
 * After a save that did not pass the checks: shows the first field with an error.
 * Opens the closed <details> around it, scrolls it to the middle of the screen and puts the cursor in it.
 * `root` is the form (the whole page when not given); false when no field shows an error.
 */
export async function revealFirstError(root?: ParentNode | null): Promise<boolean> {
    await nextTick();
    const error = (root ?? document).querySelector(ERROR_SELECTOR);
    if (!error) return false;
    for (let el = error.parentElement; el; el = el.parentElement) {
        if (el instanceof HTMLDetailsElement && !el.open) el.open = true;
    }
    const field = error.closest('.nui-input-wrapper, .nui-autocomplete') ?? error;
    field.scrollIntoView({ block: 'center', behavior: 'smooth' });
    field.querySelector<HTMLElement>('input, textarea, select')?.focus({ preventScroll: true });
    return true;
}

/**
 * The toast for a form that did not pass the checks: «Не сохранено. Проверьте поле: «Телефон»».
 * `errors` — the result of validate(), `labels` — the names of the fields as the form shows them.
 */
export function invalidFieldsMessage(errors: Record<string, unknown>, labels: Record<string, string | undefined>): string {
    const names = Array.from(new Set(Object.keys(errors).map((key) => labels[key]).filter(Boolean)));
    if (!names.length) return 'Не сохранено: проверьте выделенные поля';
    return `Не сохранено. Проверьте ${names.length > 1 ? 'поля' : 'поле'}: ${names.map((name) => `«${name}»`).join(', ')}`;
}
