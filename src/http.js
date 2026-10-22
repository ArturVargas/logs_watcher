import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { loadConfig } from './config.js';
import { enqueueClassify, log, withTx } from './queue.js';
import { scrubJson } from './scrub.js';

const MAX_BODY = 1_000_000;

function header(req, name) {
  const value = req.headers[name];
  return typeof value === 'string' ? value : '';
}

function sameHex(expected, got) {
  const left = Buffer.from(String(expected).toLowerCase());
  const right = Buffer.from(String(got).toLowerCase());
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function hmacHex(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        tooBig = true;
        req.pause();
        reject(Object.assign(new Error('too_large'), { code: 'TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!tooBig) resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { if (!tooBig) reject(err); });
  });
}

function reject(res, status) {
  log({ level: 'warn', msg: 'webhook_rejected' });
  res.writeHead(status);
  res.end();
}

function issueId(resource, body) {
  const raw = resource === 'event_alert'
    ? body?.data?.issue?.id ?? body?.data?.event?.issue_id ?? body?.data?.event?.issue?.id
    : body?.data?.issue?.id;
  const id = raw == null ? '' : String(raw);
  return /^[A-Za-z0-9._:-]{1,80}$/.test(id) ? id : null;
}

function accepted(resource, action) {
  if (resource === 'event_alert') return true;
  return resource === 'issue' && (action === 'created' || action === 'unresolved');
}

function storedPayload(value) {
  if (value == null) return null;
  try {
    return JSON.stringify(scrubJson(value));
  } catch {
    return null;
  }
}

async function storeInbox(client, row) {
  await client.query(
    `INSERT INTO inbox (delivery_id, source, target_id, received_at, payload, status, drop_reason)
     VALUES ($1, $2, $3, now(), $4::jsonb, $5, $6)`,
    [row.deliveryId, row.source, row.targetId, storedPayload(row.payload), row.status, row.dropReason],
  );
}

async function handleSentry(req, res, pool, targetId, raw) {
  const config = loadConfig();
  const target = config.targets.find((item) => item.id === targetId);
  if (!target) {
    res.writeHead(404);
    res.end();
    return;
  }
  const secret = process.env[target.sentry.webhookSecretEnv] || '';
  const signature = header(req, 'sentry-hook-signature');
  if (!secret || !signature || !sameHex(hmacHex(secret, raw), signature)) {
    reject(res, 401);
    return;
  }
  const stamp = header(req, 'sentry-hook-timestamp');
  if (stamp) {
    const seconds = Number(stamp);
    if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) {
      reject(res, 401);
      return;
    }
  }
  let body;
  try {
    body = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    reject(res, 400);
    return;
  }
  const requestId = header(req, 'request-id');
  const deliveryId = `${target.id}:${requestId || createHash('sha256').update(raw).digest('hex')}`;
  const resource = header(req, 'sentry-hook-resource');
  const sentryIssueId = issueId(resource, body);
  const take = accepted(resource, body.action) && sentryIssueId && target.active;
  try {
    await withTx(pool, async (client) => {
      if (!target.active) {
        await storeInbox(client, { deliveryId, source: 'sentry', targetId: target.id, payload: body, status: 'target_inactive', dropReason: 'target_inactive' });
        return;
      }
      if (!take) {
        await storeInbox(client, { deliveryId, source: 'sentry', targetId: target.id, payload: body, status: 'dropped', dropReason: 'resource_not_accepted' });
        return;
      }
      await storeInbox(client, { deliveryId, source: 'sentry', targetId: target.id, payload: body, status: 'accepted', dropReason: null });
      await enqueueClassify(client, { target, sentryIssueId, deliveryId });
    });
  } catch (err) {
    if (err.code === '23505') {
      res.writeHead(200);
      res.end();
      return;
    }
    throw err;
  }
  if (!target.active) {
    log({ level: 'info', msg: 'event_dropped', targetId: target.id });
    res.writeHead(200);
    res.end();
    return;
  }
  if (!take) {
    log({ level: 'info', msg: 'event_dropped', targetId: target.id });
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(200);
  res.end();
}

async function handleGithub(req, res, pool, raw) {
  // shortcut: la entrega queda en inbox y este corte no encola; reabrir cuando exista el consumidor.
  const secret = process.env.GITHUB_WEBHOOK_SECRET || '';
  const signature = header(req, 'x-hub-signature-256');
  const expected = `sha256=${hmacHex(secret, raw)}`;
  if (!secret || !signature.startsWith('sha256=') || !sameHex(expected.slice('sha256='.length), signature.slice('sha256='.length))) {
    reject(res, 401);
    return;
  }
  const delivery = header(req, 'x-github-delivery');
  if (!delivery) {
    reject(res, 401);
    return;
  }
  let body = {};
  try {
    body = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    reject(res, 400);
    return;
  }
  const config = loadConfig();
  const owner = body?.repository?.owner?.login ?? '';
  const name = body?.repository?.name ?? '';
  const target = config.targets.find((item) => item.active && item.github.owner === owner && item.github.name === name);
  try {
    await withTx(pool, async (client) => {
      await storeInbox(client, {
        deliveryId: delivery,
        source: 'github',
        targetId: target?.id ?? null,
        payload: body,
        status: 'stored',
        dropReason: null,
      });
    });
  } catch (err) {
    if (err.code === '23505') {
      res.writeHead(200);
      res.end();
      return;
    }
    throw err;
  }
  res.writeHead(200);
  res.end();
}

export async function handleWebhook(req, res, pool) {
  const path = new URL(req.url, 'http://localhost').pathname;
  const sentry = path.match(/^\/webhooks\/sentry\/([a-z0-9][a-z0-9-]{0,39})$/);
  if (req.method !== 'POST' || (!sentry && path !== '/webhooks/github')) {
    res.writeHead(404);
    res.end();
    return;
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY) {
    reject(res, 413);
    req.destroy();
    return;
  }
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err.code === 'TOO_LARGE') {
      reject(res, 413);
      req.destroy();
      return;
    }
    throw err;
  }
  if (sentry) await handleSentry(req, res, pool, sentry[1], raw);
  else await handleGithub(req, res, pool, raw);
}
