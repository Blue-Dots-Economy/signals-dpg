export interface DomainCount {
  domain: string;
  count: number;
}

/** Per-domain counts, largest first; ties keep insertion order. */
export function tallyDomains(domains: string[]): DomainCount[] {
  const counts = new Map<string, number>();
  for (const d of domains) {
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count);
}
