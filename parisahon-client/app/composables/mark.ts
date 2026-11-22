// eslint-disable-next-line vue/prefer-import-from-vue
import { escapeHtml } from '@vue/shared';
import type { MaybeRefOrGetter } from 'vue';

export function useNinjaMark(
    _text?: MaybeRefOrGetter<string | undefined>,
    _search?: MaybeRefOrGetter<string | undefined>,
    _classes?: MaybeRefOrGetter<string | undefined>,
) {
    const text = toRef(_text);
    const classes = toRef(_classes);
    const search = toRef(_search);

    return computed(() => {
        const txt = unref(text);
        const srch = unref(search);
        if (!txt) {
            return '';
        }

        if (!srch) {
            return escapeHtml(txt);
        }

        // the search is text, not a pattern; everything outside the marks is escaped too
        const regex = new RegExp(srch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        let out = '';
        let last = 0;
        for (const found of txt.matchAll(regex)) {
            const at = found.index ?? 0;
            out += escapeHtml(txt.slice(last, at));
            out += `<mark class="${escapeHtml(classes.value ?? '')}">${escapeHtml(found[0])}</mark>`;
            last = at + found[0].length;
        }
        return out + escapeHtml(txt.slice(last));
    });
}
