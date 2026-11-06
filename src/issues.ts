import type { Wire } from './types.js';
import { createHash, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dryRun } from './config.js';
import { eligible, tag } from './classify.js';
import { log } from './queue.js';
import { scrub } from './scrub.js';

const GITHUB_API = 'https://api.github.com';
const KEY_PATH = '/etc/logs-watcher/github-app.pem';
const LATER_PROGRESS = ['propuesta-abierta', 'aprobada', 'obsoleta', 'rechazada', 'resuelta'];
const ES_WORDS = ['el', 'la', 'los', 'las', 'que', 'para', 'con', 'por', 'una', 'del'];
const EN_WORDS = ['the', 'and', 'for', 'with', 'this', 'from', 'when', 'that'];
const LABEL_COLOR = {
  'logs-watcher': '1d4ed8',
  'logs-watcher:sentry': 'b91c1c',
  'severity:blocker': '7f1d1d',
  'severity:truncated': 'c2410c',
  'severity:flow-blocked': 'b45309',
  'severity:non-blocking': '0369a1',
  'severity:no-user-impact': '334155',
  'severity:unclassified': '64748b',
  'priority:p0': '7f1d1d',
  'priority:p1': 'c2410c',
  'priority:p2': 'b45309',
  'priority:p3': '0369a1',
  'auto-fix:no': '334155',
};

const COPY = {
  es: {
    untyped: 'Error sin tipo',
    unknownF: 'desconocida',
    unknownM: 'desconocido',
    unavailable: 'no disponible',
    noPriority: 'sin prioridad',
    detected: 'detectado',
    noFix: 'sin-fix-automatico',
    does: 'Qué hace el error',
    context: 'Contexto',
    affects: 'Qué afecta',
    severity: 'Severidad',
    sources: 'Fuentes',
    progressHeading: '',
    doesLine: (type: Wire, culprit: Wire, level: Wire, handled: Wire) => `Excepción ${type} en ${culprit}. El nivel que envía Sentry es ${level}. El mecanismo handled es ${handled}.`,
    affectsLine: 'El alcance para el usuario es la clase de severidad de abajo. Rutas, conteos y frecuencia están en el bloque de hechos.',
    facts: (v: Wire) => `- Release: ${v.release}\n- Entorno: ${v.environment}\n- Rutas afectadas: ${v.routes}\n- Usuarios afectados (conteo): ${v.userCount}\n- Frecuencia: ${v.total} en total, ${v.day} en las últimas 24 h según Sentry\n- Evento más reciente: ${v.eventId}`,
    severityBlock: (severity: Wire, priority: Wire) => `- Clase: ${severity}\n- Prioridad: ${priority}`,
    progress: (state: Wire) => `- Estado del fix: ${state}`,
    sentryLine: (url: Wire) => `- Sentry: ${url}`,
    eventLine: (id: Wire) => `- Evento: ${id}`,
    duplicate: (n: Wire) => `duplicado de #${n}`,
    stale: 'Los bloques del issue no se pueden actualizar.',
    update: (id: Wire) => `Evento ${id} actualiza este issue.`,
  },
  en: {
    untyped: 'Untyped error',
    unknownF: 'unknown',
    unknownM: 'unknown',
    unavailable: 'not available',
    noPriority: 'no priority',
    detected: 'detected',
    noFix: 'no-automatic-fix',
    does: 'What the error does',
    context: 'Context',
    affects: 'What it affects',
    severity: 'Severity',
    sources: 'Sources',
    progressHeading: 'Progress',
    doesLine: (type: Wire, culprit: Wire, level: Wire, handled: Wire) => `Exception ${type} at ${culprit}. The level Sentry sends is ${level}. The handled mechanism is ${handled}.`,
    affectsLine: 'User impact is the severity class below. Routes, counts, and frequency are in the facts block.',
    facts: (v: Wire) => `- Release: ${v.release}\n- Environment: ${v.environment}\n- Affected routes: ${v.routes}\n- Affected users (count): ${v.userCount}\n- Frequency: ${v.total} in total, ${v.day} in the last 24 h according to Sentry\n- Most recent event: ${v.eventId}`,
    severityBlock: (severity: Wire, priority: Wire) => `- Class: ${severity}\n- Priority: ${priority}`,
    progress: (state: Wire) => `- Fix state: ${state}`,
    sentryLine: (url: Wire) => `- Sentry: ${url}`,
    eventLine: (id: Wire) => `- Event: ${id}`,
    duplicate: (n: Wire) => `duplicate of #${n}`,
    stale: 'The issue blocks cannot be updated.',
    update: (id: Wire) => `Event ${id} updates this issue.`,
  },
};

