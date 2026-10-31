import { createHash } from 'node:crypto';
import { pathDenied } from './propose.js';
import { scrub } from './scrub.js';

const SYMBOL = /(?:export )?(?:function|class|const|type|interface) ([A-Za-z_][A-Za-z0-9_]{2,})/g;
const FILE_CAP = 20000;

function underDocs(filePath) {
  return typeof filePath === 'string' && filePath.startsWith('docs/') && !pathDenied(filePath);
}

function docOnly(filePath) {
  return filePath.startsWith('docs/') || filePath.endsWith('.md') || filePath.endsWith('.mdx');
}

function untrusted(source, text) {
  return `<untrusted source="${source}">\n${text}\n</untrusted>`;
}

export function changedPaths(payload) {
  const paths = [];
  const seen = new Set();
  for (const file of [...(payload?.patches ?? []), ...(payload?.newTests ?? [])]) {
    if (typeof file?.path !== 'string' || seen.has(file.path)) continue;
    seen.add(file.path);
    paths.push(file.path);
  }
  return paths;
}

export function docsStop(paths) {
  if (paths.length > 100) return 'too_large';
  if (paths.length > 0 && paths.every(docOnly)) return 'markdown';
  return null;
}

export function docsKey(targetId, sentryIssueId, headSha, paths) {
  const list = [...paths].sort().join(',');
  const hex = createHash('sha256').update(`docs\nfix\n${targetId}\n${sentryIssueId}\n${headSha}\n${list}`).digest('hex');
  return `docs:${hex}`;
}

