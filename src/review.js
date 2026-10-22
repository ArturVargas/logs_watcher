import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dryRun } from './config.js';
import { openGithub } from './issues.js';
import { scrub } from './scrub.js';

const CHAINS = {
  solidity: ['slither', 'aderyn', 'solhint'],
  rust: ['clippy', 'cargo-audit', 'cargo-deny'],
  typescript: ['eslint', 'tsc'],
};
const SKIP = new Set(['if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'return', 'new', 'await', 'typeof', 'throw', 'case', 'delete', 'void', 'function', 'fn', 'impl', 'match', 'loop', 'unsafe']);
const SECRET_ENV = ['DATABASE_URL', 'LLM_API_KEY', 'SENTRY_AUTH_TOKEN', 'SENTRY_WEBHOOK_SECRET', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_PRIVATE_KEY_PATH', 'POSTHOG_API_KEY'];

export function languageOf(file) {
  const path = String(file ?? '');
  if (path.endsWith('.sol')) return 'solidity';
  if (path.endsWith('.rs')) return 'rust';
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  return null;
}

function safeRelative(file) {
  if (typeof file !== 'string' || file === '' || file.startsWith('/') || file.includes('\\')) return false;
  return !file.split('/').includes('..') && !file.split('/').includes('');
}

export function addedLines(patch) {
  const lines = new Set();
  let next = 0;
  for (const line of String(patch ?? '').split('\n')) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (!next || line.startsWith('\\')) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) lines.add(next);
    if (line.startsWith('-') && !line.startsWith('---')) continue;
    next += 1;
  }
  return lines;
}

function scanLine(raw, language, state) {
  let { quote, block } = state;
  let code = '';
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    const n = raw[i + 1];
    if (block) {
      if (c === '*' && n === '/') {
        block = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && n === '/') break;
    if (c === '/' && n === '*') {
      block = true;
      i += 1;
      continue;
    }
    if (c === '"' || c === '`' || (c === "'" && language !== 'rust')) {
      quote = c;
      continue;
    }
    if (c === "'" && language === 'rust') {
      if (n === '\\') i += 3;
      else if (raw[i + 2] === "'") i += 2;
      continue;
    }
    code += c;
  }
  return { code, quote, block };
}

function declaration(code, language) {
  if (language === 'solidity') {
    const named = code.match(/\b(?:contract|library|interface|function|modifier|struct|enum|error|event)\s+([A-Za-z_]\w*)/);
    if (named) return { name: named[1], keyword: true };
  } else if (language === 'rust') {
    const text = code.replace(/\b(?:pub(?:\([^)]*\))?|async|unsafe|const|extern)\b/g, ' ');
    const fn = text.match(/\bfn\s+([A-Za-z_]\w*)/);
    if (fn) return { name: fn[1], keyword: true };
    const item = text.match(/\b(?:struct|enum|trait|mod|type)\s+([A-Za-z_]\w*)/);
    if (item) return { name: item[1], keyword: true };
    const impl = text.match(/\bimpl(?:\s*<[^>{]*>)?\s+(?:[A-Za-z_]\w*\s+for\s+)?([A-Za-z_]\w*)/);
    if (impl) return { name: impl[1], keyword: true };
  } else if (language === 'typescript') {
    const named = code.match(/\b(?:function|class|interface|enum|type)\s+([A-Za-z_]\w*)/);
    if (named) return { name: named[1], keyword: true };
    const arrow = code.match(/\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>/);
    if (arrow) return { name: arrow[1], keyword: true };
  }
  const method = code.match(/^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|async\s+|static\s+|override\s+|readonly\s+|get\s+|set\s+|external\s+|internal\s+|payable\s+)*([A-Za-z_]\w*)\s*(?:<[^>{]*>)?\s*\(/);
  if (method && !SKIP.has(method[1])) return { name: method[1], keyword: false };
  return null;
}

// shortcut: strings, comments, and Rust raw strings are skipped naively; revisit when a symbol range lands on the wrong line.
export function enclosingSymbol(source, line, language) {
  if (!CHAINS[language] || !Number.isInteger(line)) return null;
  const lines = String(source ?? '').split('\n');
  const done = [];
  const stack = [];
  let depth = 0;
  let pending = null;
  let state = { quote: '', block: false };
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = scanLine(lines[i], language, state);
    state = { quote: parsed.quote, block: parsed.block };
    const decl = declaration(parsed.code, language);
    if (decl && (decl.keyword || parsed.code.includes('{'))) pending = { name: decl.name, start: i + 1 };
    for (const char of parsed.code) {
      if (char === '{') {
        depth += 1;
        if (pending) {
          stack.push({ name: pending.name, start: pending.start, depth });
          pending = null;
        }
      } else if (char === '}') {
        while (stack.length && stack[stack.length - 1].depth === depth) {
          const symbol = stack.pop();
          symbol.end = i + 1;
          done.push(symbol);
        }
        depth = Math.max(0, depth - 1);
      }
    }
  }
  for (const symbol of stack) done.push({ ...symbol, end: lines.length });
  let best = null;
  for (const symbol of done) {
    if (line < symbol.start || line > symbol.end) continue;
    if (!best || symbol.start >= best.start) best = symbol;
  }
  return best ? { name: best.name, start: best.start, end: best.end } : null;
}

function onPath(bin) {
  const result = spawnSync('which', [bin], { encoding: 'utf8' });
  return result.status === 0;
}

export function defaultAvailable(tool, { repoDir } = {}) {
  if (tool === 'eslint') return Boolean(repoDir) && existsSync(join(repoDir, 'node_modules/.bin/eslint'));
  if (tool === 'tsc') return Boolean(repoDir) && existsSync(join(repoDir, 'node_modules/.bin/tsc'));
  if (!repoDir) return false;
  if (tool === 'clippy') return onPath('cargo') && existsSync(join(repoDir, 'Cargo.toml'));
  if (tool === 'cargo-audit') return onPath('cargo-audit') && existsSync(join(repoDir, 'Cargo.lock'));
  if (tool === 'cargo-deny') return onPath('cargo-deny') && existsSync(join(repoDir, 'Cargo.toml'));
  if (tool === 'slither' || tool === 'aderyn' || tool === 'solhint') return onPath(tool);
  return false;
}

function commandFor(tool, file, repoDir) {
  if (tool === 'slither') return { cmd: 'slither', args: [file, '--json', '-'] };
  if (tool === 'aderyn') return { cmd: 'aderyn', args: ['--stdout', '-o', join(tmpdir(), `aderyn-${process.pid}.json`)] };
  if (tool === 'solhint') return { cmd: 'solhint', args: ['--formatter', 'json', file] };
  if (tool === 'clippy') return { cmd: 'cargo', args: ['clippy', '--message-format=json'] };
  if (tool === 'cargo-audit') return { cmd: 'cargo', args: ['audit', '--json'] };
  if (tool === 'cargo-deny') return { cmd: 'cargo', args: ['deny', '--format', 'json', 'check'] };
  if (!repoDir) return null;
  if (tool === 'eslint') return { cmd: join(repoDir, 'node_modules/.bin/eslint'), args: ['-f', 'json', file] };
  if (tool === 'tsc') return { cmd: join(repoDir, 'node_modules/.bin/tsc'), args: ['--noEmit', '--pretty', 'false'] };
  return null;
}

function toolEnv() {
  const env = { ...process.env };
  for (const key of SECRET_ENV) delete env[key];
  return env;
}

function runTool(tool, { file, repoDir }) {
  const spec = commandFor(tool, file, repoDir);
  if (!spec) return Promise.resolve({ ran: false, stdout: '' });
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn(spec.cmd, spec.args, { cwd: repoDir, env: toolEnv(), timeout: 300_000 });
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr?.on('data', () => {});
    child.on('error', (err) => finish({ ran: err.code !== 'ENOENT', stdout: '' }));
    child.on('close', (code, signal) => finish({ ran: signal == null, stdout }));
  });
}

