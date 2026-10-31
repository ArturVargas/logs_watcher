import { eligible } from './classify.js';
import { dryRun } from './config.js';
import { changedPaths, docsDiffText, docsKey, docsPrompt, docsStop, planDocs, promptFile, reviewDocs } from './docs.js';
import { commentFixCode, failure, openGithub } from './issues.js';
import { pathDenied } from './propose.js';
import { log } from './queue.js';
import { scrub } from './scrub.js';

const TEST_FILE = /\.(test|spec)\.(js|jsx|ts|tsx|py|go|rb)$/;
const COPY = {
  es: {
    changes: 'Qué cambia',
    evidence: 'Evidencia',
    severity: 'Severidad',
    docs: 'Documentación',
    approval: 'Aprobación',
    approvalLine: 'Esta clase exige una persona. La regla general está en la sección Fusión automática.',
    sources: 'Fuentes',
    severityLines: (severity, priority, issue) => `- Clase: ${severity}\n- Prioridad: ${priority}${issue}`,
    sentry: (url) => `- Sentry: ${url}`,
    event: (id) => `- Evento: ${id}`,
    progress: (url) => `- Estado del fix: propuesta-abierta\n- Pull request: ${url}`,
  },
  en: {
    changes: 'What changes',
    evidence: 'Evidence',
    severity: 'Severity',
    docs: 'Documentation',
    approval: 'Approval',
    approvalLine: 'This class needs a person. The general rule is in the Automatic merge section.',
    sources: 'Sources',
    severityLines: (severity, priority, issue) => `- Class: ${severity}\n- Priority: ${priority}${issue}`,
    sentry: (url) => `- Sentry: ${url}`,
    event: (id) => `- Event: ${id}`,
    progress: (url) => `- Fix state: propuesta-abierta\n- Pull request: ${url}`,
  },
};

function readJson(res) {
  try { return JSON.parse(res.text); } catch { return null; }
}

function refName(branch) {
  return `heads/${branch}`.split('/').map(encodeURIComponent).join('/');
}

function isTestPath(path) {
  return path === 'tests' || path === '__tests__' || /(^|\/)(tests|__tests__)(\/|$)/.test(path) || TEST_FILE.test(path);
}

function replaceOnce(original, before, after) {
  if (typeof before !== 'string' || before === '' || typeof after !== 'string') return null;
  const at = original.indexOf(before);
  if (at < 0 || original.indexOf(before, at + before.length) !== -1) return null;
  return original.slice(0, at) + after + original.slice(at + before.length);
}

function payloadOk(payload) {
  if (!payload || !Array.isArray(payload.patches) || payload.patches.length < 1) return false;
  for (const patch of payload.patches) {
    if (!patch || pathDenied(patch.path) || typeof patch.before !== 'string' || typeof patch.after !== 'string') return false;
  }
  for (const file of payload.newTests ?? []) {
    if (!file || typeof file.content !== 'string' || pathDenied(file.path)) return false;
  }
  return true;
}

function commitText(summary, sentryIssueId, issue) {
  const title = scrub(`fix: ${summary ?? ''}`).replace(/[\r\n]+/g, ' ').trim().slice(0, 256) || 'fix';
  const lines = [title, '', `Sentry-Issue: ${scrub(String(sentryIssueId))}`];
  if (Number.isInteger(issue)) lines.push(`GitHub-Issue: ${issue}`);
  return { title, message: scrub(`${lines.join('\n')}\n`) };
}

function sentryUrl(target, id) {
  const marker = scrub(String(id)).replaceAll('"', '');
  return scrub(`${target.sentry.baseUrl.replace(/\/$/, '')}/organizations/${target.sentry.org}/issues/${marker}/`);
}

const DOCS_STATUS = {
  es: { none: 'sin impacto', updated: 'actualizada en este PR', pending: 'pendiente' },
  en: { none: 'no impact', updated: 'updated in this pull request', pending: 'pending' },
};

