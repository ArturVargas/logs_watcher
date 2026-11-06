/** Shared domain types for logs-watcher (ADR-0029). */

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export type JsonRecord = Record<string, unknown>;

export type SeverityClass =
  | "blocker"
  | "truncated"
  | "flow-blocked"
  | "non-blocking"
  | "no-user-impact"
  | "unclassified";

export type Priority = "P0" | "P1" | "P2" | "P3" | "P4" | "P5";

export interface Limits {
  dailyBudgetUsd: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  maxFixFiles: number;
  maxFixChangedLines: number;
  promptCharCap: number;
  maxOutputTokens: number;
}

export interface SpecialistRules {
  scriptExtensions: string[];
  serverPaths: string[];
  uiPaths: string[];
  uiExtensions: string[];
  securityPathWords: string[];
  securityIdentifiers: string[];
  securityEnvPatterns: string[];
}

export type SpecialistRulesOverride = Partial<SpecialistRules>;

export interface TargetSentry {
  baseUrl: string;
  org: string;
  project: string;
  webhookSecretEnv: string;
  authTokenEnv: string;
  productionEnvironments: string[];
  blockerTransactions: string[];
  ignoreTitlePatterns: string[];
}

export interface Target {
  id: string;
  active: boolean;
  github: { owner: string; name: string; installationId: string };
  sentry: TargetSentry;
  posthog: { host: string; projectId: string; apiKeyEnv: string };
  llm: { baseUrlEnv: string; apiKeyEnv: string; modelEnv: string };
  issueLanguage: string;
  phases: { cicd: boolean };
  testCommand: string[] | null;
  specialists: SpecialistRulesOverride;
}

export interface AppConfig {
  targets: Target[];
  limits: Limits;
  phases: { cicd: boolean };
}

export interface LlmConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  configured: boolean;
}

export interface JobRow {
  id: string;
  kind: string;
  attempts: number;
  payload: JsonRecord;
}

export interface Patch {
  path: string;
  before: string;
  after: string;
}

export interface NewTest {
  path: string;
  content: string;
}

export interface EvidenceItem {
  source: string;
  quote: string;
}

export interface SpecialistAccepted {
  evidence: EvidenceItem[];
  summary: string;
}

export interface SpecialistRunResult {
  selected: string[];
  results: Record<string, SpecialistAccepted>;
  skipped: Record<string, string>;
  docs?: string;
}

export interface FixPayload {
  dryRun: boolean;
  refusal: string;
  summary: string;
  evidence: EvidenceItem[];
  patches: Patch[];
  newTests: NewTest[];
  class: string;
  priority: string;
  specialists?: SpecialistRunResult;
}

export interface DocFile {
  path: string;
  text: string;
  prompt?: string;
}

export interface FileSnippet {
  path?: string;
  text: string;
}

export interface ClassifyBooleans {
  processTerminated: boolean | null;
  userFlowInvolved: boolean;
  userCanUseApp?: boolean | null;
  userFlowCompletes?: boolean | null;
}

export function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Third-party webhook / LLM JSON (Sentry, GitHub, Qwen).
 * Documented escape hatch under ADR-0029: shapes are not under our control.
 * Prefer narrowing with asRecord/asString/asNumber/asArray at boundaries.
 * Do not use for app-owned structs (Target, Limits, JobRow, Patch, …).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Wire = any;
