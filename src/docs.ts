import type { Wire } from './types.js';
import { createHash } from 'node:crypto';
import { pathDenied } from './propose.js';
import { scrub } from './scrub.js';

const SYMBOL = /(?:export )?(?:function|class|const|type|interface) ([A-Za-z_][A-Za-z0-9_]{2,})/g;
const FILE_CAP = 20000;

function underDocs(filePath: Wire): Wire {
  return typeof filePath === 'string' && filePath.startsWith('docs/') && !pathDenied(filePath);
}

function docOnly(filePath: Wire): Wire {
  return filePath.startsWith('docs/') || filePath.endsWith('.md') || filePath.endsWith('.mdx');
}

function untrusted(source: Wire, text: Wire): Wire {
  return `<untrusted source="${source}">\n${text}\n</untrusted>`;
}

export function changedPaths(payload: Wire): Wire {
  const paths: Wire[] = [] as Wire[];
  const seen = new Set();
  for (const file of [...(payload?.patches ?? []), ...(payload?.newTests ?? [])]) {
    if (typeof file?.path !== 'string' || seen.has(file.path)) continue;
    seen.add(file.path);
    paths.push(file.path);
  }
  return paths;
}

export function docsStop(paths: Wire): Wire {
  if (paths.length > 100) return 'too_large';
  if (paths.length > 0 && paths.every(docOnly)) return 'markdown';
  return null;
}

export function docsKey(targetId: Wire, sentryIssueId: Wire, headSha: Wire, paths: Wire): Wire {
  const list = [...paths].sort().join(',');
  const hex = createHash('sha256').update(`docs\nfix\n${targetId}\n${sentryIssueId}\n${headSha}\n${list}`).digest('hex');
  return `docs:${hex}`;
}