function pullBody(language, input, hex, docsStatus) {
  const copy = COPY[language];
  const issue = Number.isInteger(input.githubIssueNumber) ? `\n- Issue: #${input.githubIssueNumber}` : '';
  const priority = input.payload.priority || (language === 'en' ? 'no priority' : 'sin prioridad');
  const quotes = (input.payload.evidence ?? []).map((item) => `- ${scrub(item.quote ?? '')}`).join('\n');
  return scrub([
    `<!-- logs-watcher-proposal: ${input.proposalId} -->`,
    `<!-- logs-watcher-generation: ${hex} -->`,
    '',
    `## ${copy.changes}`,
    '',
    scrub(input.payload.summary || ''),
    '',
    `## ${copy.evidence}`,
    '',
    quotes,
    '',
    `## ${copy.severity}`,
    '',
    copy.severityLines(input.payload.class, priority, issue),
    '',
    `## ${copy.docs}`,
    '',
    DOCS_STATUS[language][docsStatus] || DOCS_STATUS[language].none,
    '',
    `## ${copy.approval}`,
    '',
    copy.approvalLine,
    '',
    '/logs-watcher approve',
    '',
    `## ${copy.sources}`,
    '',
    copy.sentry(sentryUrl(input.target, input.sentryIssueId)),
    copy.event(scrub(input.eventId || '')),
    '',
  ].join('\n'));
}

function replaceProgress(body, inner) {
  const matches = [...String(body).matchAll(/<!-- logs-watcher-progress:start -->\n([\s\S]*?)\n<!-- logs-watcher-progress:end -->/g)];
  if (matches.length !== 1) return null;
  const block = `<!-- logs-watcher-progress:start -->\n${matches[0][1]}\n<!-- logs-watcher-progress:end -->`;
  return String(body).replace(block, `<!-- logs-watcher-progress:start -->\n${inner}\n<!-- logs-watcher-progress:end -->`);
}

async function languageOf(pool, input) {
  const stored = (await pool.query(
    `SELECT issue_language FROM groups WHERE target_id = $1 AND sentry_issue_id = $2`,
    [input.target.id, input.sentryIssueId],
  )).rows[0]?.issue_language;
  return stored === 'en' ? 'en' : 'es';
}

async function baseTree(call, repo) {
  const info = await call('GET', repo);
  const infoProblem = failure(info);
  if (infoProblem) return { problem: infoProblem };
  const infoBody = readJson(info);
  const name = infoBody?.default_branch;
  if (typeof name !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(name)) return { missing: true };
  const ref = await call('GET', `${repo}/git/ref/${refName(name)}`);
  const refProblem = failure(ref);
  if (refProblem) return { problem: refProblem };
  const sha = readJson(ref)?.object?.sha;
  if (typeof sha !== 'string') return { problem: { dead: true, status: ref.status } };
  const commit = await call('GET', `${repo}/git/commits/${encodeURIComponent(sha)}`);
  const commitProblem = failure(commit);
  if (commitProblem) return { problem: commitProblem };
  const treeSha = readJson(commit)?.tree?.sha;
  if (typeof treeSha !== 'string') return { problem: { dead: true, status: commit.status } };
  const tree = await call('GET', `${repo}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
  const treeProblem = failure(tree);
  if (treeProblem) return { problem: treeProblem };
  const treeBody = readJson(tree);
  if (!treeBody) return { problem: { dead: true, status: tree.status } };
  return { name, sha, treeSha, entries: treeBody.tree ?? [], truncated: treeBody.truncated === true };
}

function layoutGate(entries, payload, truncated) {
  // shortcut: a truncated tree skips the test-layout gate; page the tree when a repository exceeds one response.
  if (truncated) return { testsMissing: false };
  const layout = entries.some((item) => isTestPath(item.path || ''));
  const addsTest = (payload.newTests ?? []).some((file) => isTestPath(file.path));
  if (layout && !addsTest) return { blocked: true };
  return { testsMissing: !layout && !addsTest };
}

async function readContents(call, repo, sha, filePath) {
  const res = await call('GET', `${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(sha)}`);
  if (res.status === 404) return { missing: true };
  const problem = failure(res);
  if (problem) return { problem };
  const body = readJson(res);
  // shortcut: the contents API omits content for a large file; that patch is not opened.
  if (typeof body?.content !== 'string') return { missing: true };
  return { text: Buffer.from(body.content.replace(/\s/g, ''), 'base64').toString('utf8') };
}

async function changedFiles(call, repo, sha, payload) {
  const files = new Map();
  for (const patch of payload.patches) {
    let text = files.get(patch.path);
    if (text == null) {
      const read = await readContents(call, repo, sha, patch.path);
      if (read.problem || read.missing) return read;
      text = read.text;
    }
    const updated = replaceOnce(text, patch.before, patch.after);
    if (updated == null) return { missing: true };
    files.set(patch.path, updated);
  }
  for (const file of payload.newTests ?? []) files.set(file.path, file.content);
  return { files };
}

async function publish(call, repo, { branch, message, baseSha, treeSha, payload }) {
  const changed = await changedFiles(call, repo, baseSha, payload);
  if (changed.problem || changed.missing) return changed;
  const tree = [];
  for (const [path, content] of changed.files) {
    const blob = await call('POST', `${repo}/git/blobs`, { content, encoding: 'utf-8' });
    const blobProblem = failure(blob);
    if (blobProblem) return { problem: blobProblem };
    const sha = readJson(blob)?.sha;
    if (!sha) return { problem: { dead: true, status: blob.status } };
    tree.push({ path, mode: '100644', type: 'blob', sha });
  }
  const made = await call('POST', `${repo}/git/trees`, { base_tree: treeSha, tree });
  const madeProblem = failure(made);
  if (madeProblem) return { problem: madeProblem };
  const nextTree = readJson(made)?.sha;
  if (!nextTree) return { problem: { dead: true, status: made.status } };
  const commit = await call('POST', `${repo}/git/commits`, { message, tree: nextTree, parents: [baseSha] });
  const commitProblem = failure(commit);
  if (commitProblem) return { problem: commitProblem };
  const headSha = readJson(commit)?.sha;
  if (!headSha) return { problem: { dead: true, status: commit.status } };
  const ref = await call('POST', `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: headSha });
  if (ref.status === 422 || ref.status === 409) return { headSha, treeSha: nextTree };
  const refProblem = failure(ref);
  if (refProblem) return { problem: refProblem };
  return { headSha, treeSha: nextTree };
}