function level(value) {
  const text = String(value ?? '').toLowerCase();
  if (text === '2' || text === '3' || text === 'error' || text === 'high' || text === 'critical') return 'error';
  if (text === '1' || text === 'warning' || text === 'medium' || text === 'moderate' || text === 'low') return 'warning';
  return 'info';
}

function makeFinding(fields, expected) {
  const reported = String(fields.file || expected || '').replaceAll('\\', '/').replace(/^\.\//, '');
  const file = reported === expected || reported.endsWith(`/${expected}`) ? expected : null;
  const line = Number(fields.line);
  const rule = String(fields.rule_id || '').trim();
  if (!file || !safeRelative(file) || !Number.isInteger(line) || line < 1 || !rule || rule.length > 200) return null;
  return {
    file,
    line,
    rule_id: rule,
    severity: level(fields.severity),
    message: scrub(String(fields.message || '')).replace(/[\r\n]+/g, ' ').trim().slice(0, 500),
  };
}

function jsonValues(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  try { return [JSON.parse(raw)]; } catch { /* one value per line, or a report wrapped in logs */ }
  const values = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    try { values.push(JSON.parse(trimmed)); } catch { /* not a whole json line */ }
  }
  if (values.length) return values;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { values.push(JSON.parse(raw.slice(start, end + 1))); } catch { /* no object */ }
  }
  return values;
}

