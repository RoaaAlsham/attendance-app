/**
 * Only ever redirect to a same-origin relative path. A `next` value comes
 * straight from a query string, so treating it as trustworthy would make
 * this an open redirect (e.g. `?next=https://evil.example`).
 */
export function safeRedirectTarget(next: string | null): string | null {
  if (!next) return null;
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  return next;
}
