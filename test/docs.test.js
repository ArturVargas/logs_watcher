import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { docsDiffText, docsKey, docsPrompt, planDocs, reviewDocs } from '../src/docs.js';

const MAP = 'rules:\n  - paths: ["src/billing/**"]\n    docs: ["docs/from-map.md", "../nope.md", "src/readme.md"]\n';
const PAY = [{ path: 'src/billing/pay.ts', before: 'return 1;', after: 'export function Widget() {\n  return 2;\n}' }];

function crashRead() {
  return async () => { throw new Error('read'); };
}

test('map hits come before file names and symbols, and stop at 15', async () => {
  const docs = {
    'docs/from-map.md': 'map only',
    'docs/billing.md': 'billing notes',
    'docs/widget.md': 'Use Widget for this.',
  };
  const plan = await planDocs({
    paths: ['src/billing/pay.ts'],
    mapText: MAP,
    docPaths: Object.keys(docs),
    patches: PAY,
    newTests: [],
    read: async (filePath) => ({ text: docs[filePath] ?? '' }),
  });
  assert.deepEqual(plan.candidates, ['docs/from-map.md', 'docs/billing.md', 'docs/widget.md']);

  const many = Array.from({ length: 16 }, (_, index) => `docs/pay-${String(index).padStart(2, '0')}.md`);
  const capped = await planDocs({
    paths: ['src/keep/pay.ts'],
    mapText: null,
    docPaths: many,
    patches: [{ path: 'src/keep/pay.ts', before: 'a', after: 'b' }],
    newTests: [],
    read: crashRead(),
  });
  assert.equal(capped.candidates.length, 15);
  assert.equal(capped.candidates.includes(many[15]), false);

  const missed = await planDocs({
    paths: ['src/billing/pay.ts'],
    mapText: 'rules:\n  - paths: ["src/billing/.*"]\n    docs: ["docs/only-glob.md"]\n',
    docPaths: ['docs/only-glob.md'],
    patches: [{ path: 'src/billing/pay.ts', before: 'a', after: 'b' }],
    newTests: [],
    read: crashRead(),
  });
  assert.equal(missed.stop, 'empty');
});

test('an invalid map is ignored and the file name still matches', async () => {
  const plan = await planDocs({
    paths: ['src/billing/pay.ts'],
    mapText: 'nope\n',
    docPaths: ['docs/billing.md'],
    patches: [{ path: 'src/billing/pay.ts', before: 'a', after: 'b' }],
    newTests: [],
    read: crashRead(),
  });
  assert.equal(plan.mapInvalid, true);
  assert.deepEqual(plan.candidates, ['docs/billing.md']);
});

test('markdown-only and more than 100 files do not read docs', async () => {
  const read = crashRead();
  const markdown = await planDocs({
    paths: ['README.md', 'docs/a.mdx'],
    mapText: 'rules:',
    docPaths: ['docs/a.mdx'],
    patches: [],
    newTests: [],
    read,
  });
  assert.equal(markdown.stop, 'markdown');
  const paths = Array.from({ length: 101 }, (_, index) => `src/f${index}.js`);
  const large = await planDocs({ paths, mapText: null, docPaths: ['docs/a.md'], patches: [], newTests: [], read });
  assert.equal(large.stop, 'too_large');
});

test('more than 200 markdown files and no candidate records the empty corpus', async () => {
  const docs = (count) => Array.from({ length: count }, (_, index) => `docs/d${String(index).padStart(3, '0')}.md`);
  const quiet = await planDocs({
    paths: ['src/zz.js'],
    mapText: null,
    docPaths: docs(200),
    patches: [{ path: 'src/zz.js', before: 'a', after: 'b' }],
    newTests: [],
    read: crashRead(),
  });
  assert.equal(quiet.stop, 'empty');
  let reads = 0;
  const empty = await planDocs({
    paths: ['src/zz.js'],
    mapText: null,
    docPaths: docs(201),
    patches: [{ path: 'src/zz.js', before: 'a', after: 'export function Widget() {}' }],
    newTests: [],
    read: async () => { reads += 1; return { text: 'nothing' }; },
  });
  assert.equal(empty.stop, 'empty_large');
  assert.equal(reads, 201);
});

test('before must be unique and a new heading is added only when it is missing', () => {
  const diff = docsDiffText({ patches: PAY, newTests: [] });
  const file = { path: 'docs/billing.md', text: 'The pay helper returns 1.\n', prompt: 'The pay helper returns 1.\n' };
  const evidence = [{ source: 'diff', quote: 'return 2;' }];
  const twice = reviewDocs({
    noChange: false,
    evidence,
    patches: [{ path: 'docs/billing.md', before: 'returns 1', after: 'returns 2' }],
    newSections: [],
  }, { files: [{ ...file, text: 'returns 1 and returns 1', prompt: 'returns 1 and returns 1' }], diffText: diff });
  assert.equal(twice.pending, true);

  const outside = reviewDocs({
    noChange: false,
    evidence,
    patches: [{ path: 'src/billing/pay.ts', before: 'return 1;', after: 'return 2;' }],
    newSections: [],
  }, { files: [file], diffText: diff });
  assert.equal(outside.pending, true);

  const kept = reviewDocs({
    noChange: false,
    evidence,
    patches: [],
    newSections: [{ path: 'docs/billing.md', heading: '## Pay', body: 'more' }],
  }, { files: [{ ...file, text: '# Billing\n\n## Pay\n\nold\n' }], diffText: diff });
  assert.deepEqual(kept.files, []);
  const neighbor = reviewDocs({
    noChange: false,
    evidence,
    patches: [],
    newSections: [{ path: 'docs/billing.md', heading: '## Pay', body: 'more' }],
  }, { files: [{ ...file, text: '# Billing\n\n## Payment\n' }], diffText: diff });
  assert.match(neighbor.files[0].content, /^## Pay$/m);

  const added = reviewDocs({
    noChange: false,
    evidence,
    patches: [{ path: 'docs/billing.md', before: 'returns 1', after: 'returns 2' }],
    newSections: [{ path: 'docs/billing.md', heading: '## Pay', body: 'Now returns 2.' }],
  }, { files: [file], diffText: diff });
  assert.equal(added.pending, undefined);
  assert.match(added.files[0].content, /returns 2/);
  assert.match(added.files[0].content, /## Pay\n\nNow returns 2\./);
  assert.equal(added.files[0].path, 'docs/billing.md');

  const refused = reviewDocs({
    noChange: true,
    evidence,
    patches: [{ path: 'docs/billing.md', before: 'returns 1', after: 'returns 2' }],
    newSections: [],
  }, { files: [file], diffText: diff });
  assert.equal(refused.pending, true);

  const prompt = docsPrompt(diff, [file], 80000);
  assert.equal(prompt.prompt.split('source="diff"').length, 2);
  const head = 'b'.repeat(40);
  const hex = createHash('sha256').update(`docs\nfix\nprimary\n42\n${head}\nsrc/a.js,src/b.js`).digest('hex');
  assert.equal(docsKey('primary', '42', head, ['src/b.js', 'src/a.js']), `docs:${hex}`);
});
