function tag(event, key) {
  if (Array.isArray(event.tags)) {
    const hit = event.tags.find((item) => item?.key === key);
    return hit ? hit.value : undefined;
  }
  if (event.tags && typeof event.tags === 'object') return event.tags[key];
  return undefined;
}

function httpStatus(event) {
  const raw = event.contexts?.response?.status_code ?? tag(event, 'http.status_code');
  if (raw == null || raw === '') return null;
  const status = Number(raw);
  return Number.isFinite(status) ? status : null;
}

function pathname(request) {
  if (!request?.url) return null;
  try {
    return new URL(request.url, 'http://localhost').pathname;
  } catch {
    return null;
  }
}

export function processTerminated(event) {
  const values = event.exception?.values ?? [];
  if (values.some((value) => value?.mechanism?.handled === false)) return true;
  if (values.some((value) => value?.mechanism?.type === 'onunhandledrejection' || value?.mechanism?.type === 'onerror')) return true;
  const handled = String(tag(event, 'handled') ?? '').toLowerCase();
  if (handled === 'no' || handled === 'false') return true;
  if (values.length > 0 && values.every((value) => value?.mechanism?.handled === true)) return false;
  if (handled === 'yes' || handled === 'true') return false;
  return null;
}

function userFlowInvolved(event) {
  if (event.user == null && event.request == null && !tag(event, 'url')) return false;
  return true;
}

function userCanUseApp(event, booleans, blockerTransactions) {
  if (booleans.userFlowInvolved !== true) return null;
  const path = pathname(event.request);
  const transaction = tag(event, 'transaction') || null;
  if (!path && !transaction) return null;
  const blocked = (path && blockerTransactions.includes(path)) || (transaction && blockerTransactions.includes(transaction));
  const status = httpStatus(event);
  if (blocked && (booleans.processTerminated === true || (status != null && status >= 500))) return false;
  return true;
}

function userFlowCompletes(event, booleans) {
  if (booleans.userFlowInvolved !== true) return null;
  const status = httpStatus(event);
  if (booleans.processTerminated === true) return false;
  if (status != null && status >= 500) return false;
  if (booleans.processTerminated === false && status != null && status < 500) return true;
  if (booleans.processTerminated === false && String(event.level ?? '').toLowerCase() === 'warning') return true;
  return null;
}

function priorityOf(severity, userCount, eventCount24h) {
  const users = Number(userCount ?? 0);
  const events = eventCount24h == null ? null : Number(eventCount24h);
  if (severity === 'blocker') return 'P0';
  if (severity === 'truncated') return users >= 25 ? 'P0' : 'P1';
  if (severity === 'flow-blocked') return users >= 25 ? 'P1' : 'P2';
  if (severity === 'non-blocking') return users >= 25 || (events != null && events >= 200) ? 'P2' : 'P3';
  if (severity === 'no-user-impact') return events != null && events >= 200 ? 'P2' : 'P3';
  return null;
}

function dropReason(event, options) {
  if (event.type === 'transaction') return 'transaction';
  const level = String(event.level ?? '').toLowerCase();
  if (level === 'info' || level === 'debug') return 'level';
  const environment = event.environment || tag(event, 'environment') || '';
  if (!(options.productionEnvironments ?? []).includes(environment)) return 'not_production';
  const title = String(event.title ?? '');
  if ((options.ignoreTitlePatterns ?? []).some((pattern) => title.toLowerCase().includes(String(pattern).toLowerCase()))) {
    return 'ignored_title';
  }
  const status = httpStatus(event);
  if (status != null && status >= 400 && status <= 499 && processTerminated(event) !== true) return 'handled_4xx';
  return null;
}

function stripVars(event) {
  const copy = structuredClone(event);
  for (const value of copy.exception?.values ?? []) {
    for (const frame of value?.stacktrace?.frames ?? []) delete frame.vars;
  }
  return copy;
}

function decide(booleans, userCount, eventCount24h) {
  if (booleans.userFlowInvolved === false) {
    return { class: 'no-user-impact', priority: priorityOf('no-user-impact', userCount, eventCount24h), missing: false };
  }
  const missing = booleans.processTerminated === null || booleans.userCanUseApp === null || booleans.userFlowCompletes === null;
  if (missing) return { class: null, priority: null, missing: true };
  let severity = 'non-blocking';
  if (booleans.userCanUseApp === false) severity = 'blocker';
  else if (booleans.processTerminated === true && booleans.userFlowCompletes === false) severity = 'truncated';
  else if (booleans.userFlowCompletes === false) severity = 'flow-blocked';
  return { class: severity, priority: priorityOf(severity, userCount, eventCount24h), missing: false };
}

export function classify(event, options = {}) {
  const clean = stripVars(event);
  const drop = dropReason(clean, options);
  if (drop) return { drop, class: null, priority: null, missing: false, booleans: null, event: clean };
  const booleans = {
    processTerminated: processTerminated(clean),
    userFlowInvolved: userFlowInvolved(clean),
  };
  booleans.userCanUseApp = userCanUseApp(clean, booleans, options.blockerTransactions ?? []);
  booleans.userFlowCompletes = userFlowCompletes(clean, booleans);
  return { drop: null, booleans, event: clean, ...decide(booleans, options.userCount, options.eventCount24h) };
}

const FILL = ['processTerminated', 'userCanUseApp', 'userFlowCompletes'];

export function applyQuotes(booleans, parsed, eventText) {
  const next = { ...booleans };
  if (!parsed || typeof parsed !== 'object') return next;
  for (const key of FILL) {
    if (next[key] !== null) continue;
    const item = parsed[key];
    const quote = item?.quote;
    if (typeof item?.value !== 'boolean') continue;
    if (typeof quote !== 'string' || quote.length < 8 || !eventText.includes(quote)) continue;
    next[key] = item.value;
  }
  return next;
}

export function classifyBooleans(booleans, userCount, eventCount24h) {
  return decide(booleans, userCount, eventCount24h);
}

export function exceptionFromEntries(entries) {
  if (!Array.isArray(entries)) return { values: [] };
  const hit = entries.find((entry) => entry?.type === 'exception');
  return hit?.data ?? { values: [] };
}

export function normalizeEvent(issue, event) {
  return {
    type: event.type ?? 'error',
    level: event.level ?? 'error',
    title: event.title ?? issue?.title ?? '',
    environment: event.environment,
    user: event.user == null ? event.user : {},
    request: event.request ? { url: event.request.url } : event.request,
    tags: event.tags ?? [],
    contexts: event.contexts,
    exception: event.exception ?? exceptionFromEntries(event.entries),
    release: event.release,
    culprit: event.culprit ?? issue?.culprit,
    event_id: event.eventID ?? event.event_id ?? event.id ?? null,
  };
}

export function issueCounts(issue) {
  const series = issue?.stats?.['24h'];
  return {
    userCount: issue?.userCount ?? 0,
    eventCount24h: series == null ? null : series.reduce((sum, pair) => sum + Number(pair[1] ?? 0), 0),
  };
}

export function eligible(severity) {
  return severity === 'blocker' || severity === 'truncated' || severity === 'flow-blocked';
}
