// Hand-written sibling declaration for report.mjs, a plain JS module with no
// JSDoc-emitted .d.ts of its own (see index_row.d.mts for the pattern this
// follows). Typed precisely rather than as `any` — unlike rowForEvent's
// discriminated-union return, these shapes are plain object literals with no
// narrowing pitfall, so full types make report.test.ts's callback parameters
// (`(h) => ...`, `(f) => f.detail`) infer correctly without extra annotation.

export interface WorkingEntry {
  suite: string;
  title: string;
  /** True when this spec's result was a reasoned skip, not an actual pass. */
  skipped: boolean;
}

export interface FailureEntry {
  suite: string;
  title: string;
  detail: string;
  trace: string | null;
}

export interface Scoped {
  alias: string;
  suites: number[];
}

export interface ReportSections {
  working: WorkingEntry[];
  notWorking: FailureEntry[];
  known: FailureEntry[];
  needsHuman: string[];
  coverageDrift: string[];
  scoped: Scoped | null;
  exitCode: number;
}

export interface BuildReportInput {
  /** Parsed Playwright JSON reporter output (`{ suites: [...] }`). */
  results: { suites: unknown[] };
  /** coverage.md's parsed `human-only` list. */
  humanOnly?: string[];
  /** Set on a scoped run; null for a full run. */
  scoped?: Scoped | null;
  /** cleanup.sh's residue table count (0 = clean). */
  residue?: number;
  /** Pre-formatted lines from `npm run coverage --json`. */
  coverageDrift?: string[];
}

export interface Suite {
  id: number;
  name: string;
}

export declare const SUITES: Suite[];

export declare function parseHumanOnly(markdown: string): string[];

export declare function buildReport(input: BuildReportInput): ReportSections;

export declare function renderMarkdown(report: ReportSections): string;
