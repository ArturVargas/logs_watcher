import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { dryRun, stripJsonComments } from './config.js';
import { scrub } from './scrub.js';

const NAMES = new Set([
  'package.json', 'pnpm-workspace.yaml', 'pyproject.toml', 'go.mod', 'Gemfile',
  'requirements.txt', 'Cargo.toml', 'Dockerfile', 'docker-compose.yml',
]);
const SUFFIXES = [
  '.env', '.pem', '.key', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'bun.lock', 'bun.lockb', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'poetry.lock', 'composer.lock',
];
const RETRY = new Set(['quote_missing', 'before_not_unique', 'path_denied', 'empty_catch', 'schema_invalid', 'test_required']);

export function pathDenied(filePath) {
  if (typeof filePath !== 'string' || filePath === '' || filePath.startsWith('/') || filePath.includes('\\')) return true;
  const parts = filePath.split('/');
  if (parts.includes('..') || parts.includes('')) return true;
  if (filePath.startsWith('.git/') || filePath.startsWith('.github/') || filePath.startsWith('secrets/')) return true;
  const base = parts[parts.length - 1];
  if (NAMES.has(base)) return true;
  return SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

function lineCount(text) {
  if (!text) return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

function occurrences(hay, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = hay.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function braceBody(src, openIndex) {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escape = false;
  for (let i = openIndex; i < src.length; i += 1) {
    const c = src[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = true;
      quote = c;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(openIndex + 1, i);
    }
  }
  return null;
}

function maskLiterals(text) {
  let out = '';
  let quote = '';
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (quote) {
      out += c === '\n' ? '\n' : ' ';
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += ' ';
      continue;
    }
    if ((c === '/' && n === '/') || (c === '/' && n === '*')) {
      const block = n === '*';
      out += '  ';
      i += 1;
      while (i + 1 < text.length && (block ? !(text[i + 1] === '*' && text[i + 2] === '/') : text[i + 1] !== '\n')) {
        i += 1;
        out += text[i] === '\n' ? '\n' : ' ';
      }
      if (block && text[i + 1] === '*' && text[i + 2] === '/') {
        out += '  ';
        i += 2;
      }
      continue;
    }
    out += c;
  }
  return out;
}

export function hasEmptyCatch(src) {
  const code = String(src ?? '');
  const masked = maskLiterals(code);
  const re = /\bcatch\s*(?:\([^)]*\))?\s*\{/g;
  let match;
  while ((match = re.exec(masked))) {
    const open = match.index + match[0].length - 1;
    const body = braceBody(code, open);
    const stripped = stripJsonComments(body ?? '').replace(/\s+/g, '');
    if (!stripped.includes('throw') && !stripped.includes('console.') && !stripped.includes('logger') && !stripped.includes('log(')) {
      return true;
    }
  }
  return false;
}

function fail(code) {
  return { ok: false, code, retry: RETRY.has(code) };
}

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'logs-watcher',
      GIT_AUTHOR_EMAIL: 'logs-watcher@localhost',
      GIT_COMMITTER_NAME: 'logs-watcher',
      GIT_COMMITTER_EMAIL: 'logs-watcher@localhost',
    },
  });
}

function inside(root, filePath) {
  const full = resolve(root, filePath);
  const base = resolve(root);
  return full === base || full.startsWith(base + sep);
}