function plain(text: Wire): Wire {
  return scrub(text).replaceAll('<!--', '< !--').replaceAll('-->', '-- >').replaceAll(/[\r\n]+/g, ' ');
}

function hits(text: Wire, words: Wire): Wire {
  const set = new Set(words);
  let count = 0;
  for (const word of String(text ?? '').toLowerCase().split(/[^a-z']+/)) {
    if (set.has(word)) count += 1;
  }
  return count;
}

export function chooseLanguage(setting: Wire, stored: Wire, text: Wire): Wire {
  if (stored === 'es' || stored === 'en') return stored;
  if (setting === 'es' || setting === 'en') return setting;
  const es = hits(text, ES_WORDS);
  const en = hits(text, EN_WORDS);
  if (es >= 2 && es > en) return 'es';
  if (en >= 2 && en > es) return 'en';
  return 'es';
}

function pathname(url: Wire): Wire {
  if (!url) return '';
  try { return new URL(url, 'http://localhost').pathname; } catch { return ''; }
}

function framesOf(event: Wire): Wire {
  const frames: Wire[] = [] as Wire[];
  for (const value of event.exception?.values ?? []) {
    for (const frame of value?.stacktrace?.frames ?? []) frames.push(frame);
  }
  return [...frames.filter((frame: Wire) => frame?.inApp), ...frames.filter((frame: Wire) => !frame?.inApp)];
}

function frameKey(frame: Wire): Wire {
  if (!frame) return '';
  return `${frame.filename || ''}\t${frame.function || ''}`;
}

function stackLine(frame: Wire): Wire {
  const line = frame?.lineNo ?? frame?.lineno ?? frame?.line ?? '';
  return plain(`${frame?.filename || ''}:${line} ${frame?.function || ''}`.trim());
}

function quotes(event: Wire, frame: Wire): Wire {
  const value = event.exception?.values?.[0];
  const bits = [event.title, event.culprit, value?.type, String(value?.value ?? '').slice(0, 300), frame ? stackLine(frame) : ''];
  const seen = new Set();
  const lines: Wire[] = [] as Wire[];
  for (const bit of bits) {
    const text = plain(String(bit ?? '')).replaceAll('\n', ' ');
    if (text.length < 8 || seen.has(text)) continue;
    seen.add(text);
    lines.push(`- ${text}`);
  }
  return lines.join('\n');
}

function desiredLabels(severity: Wire, priority: Wire): Wire {
  const labels = ['logs-watcher', 'logs-watcher:sentry', `severity:${severity}`];
  if (priority) labels.push(`priority:${String(priority).toLowerCase()}`);
  if (!eligible(severity)) labels.push('auto-fix:no');
  return labels;
}

function renderIssue(language: Wire, fields: Wire): Wire {
  const copy = (COPY as Wire)[language];
  const type = plain(fields.event.exception?.values?.[0]?.type || '');
  const culprit = plain(fields.event.culprit || '') || copy.unknownF;
  const level = plain(fields.event.level || '') || copy.unknownM;
  const handledRaw = fields.event.exception?.values?.[0]?.mechanism?.handled;
  const handled = handledRaw === true || handledRaw === false ? String(handledRaw) : copy.unknownM;
  const ordered = framesOf(fields.event);
  const top = ordered[0] || null;
  const frame = plain(frameKey(top));
  const stack = ordered.length ? ordered.slice(0, 5).map(stackLine).join('\n') : copy.unavailable;
  const routes: Wire[] = [] as Wire[];
  const transaction = tag(fields.event, 'transaction');
  const path = pathname(fields.event.request?.url);
  if (transaction) routes.push(plain(String(transaction)));
  if (path && path !== transaction) routes.push(plain(path));
  const release = plain(String(fields.event.release || tag(fields.event, 'release') || '')) || copy.unknownF;
  const environment = plain(String(fields.event.environment || tag(fields.event, 'environment') || '')) || copy.unknownF;
  const eventId = plain(fields.event.event_id || '');
  const markerId = plain(String(fields.sentryIssueId)).replaceAll('"', '');
  const view = {
    release,
    environment,
    routes: routes.length ? routes.join(', ') : copy.unknownF,
    userCount: plain(String(fields.counts.userCount ?? 0)),
    total: fields.eventCountTotal == null || fields.eventCountTotal === '' ? copy.unavailable : plain(String(fields.eventCountTotal)),
    day: fields.counts.eventCount24h == null ? copy.unavailable : plain(String(fields.counts.eventCount24h)),
    eventId,
  };
  const facts = copy.facts(view);
  const severity = copy.severityBlock(fields.severity, fields.priority || copy.noPriority);
  const progress = copy.progress(eligible(fields.severity) ? copy.detected : copy.noFix);
  const bullets = quotes(fields.event, top);
  const evidence = [bullets, `<!-- logs-watcher-top-frame: ${frame} -->`].filter(Boolean).join('\n');
  const shownType = type || copy.untyped;
  const title = [...`[${fields.severity}] ${shownType}: ${culprit}`].slice(0, 120).join('');
  const key = createHash('sha256').update(`issue\n${fields.target.id}\n${fields.sentryIssueId}\n${fields.event.event_id || ''}`).digest('hex');
  const sentryUrl = fields.permalink
    ? plain(fields.permalink)
    : plain(`${fields.target.sentry.baseUrl.replace(/\/$/, '')}/organizations/${fields.target.sentry.org}/issues/${markerId}/`);
  const lines = [
    `<!-- logs-watcher-sentry-issue: ${markerId} -->`,
    `<!-- logs-watcher-generation: ${key} -->`,
    '',
    `## ${copy.does}`,
    '',
    copy.doesLine(shownType, culprit, level, handled),
    '',
    `## ${copy.context}`,
    '',
    '- Stack:',
    stack,
    '<!-- logs-watcher-facts:start -->',
    facts,
    '<!-- logs-watcher-facts:end -->',
    '',
    `## ${copy.affects}`,
    '',
    copy.affectsLine,
    '',
    `## ${copy.severity}`,
    '',
    '<!-- logs-watcher-severity:start -->',
    severity,
    '<!-- logs-watcher-severity:end -->',
    '<!-- logs-watcher-evidence:start -->',
    evidence,
    '<!-- logs-watcher-evidence:end -->',
    '',
    `## ${copy.sources}`,
    '',
    copy.sentryLine(sentryUrl),
    copy.eventLine(eventId),
    '',
  ];
  if (copy.progressHeading) lines.push(`## ${copy.progressHeading}`, '');
  lines.push('<!-- logs-watcher-progress:start -->', progress, '<!-- logs-watcher-progress:end -->', '');
  return { title, body: lines.join('\n'), facts, severity, evidence, progress, frame, labels: desiredLabels(fields.severity, fields.priority), copy, markerId };
}

function blockInner(body: Wire, name: Wire): Wire {
  const matches = [...body.matchAll(new RegExp(`<!-- logs-watcher-${name}:start -->\\n([\\s\\S]*?)\\n<!-- logs-watcher-${name}:end -->`, 'g'))];
  if (matches.length !== 1) return null;
  return matches[0][1];
}

function writeBlock(body: Wire, name: Wire, inner: Wire): Wire {
  const start = `<!-- logs-watcher-${name}:start -->`;
  const end = `<!-- logs-watcher-${name}:end -->`;
  return body.replace(new RegExp(`${start}\\n[\\s\\S]*?\\n${end}`), `${start}\n${inner}\n${end}`);
}

function nextBody(current: Wire, rendered: Wire): Wire {
  const facts = blockInner(current, 'facts');
  const severity = blockInner(current, 'severity');
  const evidence = blockInner(current, 'evidence');
  const progress = blockInner(current, 'progress');
  if (facts == null || severity == null || evidence == null || progress == null) return null;
  const stored = evidence.match(/<!-- logs-watcher-top-frame: (.*?) -->/);
  const evidenceNext = stored && stored[1] === rendered.frame ? evidence : rendered.evidence;
  const progressNext = LATER_PROGRESS.some((token: Wire) => progress.includes(token)) ? progress : rendered.progress;
  let body = writeBlock(current, 'facts', rendered.facts);
  body = writeBlock(body, 'severity', rendered.severity);
  body = writeBlock(body, 'evidence', evidenceNext);
  return writeBlock(body, 'progress', progressNext);
}

async function gh(api: Wire, token: Wire, method: Wire, path: Wire, payload?: Wire): Promise<Wire> {
  try {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'logs-watcher',
        'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${token}`,
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    } as RequestInit);
    return { status: res.status, text: await res.text(), retryAfter: res.headers.get('retry-after') };
  } catch {
    return { status: 503, text: '', retryAfter: null };
  }
}

