import DOMPurify from 'dompurify';

/**
 * Letters come from outside: before v-html their HTML loses scripts, forms, frames, embedded objects,
 * styles and <base>/<meta>/<link>; links open in a new tab and do not pass the CRM page on.
 */
const CONFIG = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'base', 'meta', 'link'],
    FORBID_ATTR: ['style', 'srcset', 'formaction', 'action'],
};

let linksHooked = false;
function hookLinks() {
    if (linksHooked) return;
    linksHooked = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        if ((node as Element)?.tagName === 'A') {
            (node as Element).setAttribute('target', '_blank');
            (node as Element).setAttribute('rel', 'noopener noreferrer nofollow');
        }
    });
}

/** HTML from outside, safe for v-html */
export function sanitizeHtml(html?: string | null): string {
    if (!html) return '';
    hookLinks();
    return String(DOMPurify.sanitize(String(html), CONFIG));
}

/** The text of an HTML fragment, without the markup */
function htmlText(html?: string | null): string {
    return (html && new DOMParser().parseFromString(sanitizeHtml(html), 'text/html').body.textContent) || '';
}

/**
 * A letter for the page: the cleaned body for v-html and its first 200 characters as text
 * (the line under the subject). Kept on the letter itself as `sanitized` too.
 */
export function sanitizeEmail(email?: { body?: string | null; sanitized?: { body: string; snippet: string } } | null): { body: string; snippet: string } {
    const body = sanitizeHtml(email?.body);
    const sanitized = { body, snippet: htmlText(body).slice(0, 200) };
    if (email) email.sanitized = sanitized;
    return sanitized;
}

/**
 * A name from outside (a stage, a manager, a task type) for a place that renders text as HTML,
 * like the labels and tooltips of the charts: the angle brackets become ‹ ›, so it cannot become markup.
 */
export function plainSafe(value: unknown): string {
    return String(value ?? '').replace(/</g, '‹').replace(/>/g, '›');
}