async function listPull(call, repo, owner, branch) {
  const res = await call('GET', `${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=20`);
  const problem = failure(res);
  if (problem) return { problem };
  const items = readJson(res);
  if (!Array.isArray(items)) return { problem: { dead: true, status: res.status } };
  return { pull: items.find((item) => item?.head?.ref === branch) ?? null };
}

async function createPull(call, repo, { title, branch, base, body }) {
  const res = await call('POST', `${repo}/pulls`, { title, head: branch, base, body });
  if (res.status === 422) return { exists: true };
  const problem = failure(res);
  if (problem) return { problem };
  const pull = readJson(res);
  if (!Number.isInteger(pull?.number)) return { problem: { dead: true, status: res.status } };
  return { pull };
}

async function addTestsMissing(call, repo, number) {
  const made = await call('POST', `${repo}/labels`, { name: 'tests:missing', color: 'a16207' });
  if (made.status !== 422) {
    const problem = failure(made);
    if (problem) return problem;
  }
  const res = await call('POST', `${repo}/issues/${number}/labels`, { labels: ['tests:missing'] });
  return failure(res);
}

async function noteOpen(call, repo, input, language, url) {
  if (!Number.isInteger(input.githubIssueNumber)) return null;
  const got = await call('GET', `${repo}/issues/${input.githubIssueNumber}`);
  const problem = failure(got);
  if (problem) return problem;
  const issue = readJson(got);
  if (!issue) return { dead: true, status: got.status };
  const inner = COPY[language].progress(scrub(url));
  const body = replaceProgress(issue.body || '', inner);
  if (body == null) {
    log({ msg: 'progress_stale', jobId: input.job.id, kind: input.job.kind, sentryIssueId: input.sentryIssueId, githubIssue: input.githubIssueNumber });
    return null;
  }
  if (body === issue.body) return null;
  const patched = await call('PATCH', `${repo}/issues/${input.githubIssueNumber}`, { body });
  return failure(patched);
}

async function commitOnto(call, repo, { branch, parentSha, treeSha, files }) {
  const tree = [];
  for (const file of files) {
    const blob = await call('POST', `${repo}/git/blobs`, { content: file.content, encoding: 'utf-8' });
    const blobProblem = failure(blob);
    if (blobProblem) return { problem: blobProblem };
    const sha = readJson(blob)?.sha;
    if (!sha) return { problem: { dead: true, status: blob.status } };
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha });
  }
  const made = await call('POST', `${repo}/git/trees`, { base_tree: treeSha, tree });
  const madeProblem = failure(made);
  if (madeProblem) return { problem: madeProblem };
  const nextTree = readJson(made)?.sha;
  if (!nextTree) return { problem: { dead: true, status: made.status } };
  const commit = await call('POST', `${repo}/git/commits`, { message: 'docs: update\n', tree: nextTree, parents: [parentSha] });
  const commitProblem = failure(commit);
  if (commitProblem) return { problem: commitProblem };
  const headSha = readJson(commit)?.sha;
  if (!headSha) return { problem: { dead: true, status: commit.status } };
  const ref = await call('PATCH', `${repo}/git/refs/${refName(branch)}`, { sha: headSha });
  const refProblem = failure(ref);
  if (refProblem) return { problem: refProblem };
  return { headSha };
}

function traced(input, msg) {
  log({ msg, jobId: input.job.id, kind: input.job.kind, sentryIssueId: input.sentryIssueId });
}

