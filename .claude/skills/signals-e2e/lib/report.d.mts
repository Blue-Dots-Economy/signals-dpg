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
  /**
   * The bare error text (no suite/title/trace framing), used as the basis for
   * root-cause grouping (`groupFailures`) and defaulting to `detail` when a
   * caller didn't set it explicitly.
   */
  rawError?: string;
}

/** One root-cause group in section 2 — see `groupFailures`. */
export interface FailureGroup {
  /** The normalized (identifiers masked) error text shared by every member. */
  signature: string;
  count: number;
  members: FailureEntry[];
  verdict: 'suite-defect' | 'unattributed';
  reason: string;
}

export interface Scoped {
  alias: string;
  suites: number[];
}

export interface GitCheckoutInfo {
  dir: string;
  sha: string;
  branch: string;
}

export interface GitInfo {
  specs: GitCheckoutInfo;
  app: GitCheckoutInfo;
  /** True when `specs.sha !== app.sha`. */
  diverged: boolean;
  /** False when the ahead/behind counts could not be computed (e.g. unrelated histories). */
  computable: boolean;
  specsAhead: number;
  appAhead: number;
}

export interface ReportSections {
  working: WorkingEntry[];
  /** Flat — one entry per failing spec. Exit-code/count semantics are unaffected by grouping. */
  notWorking: FailureEntry[];
  /** `notWorking` collapsed by root-cause signature (R1) — a rendering aid, not a new source of truth. */
  notWorkingGroups: FailureGroup[];
  known: FailureEntry[];
  /**
   * Specs that failed on their first attempt and passed on a Playwright
   * retry (R4). Never counted as a pass; each entry's `detail`/`rawError`
   * carry the FIRST attempt's error, not the retry's.
   */
  flaky: FailureEntry[];
  needsHuman: string[];
  coverageDrift: string[];
  scoped: Scoped | null;
  gitInfo: GitInfo | null;
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
  /** The suite catalogue; defaults to `SUITES`. See `parseSuiteTable`. */
  suites?: Suite[];
  /** Both checkouts' git provenance (R5); null when not supplied. */
  gitInfo?: GitInfo | null;
}

export interface Suite {
  id: number;
  name: string;
}

export declare const SUITES: Suite[];

export declare function parseHumanOnly(markdown: string): string[];

export declare function parseSuiteTable(markdown: string): Suite[];

export declare function normalizeErrorSignature(message: string): string;

export declare function classifySuiteVsProduct(
  rawMessages: string[],
): { verdict: 'suite-defect' | 'unattributed'; reason: string };

export declare function groupFailures(notWorking: FailureEntry[]): FailureGroup[];

export declare function dedupeWithCounts(entries: string[]): string[];

export declare function buildReport(input: BuildReportInput): ReportSections;

export declare function renderMarkdown(report: ReportSections): string;
