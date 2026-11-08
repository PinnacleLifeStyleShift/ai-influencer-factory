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
  return {
    db, calls,
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
  const call = (path, { method = "GET", body, token, headers = {} } = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  return { base, call, prisma, close: () => new Promise((r) => server.close(r)) };
}