async function storePendingDocs(pool, input, headSha, paths, baseSha, model) {
  let payload = { dryRun: false };
  try {
    payload = JSON.parse(scrub(JSON.stringify({
      dryRun: false,
      noChange: model?.noChange === true,
      evidence: model?.evidence ?? [],
      patches: model?.patches ?? [],
      newSections: model?.newSections ?? [],
    })));
  } catch { /* keep the empty payload */ }
  await pool.query(
    `INSERT INTO proposals (id, target_id, kind, generation_key, state, sentry_issue_id, github_issue_number, github_pr_number, base_sha, head_sha, target_hash, payload, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'docs', $2, 'pending', $3, $4, NULL, $5, $6, NULL, $7::jsonb, now(), now())
     ON CONFLICT (generation_key) DO NOTHING`,
    [input.target.id, docsKey(input.target.id, input.sentryIssueId, headSha, paths), input.sentryIssueId, input.githubIssueNumber, baseSha, headSha, JSON.stringify(payload)],
  );
}

async function driftFix(pool, input, call, repo, { branch, headSha, treeSha, entries, baseSha }) {
  const paths = changedPaths(input.payload);
  const early = docsStop(paths);
  if (early === 'too_large') {
    traced(input, 'docs_diff_too_large');
    const commented = await commentFixCode(input.target, input.api, input.githubIssueNumber, 'docs_diff_too_large', call);
    if (commented) return commented;
    return { status: 'none' };
  }
  if (early === 'markdown') return { status: 'none' };
  // shortcut: a truncated tree can miss docs candidates; page the tree when a repository exceeds one response.
  const docPaths = entries.filter((item) => item?.type !== 'tree' && String(item?.path || '').startsWith('docs/')).map((item) => item.path);
  if (!docPaths.length) return { status: 'none' };
  const map = await readContents(call, repo, headSha, 'docs/map.yml');
  if (map.problem) return map.problem;
  const plan = await planDocs({
    paths,
    mapText: map.missing ? null : map.text,
    docPaths,
    patches: input.payload.patches,
    newTests: input.payload.newTests,
    read: (filePath) => readContents(call, repo, headSha, filePath).then((loaded) => {
      if (loaded.problem || loaded.missing) return loaded;
      return { text: loaded.text };
    }),
  });
  if (plan.problem) return plan.problem;
  if (plan.mapInvalid) traced(input, 'docs_map_invalid');
  if (plan.stop === 'empty_large') traced(input, 'docs_prefilter_empty_large_corpus');
  if (plan.stop || !plan.candidates?.length) return { status: 'none' };
  const key = docsKey(input.target.id, input.sentryIssueId, headSha, paths);
  const prior = await pool.query(`SELECT state FROM proposals WHERE generation_key = $1`, [key]);
  if (prior.rowCount) return { status: 'pending' };
  const files = [];
  for (const filePath of plan.candidates) {
    const loaded = await readContents(call, repo, headSha, filePath);
    if (loaded.problem) return loaded.problem;
    if (loaded.missing || typeof loaded.text !== 'string') continue;
    files.push({ path: filePath, ...promptFile(loaded.text) });
  }
  const diffText = scrub(docsDiffText(input.payload));
  const built = docsPrompt(diffText, files, input.promptCap || 80000);
  if (!built.files.length || typeof input.askDocs !== 'function') return { status: 'none' };
  const asked = await input.askDocs(built.prompt);
  if (!asked || asked.deferred || asked.retry || asked.dead) return asked || { status: 'none' };
  if (!asked.parsed) {
    await storePendingDocs(pool, input, headSha, paths, baseSha, {});
    return { status: 'pending' };
  }
  const reviewed = reviewDocs(asked.parsed, { files: built.files, diffText });
  if (reviewed.pending) {
    await storePendingDocs(pool, input, headSha, paths, baseSha, asked.parsed);
    return { status: 'pending' };
  }
  if (!reviewed.files.length) return { status: 'none' };
  const committed = await commitOnto(call, repo, { branch, parentSha: headSha, treeSha, files: reviewed.files });
  if (committed.problem) return committed.problem;
  return { status: 'updated', headSha: committed.headSha };
}