function realDiff(patch, original) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-diff-'));
  const before = join(dir, 'before');
  const after = join(dir, 'after');
  try {
    const at = original.indexOf(patch.before);
    writeFileSync(before, original);
    writeFileSync(after, original.slice(0, at) + patch.after + original.slice(at + patch.before.length));
    const result = spawnSync('diff', ['-u', before, after], { encoding: 'utf8' });
    if (result.status > 1) return null;
    const body = (result.stdout || '').replace(/^--- .*$/m, `--- a/${patch.path}`).replace(/^\+\+\+ .*$/m, `+++ b/${patch.path}`);
    return `diff --git a/${patch.path} b/${patch.path}\n${body}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mismatchDiff(patch) {
  const removed = patch.before.split('\n')[0] || 'x';
  const added = patch.after.split('\n')[0] || 'y';
  return `diff --git a/${patch.path} b/${patch.path}\n--- a/${patch.path}\n+++ b/${patch.path}\n@@ -1,2 +1,2 @@\n logs-watcher-apply-mismatch\n-${removed}\n+${added}\n`;
}

// shortcut: no target mirror in this slice, so a missing repo is seeded from patch before-text; use the mirror when the fix loop clones.
export function seedRepo(patches) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-seed-'));
  git(dir, ['init', '-b', 'main']);
  for (const patch of patches ?? []) {
    if (!patch || pathDenied(patch.path) || typeof patch.before !== 'string') continue;
    const full = join(dir, patch.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, patch.before);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--allow-empty', '-m', 'seed']);
  return dir;
}

function applyCheck(repoDir, diffText) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-apply-'));
  const patchFile = join(tmpdir(), `lw-${createHash('sha256').update(diffText).digest('hex').slice(0, 12)}.diff`);
  try {
    spawnSync('cp', ['-a', `${repoDir}/.`, dir]);
    writeFileSync(patchFile, diffText);
    const applied = git(dir, ['apply', '--check', patchFile]);
    return applied.status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(patchFile, { force: true });
  }
}

function evidenceOk(evidence, eventText, files) {
  if (!Array.isArray(evidence) || evidence.length < 1) return false;
  const fileText = files.map((file) => scrub(file.text)).join('\n');
  for (const item of evidence) {
    if (!item || !['event', 'file', 'issue'].includes(item.source)) return false;
    if (typeof item.quote !== 'string' || item.quote.length < 8) return false;
    const hay = item.source === 'file' ? fileText : eventText;
    if (!hay.includes(item.quote)) return false;
  }
  return true;
}

export function reviewFix({ targetId, sentryIssueId, eventId, eventText, repoDir, model, limits, severityClass, priority, files }) {
  if (!model || typeof model !== 'object') return fail('schema_invalid');
  if (!['none', 'insufficient_evidence', 'unsafe_scope', 'no_code_fix'].includes(model.refusal)) return fail('schema_invalid');
  if (model.refusal !== 'none') return { ok: false, code: model.refusal, retry: false };
  if (typeof model.summary !== 'string' || model.summary.length === 0 || model.summary.length > 400) return fail('schema_invalid');
  const patches = model.patches;
  const newTests = model.newTests ?? [];
  if (!Array.isArray(patches) || !Array.isArray(newTests)) return fail('schema_invalid');
  if (patches.length < 1 || patches.length > limits.maxFixFiles) return fail('schema_invalid');
  if (!evidenceOk(model.evidence, eventText, files)) return fail('quote_missing');
  let lines = 0;
  const diffs = [];
  for (const patch of patches) {
    if (!patch || pathDenied(patch.path) || typeof patch.before !== 'string' || typeof patch.after !== 'string') return fail('path_denied');
    if (!inside(repoDir, patch.path)) return fail('path_denied');
    if (hasEmptyCatch(patch.after)) return fail('empty_catch');
    lines += lineCount(patch.before) + lineCount(patch.after);
    if (lines > limits.maxFixChangedLines) return fail('schema_invalid');
    const full = join(repoDir, patch.path);
    const original = existsSync(full) ? readFileSync(full, 'utf8') : '';
    const count = occurrences(original, patch.before);
    if (count > 1) return fail('before_not_unique');
    const diff = count === 1 ? realDiff(patch, original) : mismatchDiff(patch);
    if (!diff) return fail('fix_does_not_apply');
    diffs.push(diff);
  }
  if (!applyCheck(repoDir, diffs.join(''))) return { ok: false, code: 'fix_does_not_apply', retry: false };
  const head = git(repoDir, ['rev-parse', 'HEAD']);
  if (head.status !== 0) return { ok: false, code: 'fix_does_not_apply', retry: false };
  const baseSha = head.stdout.trim();
  const hash = createHash('sha256');
  for (const patch of [...patches].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(patch.path);
    hash.update('\0');
    hash.update(readFileSync(join(repoDir, patch.path)));
  }
  const generationKey = `fix:${createHash('sha256').update(`fix\n${targetId}\n${sentryIssueId}\n${eventId}\n${baseSha}`).digest('hex')}`;
  let payload;
  try {
    payload = JSON.parse(scrub(JSON.stringify({
      dryRun: dryRun(),
      refusal: 'none',
      summary: model.summary,
      evidence: model.evidence,
      patches,
      newTests,
      class: severityClass,
      priority,
    })));
  } catch {
    return fail('schema_invalid');
  }
  return { ok: true, generationKey, baseSha, targetHash: hash.digest('hex'), payload };
}
