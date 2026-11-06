import { readFileSync } from 'node:fs';
import type { AppConfig, JsonRecord, Limits, LlmConfig, SpecialistRulesOverride, Target } from './types.js';
import { asArray, asRecord, asString } from './types.js';

const SENTRY_BASE = 'https://sentry.io';
const POSTHOG_HOST = 'https://us.posthog.com';
const QWEN_BASE = 'https://maas.qwencloudapi.com/compatible-mode/v1';
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const LIMITS: Limits = {
  dailyBudgetUsd: 5,
  inputUsdPerMillion: 0.4,
  outputUsdPerMillion: 1.6,
  maxFixFiles: 8,
  maxFixChangedLines: 400,
  promptCharCap: 80000,
  maxOutputTokens: 4096,
};

const BLOCKERS = ['/', '/login', '/signup', '/auth/callback'];
const IGNORE = [
  'ResizeObserver loop',
  'AbortError',
  'Network request failed',
  'Load failed',
  'Non-Error promise rejection captured',
];

export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let quote = '';
  let escape = false;
  while (i < text.length) {
    const c = text[i] ?? '';
    const n = text[i + 1];
    if (quote) {
      out += c;
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === quote) quote = '';
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function stringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : fallback;
}

function normalizeTarget(raw: unknown): Target {
  const target = asRecord(raw);
  const id = asString(target['id']);
  if (!ID.test(id)) throw new Error('invalid target id');
  const github = asRecord(target['github']);
  const sentry = asRecord(target['sentry']);
  const posthog = asRecord(target['posthog']);
  const llm = asRecord(target['llm']);
  const phases = asRecord(target['phases']);
  const owner = asString(github['owner']).trim();
  const name = asString(github['name']).trim();
  const testCommandRaw = target['testCommand'];
  const testCommand = Array.isArray(testCommandRaw)
    ? testCommandRaw.map((part) => String(part))
    : null;
  const specialistsRaw = target['specialists'];
  const specialists: SpecialistRulesOverride =
    specialistsRaw !== null && typeof specialistsRaw === 'object' && !Array.isArray(specialistsRaw)
      ? (specialistsRaw as SpecialistRulesOverride)
      : {};
  return {
    id,
    active: owner !== '' && name !== '',
    github: { owner, name, installationId: asString(github['installationId']) },
    sentry: {
      baseUrl: asString(sentry['baseUrl'], SENTRY_BASE) || SENTRY_BASE,
      org: asString(sentry['org']).trim(),
      project: asString(sentry['project']).trim(),
      webhookSecretEnv: asString(sentry['webhookSecretEnv'], 'SENTRY_WEBHOOK_SECRET') || 'SENTRY_WEBHOOK_SECRET',
      authTokenEnv: asString(sentry['authTokenEnv'], 'SENTRY_AUTH_TOKEN') || 'SENTRY_AUTH_TOKEN',
      productionEnvironments: stringList(sentry['productionEnvironments'], []),
      blockerTransactions: stringList(sentry['blockerTransactions'], BLOCKERS),
      ignoreTitlePatterns: stringList(sentry['ignoreTitlePatterns'], IGNORE),
    },
    posthog: {
      host: asString(posthog['host'], POSTHOG_HOST) || POSTHOG_HOST,
      projectId: asString(posthog['projectId']),
      apiKeyEnv: asString(posthog['apiKeyEnv'], 'POSTHOG_API_KEY') || 'POSTHOG_API_KEY',
    },
    llm: {
      baseUrlEnv: asString(llm['baseUrlEnv'], 'LLM_BASE_URL') || 'LLM_BASE_URL',
      apiKeyEnv: asString(llm['apiKeyEnv'], 'LLM_API_KEY') || 'LLM_API_KEY',
      modelEnv: asString(llm['modelEnv'], 'LLM_MODEL') || 'LLM_MODEL',
    },
    issueLanguage: asString(target['issueLanguage'], 'both') || 'both',
    phases: { cicd: phases['cicd'] === true },
    testCommand,
    specialists,
  };
}

export function loadConfig(file = process.env.LOGS_WATCHER_CONFIG || '/etc/logs-watcher/config.json'): AppConfig {
  const parsed = JSON.parse(stripJsonComments(readFileSync(file, 'utf8'))) as JsonRecord;
  const targets = Array.isArray(parsed['targets']) ? parsed['targets'].map(normalizeTarget) : [];
  const limitsRaw = asRecord(parsed['limits']);
  const limits: Limits = {
    ...LIMITS,
    ...(typeof limitsRaw['dailyBudgetUsd'] === 'number' ? { dailyBudgetUsd: limitsRaw['dailyBudgetUsd'] } : {}),
    ...(typeof limitsRaw['inputUsdPerMillion'] === 'number' ? { inputUsdPerMillion: limitsRaw['inputUsdPerMillion'] } : {}),
    ...(typeof limitsRaw['outputUsdPerMillion'] === 'number' ? { outputUsdPerMillion: limitsRaw['outputUsdPerMillion'] } : {}),
    ...(typeof limitsRaw['maxFixFiles'] === 'number' ? { maxFixFiles: limitsRaw['maxFixFiles'] } : {}),
    ...(typeof limitsRaw['maxFixChangedLines'] === 'number' ? { maxFixChangedLines: limitsRaw['maxFixChangedLines'] } : {}),
    ...(typeof limitsRaw['promptCharCap'] === 'number' ? { promptCharCap: limitsRaw['promptCharCap'] } : {}),
    ...(typeof limitsRaw['maxOutputTokens'] === 'number' ? { maxOutputTokens: limitsRaw['maxOutputTokens'] } : {}),
  };
  return {
    targets,
    limits,
    phases: { cicd: targets.some((target) => target.phases.cicd) },
  };
}

export function dryRun(): boolean {
  return process.env.LOGS_WATCHER_DRY_RUN !== 'false';
}

export function llmConfig(target: Target): LlmConfig {
  const apiKey = process.env[target.llm.apiKeyEnv] || '';
  const model = process.env[target.llm.modelEnv] || '';
  const baseUrl = process.env[target.llm.baseUrlEnv] || QWEN_BASE;
  return { apiKey, model, baseUrl, configured: apiKey !== '' && model !== '' };
}

export function nextUtcMidnight(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