export function failure(res: Wire): Wire {
  if (res.status === 429 || res.status >= 500) return { retry: true, status: res.status, retryAfter: res.retryAfter };
  if (res.status >= 400) return { dead: true, status: res.status };
  return null;
}

function appJwt(appId: Wire, privateKey: Wire): Wire {
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) })).toString('base64url');
  const data = `${head}.${body}`;
  const sign = createSign('RSA-SHA256');
  sign.update(data);
  return `${data}.${sign.sign(privateKey).toString('base64url')}`;
}

export async function openGithub(target: Wire, apiBase: Wire): Promise<Wire> {
  if (!target?.active) return { missing: true };
  const installationId = target.github.installationId || process.env.GITHUB_INSTALLATION_ID || '';
  const appId = process.env.GITHUB_APP_ID || '';
  if (!installationId || !appId) return { missing: true };
  let privateKey;
  try {
    privateKey = readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH || KEY_PATH, 'utf8');
  } catch {
    return { missing: true };
  }
  let token;
  try {
    token = appJwt(appId, privateKey);
  } catch {
    return { missing: true };
  }
  const api: Wire = (apiBase || GITHUB_API).replace(/\/$/, '');
  const minted = await gh(api, token, 'POST', `/app/installations/${encodeURIComponent(installationId)}/access_tokens`);
  const mintedFailure = failure(minted);
  if (mintedFailure) return mintedFailure;
  let mintedBody;
  try { mintedBody = JSON.parse(minted.text); } catch { return { dead: true, status: minted.status }; }
  if (!mintedBody.token) return { dead: true, status: minted.status };
  const accessToken = mintedBody.token;
  return { token: accessToken, call: (method: Wire, path: Wire, payload: Wire) => gh(api, accessToken, method, path, payload) };
}

