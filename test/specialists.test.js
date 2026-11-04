import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RULES, acceptSpecialist, rulesFor, runSpecialists, scriptKind, securityRelevant, selectSpecialists } from '../src/specialists.js';

const patch = (path, after = 'return 2;', before = 'return 1;') => ({ path, before, after });
const select = (paths, extra = {}) => selectSpecialists({ class: 'blocker', patches: paths.map((p) => patch(p)), ...extra });

test('typescript server vs ui is decided by path, server wins', () => {
  assert.equal(scriptKind('src/components/Cart.tsx'), 'ui');
  assert.equal(scriptKind('app/orders/page.tsx'), 'ui');
  assert.equal(scriptKind('src/styles/main.css'), 'ui');
  assert.equal(scriptKind('src/hooks/useCart.ts'), 'ui');
  assert.equal(scriptKind('app/api/orders/route.ts'), 'server');
  assert.equal(scriptKind('src/server/db.ts'), 'server');
  assert.equal(scriptKind('src/routes/orders.js'), 'server');
  assert.equal(scriptKind('workers/email.ts'), 'server');
  assert.equal(scriptKind('src/lib/price.server.ts'), 'server');
  assert.equal(scriptKind('src/api/Widget.tsx'), 'server');
  assert.equal(scriptKind('src/lib/format.ts'), null);
  assert.equal(scriptKind('README.md'), null);
});

test('selection follows ADR-0028 order and runs each role once', () => {
  assert.deepEqual(select(['contracts/Vault.sol']), ['solidity', 'business', 'tests']);
  assert.deepEqual(select(['src/main.rs']), ['rust', 'business', 'tests']);
  assert.deepEqual(select(['src/api/a.ts', 'src/components/B.tsx', 'src/api/c.ts']),
    ['typescript-backend', 'typescript-frontend', 'business', 'tests']);
  assert.deepEqual(select(['src/lib/format.ts']), ['business', 'tests']);
  assert.deepEqual(selectSpecialists({ class: 'blocker', patches: [] }), []);
  assert.deepEqual(selectSpecialists({ patches: [patch('src/lib/a.ts')] }), ['tests']);
});

test('security runs on auth/value paths, identifiers, env handling and rust unsafe only', () => {
  assert.equal(securityRelevant([patch('src/auth/login.ts')]), true);
  assert.equal(securityRelevant([patch('src/wallet/send.ts')]), true);
  assert.equal(securityRelevant([patch('src/lib/x.ts', 'const jwt = sign(user);')]), true);
  assert.equal(securityRelevant([patch('src/lib/x.ts', 'await withdrawFunds(id);')]), true);
  assert.equal(securityRelevant([patch('src/lib/x.ts', 'const key = process.env.STRIPE_KEY;')]), true);
  assert.equal(securityRelevant([patch('src/lib/x.rs', 'unsafe { ptr.read() }')]), true);
  assert.equal(securityRelevant([patch('src/lib/format.ts', 'return total.toFixed(2);')]), false);
  assert.equal(securityRelevant([patch('src/components/Design.tsx', 'const author = props.name;')]), false);
  assert.deepEqual(select(['src/api/session.ts']), ['typescript-backend', 'business', 'tests', 'security']);
});

test('a target can override the rule lists', () => {
  const rules = rulesFor({ specialists: { uiPaths: ['web/**'], serverPaths: ['svc/**'] } });
  assert.equal(scriptKind('web/cart.ts', rules), 'ui');
  assert.equal(scriptKind('svc/cart.ts', rules), 'server');
  assert.equal(scriptKind('src/components/A.tsx', rules), null);
  assert.equal(rules.securityPathWords, DEFAULT_RULES.securityPathWords);
});

test('only literal evidence of 8+ chars survives; extra fields are dropped', () => {
  const diff = 'src/a.ts\n+return total.toFixed(2);';
  assert.deepEqual(
    acceptSpecialist({ evidence: [{ source: 'diff', quote: 'total.toFixed' }], summary: 'ok', class: 'blocker', patches: [1] }, diff, []),
    { evidence: [{ source: 'diff', quote: 'total.toFixed' }], summary: 'ok' },
  );
  assert.equal(acceptSpecialist({ evidence: [{ source: 'diff', quote: 'short' }], summary: 'ok' }, diff, []), null);
  assert.equal(acceptSpecialist({ evidence: [{ source: 'diff', quote: 'not in the diff' }], summary: 'ok' }, diff, []), null);
  assert.equal(acceptSpecialist({ evidence: [], summary: 'ok' }, diff, []), null);
  assert.equal(acceptSpecialist({ evidence: [{ source: 'doc', quote: 'Checkout rules' }], summary: 'x' }, diff, [{ path: 'docs/a.md', text: 'Checkout rules apply' }]).summary, 'x');
});

test('runSpecialists calls a mocked model once per role and stops at the budget cap', async () => {
  const payload = { class: 'blocker', patches: [patch('src/api/session.ts', 'return verifySession(token);')] };
  const asked = [];
  const out = await runSpecialists({
    payload, rules: DEFAULT_RULES, docs: [], cap: 80000,
    ask: async (role, system, user) => {
      asked.push(role);
      assert.match(user, /<untrusted source="diff">/);
      if (role === 'business') assert.match(user, /clase: blocker/);
      if (role === 'tests') return { deferred: true };
      return { parsed: { evidence: [{ source: 'diff', quote: 'verifySession(token)' }], summary: `${role} ok` } };
    },
  });
  assert.deepEqual(asked, ['typescript-backend', 'business', 'tests']);
  assert.deepEqual(Object.keys(out.results), ['typescript-backend', 'business']);
  assert.deepEqual(out.skipped, { tests: 'budget', security: 'budget' });
});

test('an ignored or failed answer is not asked again', async () => {
  const asked = [];
  const out = await runSpecialists({
    payload: { class: 'blocker', patches: [patch('src/lib/a.ts')] }, rules: DEFAULT_RULES, docs: [], cap: 80000,
    ask: async (role) => { asked.push(role); return role === 'business' ? { failed: true } : { parsed: { summary: 'x' } }; },
  });
  assert.deepEqual(asked, ['business', 'tests']);
  assert.deepEqual(out.skipped, { business: 'call_failed', tests: 'ignored' });
});