function parseLint(values, file) {
  const out = [];
  for (const value of values) {
    for (const report of Array.isArray(value) ? value : [value]) {
      for (const item of report?.messages || report?.errors || []) {
        out.push(makeFinding({
          file: item?.filePath || report?.filePath || file,
          line: item?.line,
          rule_id: item?.ruleId,
          severity: item?.severity,
          message: item?.message,
        }, file));
      }
    }
  }
  return out.filter(Boolean);
}

function parseSlither(values, file) {
  const out = [];
  for (const value of values) {
    for (const detector of value?.results?.detectors ?? []) {
      const mapping = (detector.elements ?? []).find((item) => item?.source_mapping?.lines?.length)?.source_mapping;
      out.push(makeFinding({
        file: mapping?.filename_relative || file,
        line: mapping?.lines?.[0],
        rule_id: detector.check,
        severity: detector.impact,
        message: detector.description,
      }, file));
    }
  }
  return out.filter(Boolean);
}

function parseAderyn(values, file) {
  const out = [];
  for (const value of values) {
    for (const [key, severity] of [['high_issues', 'high'], ['low_issues', 'low']]) {
      for (const issue of value?.[key]?.issues ?? []) {
        for (const instance of issue.instances ?? []) {
          out.push(makeFinding({
            file: instance.contract_path,
            line: instance.line_no,
            rule_id: issue.detector_name,
            severity,
            message: issue.description || issue.title,
          }, file));
        }
      }
    }
  }
  return out.filter(Boolean);
}

function parseClippy(values, file) {
  const out = [];
  for (const value of values) {
    if (value.reason !== 'compiler-message') continue;
    const span = (value.message?.spans ?? []).find((item) => item.is_primary) || value.message?.spans?.[0];
    out.push(makeFinding({
      file: span?.file_name,
      line: span?.line_start,
      rule_id: value.message?.code?.code,
      severity: value.message?.level,
      message: value.message?.message,
    }, file));
  }
  return out.filter(Boolean);
}

// cargo-audit advisories have no source line; without one there is nothing to cite.
function parseAudit(values, file) {
  const out = [];
  for (const value of values) {
    for (const item of value?.vulnerabilities?.list ?? []) {
      out.push(makeFinding({
        file,
        line: item?.line,
        rule_id: item?.advisory?.id,
        severity: item?.advisory?.severity || item?.advisory?.cvss?.severity,
        message: item?.advisory?.title,
      }, file));
    }
  }
  return out.filter(Boolean);
}

function parseDeny(values, file) {
  const out = [];
  for (const value of values) {
    if (value.type && value.type !== 'diagnostic') continue;
    const fields = value.fields || value;
    const label = (fields.labels ?? []).find((item) => item?.line != null || item?.line_start != null);
    out.push(makeFinding({
      file: label?.path || label?.file || file,
      line: label?.line ?? label?.line_start,
      rule_id: fields.code,
      severity: fields.severity,
      message: fields.message,
    }, file));
  }
  return out.filter(Boolean);
}

function parseTsc(stdout, file) {
  const out = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const match = line.match(/^(.+)\((\d+),\d+\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/);
    if (!match) continue;
    out.push(makeFinding({ file: match[1], line: Number(match[2]), rule_id: match[4], severity: match[3], message: match[5] }, file));
  }
  return out.filter(Boolean);
}

function parseFindings(tool, stdout, file) {
  if (tool === 'tsc') return parseTsc(stdout, file);
  const values = jsonValues(stdout);
  if (tool === 'slither') return parseSlither(values, file);
  if (tool === 'aderyn') return parseAderyn(values, file);
  if (tool === 'solhint' || tool === 'eslint') return parseLint(values, file);
  if (tool === 'clippy') return parseClippy(values, file);
  if (tool === 'cargo-audit') return parseAudit(values, file);
  if (tool === 'cargo-deny') return parseDeny(values, file);
  return [];
}

export async function oneCheck({ language, file, repoDir, available = defaultAvailable, run = runTool }) {
  const chain = CHAINS[language];
  if (!chain) return null;
  for (const tool of chain) {
    if (!available(tool, { file, repoDir })) continue;
    const result = await run(tool, { file, repoDir });
    if (!result || result.ran === false) continue;
    return { tool, findings: parseFindings(tool, result.stdout ?? '', file) };
  }
  return null;
}