async function remember(pool: Wire, targetId: Wire, sentryIssueId: Wire, number: Wire, language: Wire, stale: Wire): Promise<Wire> {
  await pool.query(
    `UPDATE groups SET github_issue_number = $3, issue_language = $4, progress_stale = $5, updated_at = now()
     WHERE target_id = $1 AND sentry_issue_id = $2`,
    [targetId, sentryIssueId, number, language, stale],
  );
  await pool.query(
    `UPDATE proposals SET github_issue_number = $3, updated_at = now()
     WHERE target_id = $1 AND sentry_issue_id = $2 AND github_issue_number IS NULL`,
    [targetId, sentryIssueId, number],
  );
}

function missing(job: Wire, sentryIssueId: Wire): Wire {
  log({ msg: 'config_missing', jobId: job.id, kind: job.kind, sentryIssueId });
  return { number: null };
}

// shortcut: a crash after GitHub creates the issue and before the number is stored can open a second one until search catches up; the lower number wins.
export async function fileSentryIssue(pool: Wire, input: Wire): Promise<Wire> {
  if (dryRun()) return { number: null };
  const { job, target, sentryIssueId } = input;
  const session: Wire = await openGithub(target, input.api);
  if (session.missing) return missing(job, sentryIssueId);
  if (session.retry || session.dead) return session;
  const call = session.call;
  const repo = `/repos/${encodeURIComponent(target.github.owner)}/${encodeURIComponent(target.github.name)}`;
  const row = (await pool.query(
    `SELECT github_issue_number, issue_language FROM groups WHERE target_id = $1 AND sentry_issue_id = $2`,
    [target.id, sentryIssueId],
  )).rows[0] ?? {};
  const language = chooseLanguage(target.issueLanguage, row.issue_language, input.eventText);
  const rendered = renderIssue(language, { ...input, target });

  const ensured = await ensureLabels(call, repo, rendered.labels);
  if (ensured) return ensured;

  let current = null;
  if (row.github_issue_number) {
    const got = await call('GET', `${repo}/issues/${row.github_issue_number}`);
    if (got.status !== 404) {
      const problem = failure(got);
      if (problem) return problem;
      current = JSON.parse(got.text);
    }
  }
  if (!current) {
    const query = `repo:${target.github.owner}/${target.github.name} "logs-watcher-sentry-issue: ${rendered.markerId}" in:body`;
    // shortcut: marker search reads the oldest 20 hits, fetch further pages when one marker matches more.
    const found = await call('GET', `/search/issues?q=${encodeURIComponent(query)}&sort=created&order=asc&per_page=20`);
    const problem = failure(found);
    if (problem) return problem;
    const items = (JSON.parse(found.text).items ?? [])
      .filter((item: Wire) => !item.pull_request)
      .sort((a: Wire, b: Wire) => a.number - b.number);
    if (items.length > 1) {
      for (const extra of items.slice(1)) {
        const commented = await commentOnce(call, repo, extra.number, `logs-watcher-duplicate: ${items[0].number}`, rendered.copy.duplicate(items[0].number));
        if (commented) return commented;
      }
    }
    if (items.length) {
      const got = await call('GET', `${repo}/issues/${items[0].number}`);
      const gotFailure = failure(got);
      if (gotFailure) return gotFailure;
      current = JSON.parse(got.text);
    }
  }
  if (!current) {
    const created = await call('POST', `${repo}/issues`, { title: rendered.title, body: rendered.body, labels: rendered.labels });
    const problem = failure(created);
    if (problem) return problem;
    const number = JSON.parse(created.text).number;
    await remember(pool, target.id, sentryIssueId, number, language, false);
    log({ msg: 'issue_filed', jobId: job.id, kind: job.kind, sentryIssueId, githubIssue: number });
    return { number };
  }
  const number = current.number;
  const body = nextBody(current.body || '', rendered);
  if (body == null) {
    await remember(pool, target.id, sentryIssueId, number, language, true);
    if ((current as Wire).state === 'closed') {
      const opened: Wire = await call('PATCH', `${repo}/issues/${number}`, { state: 'open' });
      const problem = failure(opened);
      if (problem) return problem;
    }
    const labels = await syncLabels(call, repo, number, current, rendered.labels);
    if (labels) return labels;
    const commented = await commentOnce(call, repo, number, `logs-watcher-update: ${plain(input.event.event_id || '')}`, rendered.copy.stale);
    if (commented) return commented;
    log({ msg: 'progress_stale', jobId: job.id, kind: job.kind, sentryIssueId, githubIssue: number });
    return { number };
  }
  const patch: Wire = { body };
  if ((current as Wire).state === 'closed') patch.state = 'open';
  const updated = await call('PATCH', `${repo}/issues/${number}`, patch);
  const problem = failure(updated);
  if (problem) return problem;
  await remember(pool, target.id, sentryIssueId, number, language, false);
  const labels = await syncLabels(call, repo, number, current, rendered.labels);
  if (labels) return labels;
  const commented = await commentOnce(call, repo, number, `logs-watcher-update: ${plain(input.event.event_id || '')}`, rendered.copy.update(plain(input.event.event_id || '')));
  if (commented) return commented;
  log({ msg: 'issue_filed', jobId: job.id, kind: job.kind, sentryIssueId, githubIssue: number });
  return { number };
}

