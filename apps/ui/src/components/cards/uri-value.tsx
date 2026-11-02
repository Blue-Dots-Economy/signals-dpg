import * as React from 'react';
import { cn } from '@/lib/utils';
import { toSafeHref, URI_DISPLAY_MAX_CHARS } from '@/lib/uri-field';

/**
 * Renders an `x-uri` field: each safely linkable entry as an `<a>`, anything
 * else (masked stub, non-http scheme) as plain text. Arrays render one link
 * per entry.
 */
export function UriValue({ value, className }: Readonly<{ value: unknown; className?: string }>) {
  const entries = (Array.isArray(value) ? value : [value])
    .filter((entry) => entry !== null && entry !== undefined)
    .map(String)
    .filter((entry) => entry.trim().length > 0);

  if (entries.length === 0) return <>—</>;

  return (
    <>
      {entries.map((entry, index) => (
        <React.Fragment key={`${entry}-${index}`}>
          {index > 0 && ', '}
          <UriEntry value={entry} className={className} />
        </React.Fragment>
      ))}
    </>
  );
}

function UriEntry({ value, className }: Readonly<{ value: string; className?: string }>) {
  const href = toSafeHref(value);
  if (!href) return <>{value}</>;

  // No "Show more": the text is elided and the full value is in the href and
  // tooltip.
  const text =
    value.length > URI_DISPLAY_MAX_CHARS
      ? `${value.slice(0, URI_DISPLAY_MAX_CHARS).trimEnd()}…`
      : value;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={value}
      // List cards carry their own onClick; without this, following a link
      // would also trigger the card's click handler.
      onClick={(e) => e.stopPropagation()}
      // z-10: above ItemCard's whole-card button (see `CardShell`).
      className={cn(
        'relative z-10 font-medium text-primary underline underline-offset-2 hover:opacity-80',
        className
      )}
    >
      {text}
    </a>
  );
}