export function selectCitation({ path, content, patch, findings }) {
  const language = languageOf(path);
  if (!language || !Array.isArray(findings)) return null;
  const changed = [...addedLines(patch)].sort((a, b) => a - b);
  if (!changed.length) return null;
  const symbols = new Map(changed.map((line) => [line, enclosingSymbol(content, line, language)]));
  for (const finding of findings) {
    if (finding.file !== path || !finding.rule_id || !Number.isInteger(finding.line)) continue;
    const hit = enclosingSymbol(content, finding.line, language);
    const anchor = changed.find((line) => {
      if (line === finding.line) return true;
      const symbol = symbols.get(line);
      return hit && symbol && symbol.name === hit.name && symbol.start === hit.start;
    });
    if (!anchor) continue;
    return { finding, anchor, path };
  }
  return null;
}

function watchedFiles(files) {
  return [...(files ?? [])]
    .filter((file) => languageOf(file?.path) && safeRelative(file.path) && addedLines(file.patch).size)
    .sort((a, b) => a.path.localeCompare(b.path));
}

function git(args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env, timeout: 300_000 });
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
    child.on('error', () => resolve(false));
    child.on('close', (code, signal) => resolve(signal == null && code === 0));
  });
}

const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;

export async function checkoutHead({ owner, name, sha, token, dir, remote }) {
  if (!dir || !/^[0-9a-f]{40}$/.test(String(sha ?? ''))) return false;
  const url = remote ?? (GITHUB_NAME.test(owner) && GITHUB_NAME.test(name) ? `https://github.com/${owner}/${name}.git` : '');
  if (!url) return false;
  const base = { ...toolEnv(), GIT_TERMINAL_PROMPT: '0' };
  if (!await git(['init'], { cwd: dir, env: base })) return false;
  if (!await git(['remote', 'add', 'origin', url], { cwd: dir, env: base })) return false;
  const fetchEnv = { ...base };
  if (token) {
    fetchEnv.GIT_CONFIG_COUNT = '1';
    fetchEnv.GIT_CONFIG_KEY_0 = 'http.extraheader';
    fetchEnv.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  if (!await git(['fetch', '--depth', '1', 'origin', sha], { cwd: dir, env: fetchEnv })) return false;
  return git(['checkout', '--detach', 'FETCH_HEAD'], { cwd: dir, env: base });
}

async function citeOne(file, { available, run, repoDir }) {
  const language = languageOf(file.path);
  // shortcut: Solidity stays one file. TypeScript and Rust use the pull request checkout; eslint and tsc run only when that tree already has node_modules. No npm ci.
  const check = async (dir) => {
    const result = await oneCheck({ language, file: file.path, repoDir: dir, available, run });
    if (!result) return null;
    return selectCitation({ path: file.path, content: file.content ?? '', patch: file.patch ?? '', findings: result.findings });
  };
  if (repoDir || run) return check(repoDir);
  const dir = mkdtempSync(join(tmpdir(), 'lw-review-'));
  try {
    const full = join(dir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content ?? '');
    return await check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function commentBody(finding) {
  if (!finding || !safeRelative(finding.file) || !Number.isInteger(finding.line) || finding.line < 1 || !finding.rule_id) return null;
  const file = String(finding.file).replaceAll('`', "'");
  const rule = String(finding.rule_id).replaceAll('`', "'").trim();
  if (!rule) return null;
  const message = scrub(finding.message || '').replace(/[\r\n]+/g, ' ').trim();
  return message ? `\`${file}:${finding.line}\` \`${rule}\`\n${message}` : `\`${file}:${finding.line}\` \`${rule}\``;
}

function failed(res) {
  if (!res || res.status === 429 || res.status >= 500) return { retry: true, status: res?.status ?? 503, retryAfter: res?.retryAfter };
  if (res.status >= 400) return { dead: true, status: res.status };
  return null;
}

async function postInline(call, { target, number, sha, citation }) {
  const body = commentBody(citation.finding);
  if (!body) return { published: false };
  const repo = `/repos/${encodeURIComponent(target.github.owner)}/${encodeURIComponent(target.github.name)}`;
  // shortcut: duplicate citations are checked in the first 100 review comments, page when a pull request passes that.
  const listed = await call('GET', `${repo}/pulls/${number}/comments?per_page=100`);
  const problem = failed(listed);
  if (problem) return problem;
  let comments = [];
  try { comments = JSON.parse(listed.text); } catch { return { dead: true, status: listed.status }; }
  if (!Array.isArray(comments)) return { dead: true, status: listed.status };
  if (comments.some((comment) => String(comment.body ?? '').includes(body.split('\n')[0]))) return { published: false };
  if (dryRun()) return { published: false };
  const res = await call('POST', `${repo}/pulls/${number}/comments`, {
    body,
    commit_id: sha,
    path: citation.path,
    line: citation.anchor,
    side: 'RIGHT',
  });
  if (res.status === 422) return { published: false };
  const writeProblem = failed(res);
  if (writeProblem) return writeProblem;
  return { published: true };
}

async function loadPullFile(call, target, number) {
  const repo = `/repos/${encodeURIComponent(target.github.owner)}/${encodeURIComponent(target.github.name)}`;
  // shortcut: the first 100 pull request files are considered, page when a pull request exceeds that.
  const listed = await call('GET', `${repo}/pulls/${number}/files?per_page=100`);
  const problem = failed(listed);
  if (problem) return problem;
  let files = [];
  try { files = JSON.parse(listed.text); } catch { return { dead: true, status: listed.status }; }
  if (!Array.isArray(files)) return { dead: true, status: listed.status };
  const watched = watchedFiles(files.filter((item) => item.status !== 'removed').map((item) => ({ path: item.filename, patch: item.patch || '' })));
  return { files: watched };
}

async function readContent(call, target, sha, file) {
  const repo = `/repos/${encodeURIComponent(target.github.owner)}/${encodeURIComponent(target.github.name)}`;
  const got = await call('GET', `${repo}/contents/${file.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(sha)}`);
  if (got.status === 404) return { content: '' };
  const problem = failed(got);
  if (problem) return problem;
  let body = {};
  try { body = JSON.parse(got.text); } catch { return { dead: true, status: got.status }; }
  if (typeof body.content !== 'string') return { content: '' };
  return { content: Buffer.from(body.content.replace(/\s/g, ''), 'base64').toString('utf8') };
}

export async function reviewPullRequest({ target, number, sha, files, githubApi, available, run, repoDir, checkout }) {
  let session = null;
  let list = files;
  let createdTree = null;
  let tree = repoDir ?? null;
  let treeMiss = false;
  const project = (file) => languageOf(file.path) === 'typescript' || languageOf(file.path) === 'rust';
  async function ensureTree() {
    if (tree) return tree;
    if (treeMiss || dryRun()) return null;
    if (!session?.token) {
      session = await openGithub(target, githubApi);
      if (session.retry || session.dead) return session;
      if (!session.token) {
        treeMiss = true;
        return null;
      }
    }
    if (dryRun()) return null;
    const dest = mkdtempSync(join(tmpdir(), 'lw-tree-'));
    const ok = await (checkout ?? checkoutHead)({
      owner: target.github.owner,
      name: target.github.name,
      sha,
      token: session.token,
      dir: dest,
    });
    if (!ok) {
      rmSync(dest, { recursive: true, force: true });
      treeMiss = true;
      return null;
    }
    tree = dest;
    createdTree = dest;
    return dest;
  }
  try {
    if (!list) {
      if (dryRun()) return { published: false, finding: null };
      session = await openGithub(target, githubApi);
      if (session.missing || session.retry || session.dead) return session;
      const loaded = await loadPullFile(session.call, target, number);
      if (loaded.retry || loaded.dead) return loaded;
      list = loaded.files ?? [];
    }
    let citation = null;
    for (const file of watchedFiles(list)) {
      let dir = project(file) ? repoDir : undefined;
      if (project(file) && !repoDir) {
        const got = await ensureTree();
        if (got?.retry || got?.dead) return { ...got, finding: citation?.finding ?? null };
        dir = typeof got === 'string' ? got : null;
        if (dir && file.content == null) {
          const full = join(dir, file.path);
          if (existsSync(full)) file.content = readFileSync(full, 'utf8');
        }
      }
      if (file.content == null) {
        if (dryRun()) file.content = '';
        else {
          if (!session?.call) {
            session = await openGithub(target, githubApi);
            if (session.missing || session.retry || session.dead) return { ...session, finding: citation?.finding ?? null };
          }
          const read = await readContent(session.call, target, sha, file);
          if (read.retry || read.dead) return { ...read, finding: citation?.finding ?? null };
          file.content = read.content ?? '';
        }
      }
      citation = await citeOne(file, { available, run, repoDir: dir });
      if (citation?.finding) break;
    }
    if (!citation?.finding) return { published: false, finding: null };
    if (dryRun()) return { published: false, finding: citation.finding };
    if (!session?.call) {
      session = await openGithub(target, githubApi);
      if (session.missing || session.retry || session.dead) return { ...session, finding: citation.finding };
    }
    const posted = await postInline(session.call, { target, number, sha, citation });
    return { ...posted, finding: citation.finding };
  } finally {
    if (createdTree) rmSync(createdTree, { recursive: true, force: true });
  }
}
