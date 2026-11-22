/**
 * A conservative clean-up of HTML written by staff (the company e-mail signature): no scripts,
 * style blocks, frames, forms, event handlers or javascript:/data: links. Inline style attributes
 * are kept (signatures need them); the client sanitises again with DOMPurify when it shows HTML.
 */
const BLOCKED = 'script|style|iframe|frame|frameset|object|embed|form|input|button|textarea|select|meta|link|base|svg|math';

export function safeHtml(html: string): string {
  let out = String(html ?? '');
  // paired blocked elements with their content, then any leftover opening / closing / self-closing tags
  out = out.replace(new RegExp(`<\\s*(${BLOCKED})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`, 'gi'), '');
  out = out.replace(new RegExp(`<\\s*\\/?\\s*(${BLOCKED})\\b[^>]*>`, 'gi'), '');
  // event handler attributes
  out = out.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // dangerous URL schemes in href / src (quoted and unquoted)
  out = out.replace(/(href|src)\s*=\s*(["'])\s*(javascript|vbscript|data)\s*:[^"']*\2/gi, '$1="#"');
  out = out.replace(/(href|src)\s*=\s*(javascript|vbscript|data)\s*:[^\s>]*/gi, '$1="#"');
  return out;
}

export function escapeHtml(text: string): string {
  return String(text ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