async function finish(pool, input, call, repo, pull, headSha, testsMissing, language) {
  const number = pull.number;
  const url = pull.html_url || `https://github.com/${input.target.github.owner}/${input.target.github.name}/pull/${number}`;
  if (input.prNumber == null) {
    await pool.query(
      `UPDATE proposals SET github_pr_number = $2, head_sha = COALESCE($3, head_sha), updated_at = now() WHERE id = $1`,
      [input.proposalId, number, headSha],
    );
    log({ msg: 'pr_opened', jobId: input.job.id, kind: input.job.kind, sentryIssueId: input.sentryIssueId, proposalId: input.proposalId, pr: number });
  }
  if (testsMissing) {
    const labeled = await addTestsMissing(call, repo, number);
    if (labeled) return labeled;
  }
  const noted = await noteOpen(call, repo, input, language, url);
  if (noted) return noted;
  return { number };
}

export async function openFixPull(pool, input) {
  if (dryRun() || !eligible(input.payload?.class)) return { number: null };
  const hex = /^fix:([0-9a-f]{64})$/.exec(input.generationKey)?.[1];
  if (!hex || !payloadOk(input.payload) || !/^[A-Za-z0-9._-]+$/.test(String(input.sentryIssueId))) return { number: null };
  if (input.prNumber == null) {
    const prior = await pool.query(
      `SELECT 1 FROM proposals WHERE target_id = $1 AND sentry_issue_id = $2 AND kind = 'fix' AND github_pr_number IS NOT NULL AND id <> $3 LIMIT 1`,
      [input.target.id, input.sentryIssueId, input.proposalId],
    );
    if (prior.rowCount) return { number: null };
  }
  const session = await openGithub(input.target, input.api);
  if (session.missing) return { number: null };
  if (session.retry || session.dead) return session;
  const call = session.call;
  const owner = input.target.github.owner;
  const repo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(input.target.github.name)}`;
  const branch = `logs-watcher/fix-${input.target.id}-${input.sentryIssueId}-${hex.slice(0, 8)}`;
  const language = await languageOf(pool, input);
  const { title, message } = commitText(input.payload.summary, input.sentryIssueId, input.githubIssueNumber);
  const base = await baseTree(call, repo);
  if (base.problem) return base.problem;
  if (base.missing) return { number: null };
  const gate = layoutGate(base.entries, input.payload, base.truncated);
  if (gate.blocked && input.prNumber == null) return { number: null };

  let pull = null;
  let headSha = null;
  if (input.prNumber == null) {
    const ref = await call('GET', `${repo}/git/ref/${refName(branch)}`);
    if (ref.status !== 404) {
      const refProblem = failure(ref);
      if (refProblem) return refProblem;
      headSha = readJson(ref)?.object?.sha ?? null;
      const listed = await listPull(call, repo, owner, branch);
      if (listed.problem) return listed.problem;
      pull = listed.pull;
    }
    if (!pull) {
      let treeSha = null;
      if (ref.status === 404) {
        const published = await publish(call, repo, { branch, message, baseSha: base.sha, treeSha: base.treeSha, payload: input.payload });
        if (published.problem) return published.problem;
        if (published.missing) {
          const commented = await commentFixCode(input.target, input.api, input.githubIssueNumber, 'fix_does_not_apply', call);
          if (commented) return commented;
          return { number: null };
        }
        headSha = published.headSha;
        treeSha = published.treeSha ?? null;
      }
      let docsStatus = 'none';
      if (ref.status !== 404 && headSha) {
        const seen = await call('GET', `${repo}/git/commits/${encodeURIComponent(headSha)}`);
        if (seen.status !== 404) {
          const seenProblem = failure(seen);
          if (seenProblem) return seenProblem;
          const seenBody = readJson(seen);
          if (String(seenBody?.message || '').startsWith('docs: update')) docsStatus = 'updated';
          else treeSha = seenBody?.tree?.sha ?? null;
        }
      }
      if (docsStatus !== 'updated' && treeSha) {
        const drifted = await driftFix(pool, input, call, repo, {
          branch, headSha, treeSha, entries: base.entries, baseSha: base.sha,
        });
        if (drifted?.deferred || drifted?.retry || drifted?.dead) return drifted;
        docsStatus = drifted.status;
        if (drifted.headSha) headSha = drifted.headSha;
      }
      const body = pullBody(language, input, hex, docsStatus);
      const created = await createPull(call, repo, { title, branch, base: base.name, body });
      if (created.problem) return created.problem;
      if (created.exists) {
        const listed = await listPull(call, repo, owner, branch);
        if (listed.problem) return listed.problem;
        if (!listed.pull) return { number: null };
        pull = listed.pull;
      } else {
        pull = created.pull;
      }
    }
  } else {
    pull = {
      number: input.prNumber,
      html_url: `https://github.com/${owner}/${input.target.github.name}/pull/${input.prNumber}`,
    };
  }
  return finish(pool, input, call, repo, pull, headSha, gate.testsMissing, language);
}