function globMatch(pattern: Wire, file: Wire): Wire {
  if (typeof pattern !== 'string') return false;
  const body = pattern.split('**').map((part: Wire) => part.split('*').map((bit: Wire) => bit.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${body}$`).test(file);
}

export function parseMap(text: Wire): Wire {
  const lines = String(text ?? '').split('\n').map((line: Wire) => line.trim()).filter((line: Wire) => line && !line.startsWith('#'));
  if (lines[0] !== 'rules:') return { invalid: true };
  const rules: Wire[] = [] as Wire[];
  let current = null;
  for (const line of lines.slice(1)) {
    const paths = line.match(/^-\s*paths:\s*(\[.*\])$/);
    const docs = line.match(/^docs:\s*(\[.*\])$/);
    if (paths) {
      try { current = { paths: JSON.parse(paths[1]), docs: [] as Wire[] }; } catch { return { invalid: true }; }
      if (!Array.isArray(current.paths) || current.paths.some((item: Wire) => typeof item !== 'string')) return { invalid: true };
      rules.push(current);
    } else if (docs && current) {
      try { current.docs = JSON.parse(docs[1]); } catch { return { invalid: true }; }
      if (!Array.isArray(current.docs) || current.docs.some((item: Wire) => typeof item !== 'string')) return { invalid: true };
    } else return { invalid: true };
  }
  return {
    rules: rules.slice(0, 100).map((rule: Wire) => ({
      paths: rule.paths,
      docs: rule.docs.filter(underDocs),
    })),
  };
}

function addedLineText(before: Wire, after: Wire): Wire {
  const left = new Map();
  for (const line of String(before ?? '').split('\n')) left.set(line, (left.get(line) ?? 0) + 1);
  const added: Wire[] = [] as Wire[];
  for (const line of String(after ?? '').split('\n')) {
    const count = left.get(line) ?? 0;
    if (count > 0) left.set(line, count - 1);
    else added.push(line);
  }
  return added;
}

function symbolsIn(line: Wire): Wire {
  return [...String(line).matchAll(SYMBOL)].map((match: Wire) => match[1]);
}

function tokensOf(filePath: Wire): Wire {
  const parts = filePath.split('/');
  const base = parts.pop() ?? '';
  const name = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  return [name, parts[parts.length - 1] ?? ''].filter((token: Wire) => token.length >= 3);
}

function markdownCount(docPaths: Wire): Wire {
  return docPaths.filter((path: Wire) => path.startsWith('docs/') && (path.endsWith('.md') || path.endsWith('.mdx'))).length;
}

export function docsDiffText(payload: Wire): Wire {
  const chunks: Wire[] = [] as Wire[];
  for (const patch of payload?.patches ?? []) {
    const lines = [patch.path, ...addedLineText(patch.before, patch.after).map((line: Wire) => `+${line}`)];
    chunks.push(lines.join('\n'));
  }
  for (const file of payload?.newTests ?? []) {
    chunks.push([file.path, ...String(file.content ?? '').split('\n').map((line: Wire) => `+${line}`)].join('\n'));
  }
  return chunks.join('\n');
}

export function docsPrompt(diffText: Wire, files: Wire, cap: Wire): Wire {
  const sent: Wire[] = [] as Wire[];
  let body = 'Devuelve solo JSON {"noChange":false,"evidence":[{"source":"diff","quote":""}],"patches":[{"path":"docs/a.md","before":"","after":""}],"newSections":[{"path":"docs/a.md","heading":"## Título","body":""}]}. noChange true exige listas vacías.';
  body += `\n${untrusted('diff', diffText)}`;
  for (const file of files as Wire[]) {
    const block = untrusted('doc', String((file as Wire).prompt ?? (file as Wire).text));
    if (body.length + block.length > cap) break;
    body += `\n${block}`;
    sent.push(file);
  }
  return { prompt: body, files: sent };
}

export async function planDocs({ paths, mapText, docPaths, patches, newTests, read }: Wire): Promise<Wire> {
  const stop = docsStop(paths);
  if (stop) return { stop };
  let rules: Wire[] = [] as Wire[];
  let mapInvalid = false;
  if (mapText != null) {
    const parsed = parseMap(mapText);
    if (parsed.invalid) mapInvalid = true;
    else rules = parsed.rules;
  }
  const listed = [...docPaths].filter(underDocs).sort();
  const picked: Wire[] = [] as Wire[];
  const seen = new Set();
  const add = (filePath: Wire) => {
    if (picked.length >= 15 || seen.has(filePath) || !underDocs(filePath)) return;
    seen.add(filePath);
    picked.push(filePath);
  };
  const code = paths.filter((filePath: Wire) => !docOnly(filePath));
  for (const rule of rules) {
    if (!rule.paths.some((pattern: Wire) => code.some((filePath: Wire) => globMatch(pattern, filePath)))) continue;
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
      const loaded: Wire = await read(doc);
      if (loaded?.problem) return { problem: loaded.problem, mapInvalid };
      const text = loaded?.text ?? '';
      if ([...symbols].some((name: Wire) => text.includes(name))) add(doc);
    }
  }
  if (!picked.length && markdownCount(docPaths) > 200) return { stop: 'empty_large', mapInvalid };
  if (!picked.length) return { stop: 'empty', mapInvalid };
  return { candidates: picked, mapInvalid };
}

function replaceOnce(original: Wire, before: Wire, after: Wire): Wire {
  if (typeof original !== 'string' || typeof before !== 'string' || before === '' || typeof after !== 'string') return null;
  const at = original.indexOf(before);
  if (at < 0 || original.indexOf(before, at + before.length) !== -1) return null;
  return original.slice(0, at) + after + original.slice(at + before.length);
}

function evidenceOk(evidence: Wire, diffText: Wire, docText: Wire): Wire {
  if (!Array.isArray(evidence) || evidence.length < 1) return false;
  for (const item of evidence) {
    if (!item || (item.source !== 'diff' && item.source !== 'doc')) return false;
    if (typeof item.quote !== 'string' || item.quote.length < 8) return false;
    if (!(item.source === 'doc' ? docText : diffText).includes(item.quote)) return false;
  }
  return true;
}

export function reviewDocs(model: Wire, { files, diffText }: Wire): Wire {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return { pending: true };
  const patches = model.patches ?? [];
  const sections = model.newSections ?? [];
  const evidence = model.evidence ?? [];
  if (!Array.isArray(patches) || !Array.isArray(sections) || !Array.isArray(evidence)) return { pending: true };
  if (model.noChange === true) {
    if (patches.length || sections.length || evidence.length) return { pending: true };
    return { files: [] as Wire[] };
  }
  if (!patches.length && !sections.length) return { files: [] as Wire[] };
  const docText = files.map((file: Wire) => String((file as Wire).prompt ?? (file as Wire).text)).join('\n');
  if (!evidenceOk(evidence, diffText, docText)) return { pending: true };
  const next = new Map(files.map((file: Wire) => [file.path, (file as Wire).text]));
  for (const patch of patches) {
    const updated = replaceOnce(next.get(patch?.path), patch?.before, patch?.after);
    if (!underDocs(patch?.path) || updated == null) return { pending: true };
    next.set(patch.path, updated);
  }
  for (const section of sections) {
    if (!underDocs(section?.path) || typeof section.heading !== 'string' || section.heading === '' || typeof section.body !== 'string') return { pending: true };
    const current: Wire = next.get(section.path);
    if (current == null) return { pending: true };
    if (current.split('\n').some((line: Wire) => line.trim() === section.heading.trim())) continue;
    const base = current.endsWith('\n') ? current : `${current}\n`;
    next.set(section.path, `${base}\n${section.heading}\n\n${section.body}\n`);
  }
  const changed: Wire[] = [] as Wire[];
  for (const file of files as Wire[]) {
    const content = next.get(file.path);
    if (content !== (file as Wire).text) changed.push({ path: file.path, content });
  }
  return { files: changed };
}

export function promptFile(text: Wire): Wire {
  return { text, prompt: scrub(text).slice(0, FILE_CAP) };
}
