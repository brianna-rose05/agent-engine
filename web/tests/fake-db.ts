import { getFunctionName } from "convex/server";

/*
 * A small in-memory stand-in for a Convex ctx (db, scheduler, runQuery/runMutation) so handlers can be run as they
 * are (`fn._handler(ctx, args)`). Only what the handlers under test use: get, insert, patch, delete, normalizeId and
 * query(table).first/collect/take, with withIndex/order accepted and ignored except for an equality filter.
 */

type Doc = Record<string, unknown> & { _id: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFn = any;

export function fakeDb(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables: Record<string, Doc[]> = {};
  let n = 0;
  const insertSync = (table: string, doc: Record<string, unknown>) => {
    const _id = (doc._id as string | undefined) ?? `${table}_${++n}`;
    (tables[table] ??= []).push({ ...doc, _id, _creationTime: Date.now() });
    return _id;
  };
  for (const [t, rows] of Object.entries(seed)) for (const r of rows) insertSync(t, r);
  const find = (id: string) => Object.values(tables).flat().find((d) => d._id === id) ?? null;

  const query = (table: string) => {
    let rows = () => tables[table] ?? [];
    const q = {
      withIndex: (_name: string, f?: (b: unknown) => unknown) => {
        if (f) {
          const eqs: [string, unknown][] = [];
          const b = { eq: (field: string, value: unknown) => { eqs.push([field, value]); return b; } };
          f(b);
          const base = rows;
          rows = () => base().filter((d) => eqs.every(([k, v]) => d[k] === v));
        }
        return q;
      },
      order: () => q,
      first: async () => rows()[0] ?? null,
      collect: async () => [...rows()],
      take: async (k: number) => rows().slice(0, k),
    };
    return q;
  };

  const db = {
    get: async (id: string) => find(id),
    insert: async (table: string, doc: Record<string, unknown>) => insertSync(table, doc),
    patch: async (id: string, p: Record<string, unknown>) => {
      const d = find(id);
      if (!d) throw new Error(`no ${id}`);
      for (const [k, v] of Object.entries(p)) { if (v === undefined) delete d[k]; else d[k] = v; }
    },
    delete: async (id: string) => {
      for (const rows of Object.values(tables)) {
        const i = rows.findIndex((d) => d._id === id);
        if (i >= 0) rows.splice(i, 1);
      }
    },
    normalizeId: (_t: string, id: string) => (find(id) ? id : null),
    query,
  };
  return { db, tables };
}

/** A mutation/query ctx plus what was scheduled, and an action ctx that runs internal functions on the same db. */
export function fakeCtx(seed?: Record<string, Record<string, unknown>[]>, functions: Record<string, AnyFn> = {}) {
  const { db, tables } = fakeDb(seed);
  const scheduled: { name: string; args: Record<string, unknown> }[] = [];
  const scheduler = { runAfter: async (_ms: number, ref: AnyFn, args: Record<string, unknown>) => {
    scheduled.push({ name: getFunctionName(ref), args });
  } };
  const ctx = { db, scheduler };
  const call = async (ref: AnyFn, args: Record<string, unknown>) => {
    const name = getFunctionName(ref);
    const fn = functions[name];
    if (!fn) throw new Error(`no fake for ${name}`);
    return fn._handler(ctx, args);
  };
  const actionCtx = { runMutation: call, runQuery: call, scheduler };
  return { ctx, actionCtx, tables, scheduled };
}