async function ensureLabels(call: Wire, repo: Wire, names: Wire): Promise<Wire> {
  for (const name of [...names] as Wire[]) {
    const res = await call('POST', `${repo}/labels`, { name, color: (LABEL_COLOR as Wire)[name] });
    if (res.status === 422) continue;
    const problem = failure(res);
    if (problem) return problem;
  }
  return null;
}

async function syncLabels(call: Wire, repo: Wire, number: Wire, issue: Wire, names: Wire): Promise<Wire> {
  const have = new Set((issue.labels ?? []).map((label: Wire) => label.name));
  const want = new Set(names);
  for (const name of [...names] as Wire[]) {
    if (have.has(name)) continue;
    const res = await call('POST', `${repo}/issues/${number}/labels`, { labels: [name] });
    const problem = failure(res);
    if (problem) return problem;
  }
  for (const name of [...have] as Wire[]) {
    const managed = name.startsWith('severity:') || name.startsWith('priority:') || name === 'auto-fix:no';
    if (!managed || want.has(name)) continue;
    const res = await call('DELETE', `${repo}/issues/${number}/labels/${encodeURIComponent(name)}`);
    if (res.status === 404) continue;
    const problem = failure(res);
    if (problem) return problem;
  }
  return null;
}

const FIX_COMMENT = new Set(['tests_failed', 'fix_does_not_apply', 'docs_diff_too_large']);