function globMatch(pattern, file) {
  if (typeof pattern !== 'string') return false;
  const body = pattern.split('**').map((part) => part.split('*').map((bit) => bit.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${body}$`).test(file);
}

export function parseMap(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (lines[0] !== 'rules:') return { invalid: true };
  const rules = [];
  let current = null;
  for (const line of lines.slice(1)) {
    const paths = line.match(/^-\s*paths:\s*(\[.*\])$/);
    const docs = line.match(/^docs:\s*(\[.*\])$/);
    if (paths) {
      try { current = { paths: JSON.parse(paths[1]), docs: [] }; } catch { return { invalid: true }; }
      if (!Array.isArray(current.paths) || current.paths.some((item) => typeof item !== 'string')) return { invalid: true };
      rules.push(current);
    } else if (docs && current) {
      try { current.docs = JSON.parse(docs[1]); } catch { return { invalid: true }; }
      if (!Array.isArray(current.docs) || current.docs.some((item) => typeof item !== 'string')) return { invalid: true };
    } else return { invalid: true };
  }
  return {
    rules: rules.slice(0, 100).map((rule) => ({
      paths: rule.paths,
      docs: rule.docs.filter(underDocs),
    })),
  };
}

function addedLineText(before, after) {
  const left = new Map();
  for (const line of String(before ?? '').split('\n')) left.set(line, (left.get(line) ?? 0) + 1);
  const added = [];
  for (const line of String(after ?? '').split('\n')) {
    const count = left.get(line) ?? 0;
    if (count > 0) left.set(line, count - 1);
    else added.push(line);
  }
  return added;
}

function symbolsIn(line) {
  return [...String(line).matchAll(SYMBOL)].map((match) => match[1]);
}

function tokensOf(filePath) {
  const parts = filePath.split('/');
  const base = parts.pop() ?? '';
  const name = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  return [name, parts[parts.length - 1] ?? ''].filter((token) => token.length >= 3);
}

function markdownCount(docPaths) {
  return docPaths.filter((path) => path.startsWith('docs/') && (path.endsWith('.md') || path.endsWith('.mdx'))).length;
}

export function docsDiffText(payload) {
  const chunks = [];
  for (const patch of payload?.patches ?? []) {
    const lines = [patch.path, ...addedLineText(patch.before, patch.after).map((line) => `+${line}`)];
    chunks.push(lines.join('\n'));
  }
  for (const file of payload?.newTests ?? []) {
    chunks.push([file.path, ...String(file.content ?? '').split('\n').map((line) => `+${line}`)].join('\n'));
  }
  return chunks.join('\n');
}

export function docsPrompt(diffText, files, cap) {
  const sent = [];
  let body = 'Devuelve solo JSON {"noChange":false,"evidence":[{"source":"diff","quote":""}],"patches":[{"path":"docs/a.md","before":"","after":""}],"newSections":[{"path":"docs/a.md","heading":"## Título","body":""}]}. noChange true exige listas vacías.';
  body += `\n${untrusted('diff', diffText)}`;
  for (const file of files) {
    const block = untrusted('doc', file.prompt ?? file.text);
    if (body.length + block.length > cap) break;
    body += `\n${block}`;
    sent.push(file);
  }
  return { prompt: body, files: sent };
}

export async function planDocs({ paths, mapText, docPaths, patches, newTests, read }) {
  const stop = docsStop(paths);
  if (stop) return { stop };
  let rules = [];
  let mapInvalid = false;
  if (mapText != null) {
    const parsed = parseMap(mapText);
    if (parsed.invalid) mapInvalid = true;
    else rules = parsed.rules;
  }
  const listed = [...docPaths].filter(underDocs).sort();
  const picked = [];
  const seen = new Set();
  const add = (filePath) => {
    if (picked.length >= 15 || seen.has(filePath) || !underDocs(filePath)) return;
    seen.add(filePath);
    picked.push(filePath);
  };
  const code = paths.filter((filePath) => !docOnly(filePath));
  for (const rule of rules) {
    if (!rule.paths.some((pattern) => code.some((filePath) => globMatch(pattern, filePath)))) continue;
    for (const doc of rule.docs) add(doc);
  }
  for (const filePath of code) {
    for (const token of tokensOf(filePath)) {
      for (const doc of listed) if (doc.includes(token)) add(doc);
    }
  }
  const symbols = new Set();
  for (const patch of patches ?? []) {
    if (!patch || docOnly(patch.path)) continue;
    for (const line of addedLineText(patch.before, patch.after)) for (const name of symbolsIn(line)) symbols.add(name);
  }
  for (const file of newTests ?? []) {
    if (!file || docOnly(file.path)) continue;
    for (const line of String(file.content ?? '').split('\n')) for (const name of symbolsIn(line)) symbols.add(name);
  }
  if (picked.length < 15 && symbols.size) {
    for (const doc of listed) {
      if (picked.length >= 15) break;
      if (seen.has(doc)) continue;
      const loaded = await read(doc);
      if (loaded?.problem) return { problem: loaded.problem, mapInvalid };
      const text = loaded?.text ?? '';
      if ([...symbols].some((name) => text.includes(name))) add(doc);
    }
  }
  if (!picked.length && markdownCount(docPaths) > 200) return { stop: 'empty_large', mapInvalid };
  if (!picked.length) return { stop: 'empty', mapInvalid };
  return { candidates: picked, mapInvalid };
}

function replaceOnce(original, before, after) {
  if (typeof original !== 'string' || typeof before !== 'string' || before === '' || typeof after !== 'string') return null;
  const at = original.indexOf(before);
  if (at < 0 || original.indexOf(before, at + before.length) !== -1) return null;
  return original.slice(0, at) + after + original.slice(at + before.length);
}

function evidenceOk(evidence, diffText, docText) {
  if (!Array.isArray(evidence) || evidence.length < 1) return false;
  for (const item of evidence) {
    if (!item || (item.source !== 'diff' && item.source !== 'doc')) return false;
    if (typeof item.quote !== 'string' || item.quote.length < 8) return false;
    if (!(item.source === 'doc' ? docText : diffText).includes(item.quote)) return false;
  }
  return true;
}

export function reviewDocs(model, { files, diffText }) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return { pending: true };
  const patches = model.patches ?? [];
  const sections = model.newSections ?? [];
  const evidence = model.evidence ?? [];
  if (!Array.isArray(patches) || !Array.isArray(sections) || !Array.isArray(evidence)) return { pending: true };
  if (model.noChange === true) {
    if (patches.length || sections.length || evidence.length) return { pending: true };
    return { files: [] };
  }
  if (!patches.length && !sections.length) return { files: [] };
  const docText = files.map((file) => file.prompt ?? file.text).join('\n');
  if (!evidenceOk(evidence, diffText, docText)) return { pending: true };
  const next = new Map(files.map((file) => [file.path, file.text]));
  for (const patch of patches) {
    const updated = replaceOnce(next.get(patch?.path), patch?.before, patch?.after);
    if (!underDocs(patch?.path) || updated == null) return { pending: true };
    next.set(patch.path, updated);
  }
  for (const section of sections) {
    if (!underDocs(section?.path) || typeof section.heading !== 'string' || section.heading === '' || typeof section.body !== 'string') return { pending: true };
    const current = next.get(section.path);
    if (current == null) return { pending: true };
    if (current.split('\n').some((line) => line.trim() === section.heading.trim())) continue;
    const base = current.endsWith('\n') ? current : `${current}\n`;
    next.set(section.path, `${base}\n${section.heading}\n\n${section.body}\n`);
  }
  const changed = [];
  for (const file of files) {
    const content = next.get(file.path);
    if (content !== file.text) changed.push({ path: file.path, content });
  }
  return { files: changed };
}

export function promptFile(text) {
  return { text, prompt: scrub(text).slice(0, FILE_CAP) };
}
