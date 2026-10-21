import { readFileSync } from 'node:fs';

const SENTRY_BASE = 'https://sentry.io';
const POSTHOG_HOST = 'https://us.posthog.com';
const QWEN_BASE = 'https://maas.qwencloudapi.com/compatible-mode/v1';
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const LIMITS = {
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

export function stripJsonComments(text) {
  let out = '';
  let i = 0;
  let quote = '';
  let escape = false;
  while (i < text.length) {
    const c = text[i];
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

function normalizeTarget(target) {
  if (!ID.test(target?.id ?? '')) throw new Error('invalid target id');
  const github = target.github ?? {};
  const sentry = target.sentry ?? {};
  const posthog = target.posthog ?? {};
  const llm = target.llm ?? {};
  const owner = String(github.owner ?? '').trim();
  const name = String(github.name ?? '').trim();
  return {
    id: target.id,
    active: owner !== '' && name !== '',
    github: { owner, name, installationId: String(github.installationId ?? '') },
    sentry: {
      baseUrl: sentry.baseUrl || SENTRY_BASE,
      org: String(sentry.org ?? '').trim(),
      project: String(sentry.project ?? '').trim(),
      webhookSecretEnv: sentry.webhookSecretEnv || 'SENTRY_WEBHOOK_SECRET',
      authTokenEnv: sentry.authTokenEnv || 'SENTRY_AUTH_TOKEN',
      productionEnvironments: sentry.productionEnvironments ?? [],
      blockerTransactions: sentry.blockerTransactions ?? BLOCKERS,
      ignoreTitlePatterns: sentry.ignoreTitlePatterns ?? IGNORE,
    },
    posthog: {
      host: posthog.host || POSTHOG_HOST,
      projectId: String(posthog.projectId ?? ''),
      apiKeyEnv: posthog.apiKeyEnv || 'POSTHOG_API_KEY',
    },
    llm: {
      baseUrlEnv: llm.baseUrlEnv || 'LLM_BASE_URL',
      apiKeyEnv: llm.apiKeyEnv || 'LLM_API_KEY',
      modelEnv: llm.modelEnv || 'LLM_MODEL',
    },
    issueLanguage: target.issueLanguage || 'both',
    phases: { cicd: target.phases?.cicd === true },
    testCommand: target.testCommand ?? null,
  };
}

export function loadConfig(file = process.env.LOGS_WATCHER_CONFIG || '/etc/logs-watcher/config.json') {
  const parsed = JSON.parse(stripJsonComments(readFileSync(file, 'utf8')));
  const targets = Array.isArray(parsed.targets) ? parsed.targets.map(normalizeTarget) : [];
  return {
    targets,
    limits: { ...LIMITS, ...(parsed.limits ?? {}) },
    phases: { cicd: targets.some((target) => target.phases.cicd) },
  };
}

export function dryRun() {
  return process.env.LOGS_WATCHER_DRY_RUN !== 'false';
}

export function llmConfig(target) {
  const apiKey = process.env[target.llm.apiKeyEnv] || '';
  const model = process.env[target.llm.modelEnv] || '';
  const baseUrl = process.env[target.llm.baseUrlEnv] || QWEN_BASE;
  return { apiKey, model, baseUrl, configured: apiKey !== '' && model !== '' };
}

export function nextUtcMidnight(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