export async function commentFixCode(target: Wire, api: Wire, issueNumber: Wire, code: Wire, call?: Wire): Promise<Wire> {
  if (dryRun()) return null;
  if (!FIX_COMMENT.has(code) || !Number.isInteger(issueNumber)) return null;
  let github: Wire = call;
  if (!github) {
    const session: Wire = await openGithub(target, api);
    if (session.missing) return null;
    if (session.retry || session.dead) return session;
    github = session.call;
  }
  const repo = `/repos/${encodeURIComponent(target.github.owner)}/${encodeURIComponent(target.github.name)}`;
  return commentOnce(github, repo, issueNumber, `logs-watcher-fix: ${code}`, code);
}

// shortcut: markers are checked in the oldest 100 comments, page when an issue passes that.
async function commentOnce(call: Wire, repo: Wire, number: Wire, marker: Wire, line: Wire): Promise<Wire> {
  const listed = await call('GET', `${repo}/issues/${number}/comments?per_page=100`);
  const problem = failure(listed);
  if (problem) return problem;
  const comments = JSON.parse(listed.text);
  if (!Array.isArray(comments)) return { dead: true, status: listed.status };
  if (comments.some((comment: Wire) => String(comment.body ?? '').includes(`<!-- ${marker} -->`))) return null;
  const posted = await call('POST', `${repo}/issues/${number}/comments`, { body: `<!-- ${marker} -->\n${line}` });
  return failure(posted);
}
