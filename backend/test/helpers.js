import { createApp } from "../src/app.js";

export const TOKEN = "test-owner-token-0123456789abcdefghijklmnop"; // synthetic, test-only

/**
 * Replaces global fetch so that any request leaving localhost is recorded and
 * answered by `handler` (default: throw). Guarantees tests never reach a real
 * provider.
 */
export function interceptExternalFetch(handler = null) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
    calls.push({ url: href, init });
    if (!handler) throw new Error(`Blocked external fetch in test: ${href}`);
    return handler(href, init);
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

/** Minimal in-memory stand-in for the Prisma client (synthetic fixtures only). */
export function fakePrisma(seed = {}) {
  const db = {
    character: new Map((seed.characters || []).map((c) => [c.id, { ...c }])),
    content: new Map((seed.content || []).map((c) => [c.id, { ...c }])),
    pipelineItem: new Map((seed.pipelineItems || []).map((p) => [p.id, { ...p }])),
  };
  const calls = [];
  const model = (name) => ({
    findMany: async () => { calls.push(`${name}.findMany`); return [...db[name].values()]; },
    findUnique: async ({ where, include }) => {
      calls.push(`${name}.findUnique`);
      const row = db[name].get(where.id);
      if (!row) return null;
      const out = { ...row };
      if (include?.character && row.characterId) out.character = db.character.get(row.characterId) || null;
      return out;
    },
    create: async ({ data }) => {
      calls.push(`${name}.create`);
      const row = { id: `${name}-${db[name].size + 1}`, ...data };
      db[name].set(row.id, row);
      return row;
    },
    update: async ({ where, data }) => {
      calls.push(`${name}.update`);
      const row = db[name].get(where.id);
      if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
      Object.assign(row, data);
      return { ...row };
    },
  });
  // Sessions are kept apart from `calls` so tests can assert that no
  // application data was touched before authentication.
  const sessions = new Map();
  const session = {
    create: async ({ data }) => {
      const row = { id: `session-${sessions.size + 1}`, createdAt: new Date(), revokedAt: null, lastSeenAt: null, ...data };
      sessions.set(row.id, row);
      return { ...row };
    },
    findUnique: async ({ where }) => {
      for (const r of sessions.values()) if (r.tokenHash === where.tokenHash) return { ...r };
      return null;
    },
    updateMany: async ({ where, data }) => {
      let count = 0;
      for (const r of sessions.values()) {
        if (where.id && r.id !== where.id) continue;
        if (where.principalId && r.principalId !== where.principalId) continue;
        if (where.revokedAt === null && r.revokedAt) continue;
        Object.assign(r, data); count++;
      }
      return { count };
    },
  };
  // Minimal job journal stand-ins (unit tests only; real behaviour is tested on Postgres).
  const jobs = new Map(); const steps = [];
  const generationJob = {
    create: async ({ data }) => { const id = `job-${jobs.size + 1}`; const row = { id, ...data, steps: undefined }; jobs.set(id, row);
      (data.steps?.create || []).forEach((st) => steps.push({ id: `step-${steps.length + 1}`, jobId: id, state: "pending", ...st })); return row; },
    updateMany: async ({ where, data }) => { const j = jobs.get(where.id); if (!j) return { count: 0 }; Object.assign(j, data); return { count: 1 }; },
  };
  const generationStep = {
    updateMany: async ({ where, data }) => { const st = steps.find((x) => x.jobId === where.jobId && x.index === where.index); if (!st) return { count: 0 }; Object.assign(st, data); return { count: 1 }; },
    findMany: async ({ where }) => steps.filter((x) => x.jobId === where.jobId),
    findFirst: async ({ where }) => steps.find((x) => x.jobId === where.jobId && x.index === where.index) || null,
  };
  const auditRows = [];
  const auditEvent = { create: async ({ data }) => { auditRows.push(data); return data; } };
  return {
    db, calls, session, sessionRows: sessions, auditEvent, auditRows, generationJob, generationStep,
    character: model("character"),
    content: model("content"),
    pipelineItem: model("pipelineItem"),
  };
}

export async function startApp({ env = {}, prisma = fakePrisma(), gate } = {}) {
  const app = createApp({ prisma, env, gate, logRequests: false });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const raw = (path, { method = "GET", body, token, headers = {} } = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });

  // The synthetic owner token is only accepted at POST /api/auth/session, so
  // a call made "with TOKEN" is sent with a session obtained from it once.
  // If no session can be made (e.g. auth not configured) the raw token is
  // sent, so those tests still see the server's real answer.
  // The in-flight exchange is shared so concurrent first calls make one session.
  let ownerSession;
  async function sessionFor(token) {
    if (token !== TOKEN) return token;
    ownerSession ??= raw("/api/auth/session", { method: "POST", token: TOKEN })
      .then(async (r) => (r.status === 201 ? (await r.json()).sessionToken : null));
    return (await ownerSession) || token;
  }
  const call = async (path, opts = {}) => {
    if (opts.token && path !== "/api/auth/session") opts = { ...opts, token: await sessionFor(opts.token) };
    return raw(path, opts);
  };
  return { base, call, raw, prisma, close: () => new Promise((r) => server.close(r)) };
}
