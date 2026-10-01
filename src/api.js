// 接口层：HTTP 路由 + JSON 编解码。不写业务规则（规则都在 workflow.js），
// 也不直接碰文件（读写都经 storage.js 的串行事务）。
import {
  buildView,
  createPlate,
  acquire,
  heartbeat,
  handoff,
  release,
  recover,
  reapExpired,
  advance,
  registerChemical,
  assignChemical,
  rotateChemical,
  sealBoxBatch,
  migrateV1,
  DomainError,
} from "./workflow.js";
import { PersistError } from "./storage.js";

export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { code: "bad_json", status: 400 });
  }
}

const send = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
};

// 一次请求 = 一次存储事务；mutator 在状态副本上做纯变更。
function routeMutation(store, mutator, { successStatus = 200 } = {}) {
  return async (req, res, params) => {
    const input = await readJson(req);
    const failCredits = Number(req.headers["x-fail-writes"] || 0) || 0;
    try {
      const { attempts, result } = await store.transact(
        (state, ctx) => mutator(state, params, input, ctx),
        { failCredits },
      );
      return send(res, successStatus, { ok: true, writeAttempts: attempts, ...result });
    } catch (error) {
      sendError(res, error);
    }
  };
}

function sendError(res, error) {
  if (error instanceof DomainError) {
    return send(res, error.status || 409, {
      ok: false,
      error: error.code,
      message: error.message,
      holder: error.holder,
      holderName: error.holderName,
      expiresAt: error.expiresAt,
      expected: error.expected,
      batchId: error.batchId,
    });
  }
  if (error instanceof PersistError) {
    return send(res, 503, {
      ok: false,
      error: "persist_failed",
      message: error.message,
      attempts: error.attempts,
      retryable: true,
      hint: "内存与磁盘均未提交本次占用：请持原令牌与同一 requestId 从最近检查点重试，不会重复消耗药液",
    });
  }
  send(res, error.status || 500, {
    ok: false,
    error: error.code || "internal_error",
    message: error.message,
  });
}

export function createApiRouter(store) {
  const routes = [
    [/^\/api\/state$/, "GET", async (_req, res) => {
      const state = await store.read();
      send(res, 200, buildView(state));
    }],

    [/^\/api\/plates$/, "POST", routeMutation(store, (state, _p, input, ctx) =>
      createPlate(state, input, ctx), { successStatus: 201 })],

    [/^\/api\/plates\/([^/]+)\/acquire$/, "POST", routeMutation(store, (state, p, input, ctx) =>
      acquire(state, p[0], { ...input, station: input.station }, ctx))],

    [/^\/api\/plates\/([^/]+)\/heartbeat$/, "POST", routeMutation(store, (state, p, input, ctx) =>
      heartbeat(state, p[0], input, ctx))],

    [/^\/api\/plates\/([^/]+)\/handoff$/, "POST", routeMutation(store, (state, p, input, ctx) =>
      handoff(state, p[0], input, ctx))],

    [/^\/api\/plates\/([^/]+)\/release$/, "POST", routeMutation(store, (state, p, input, ctx) =>
      release(state, p[0], input, ctx))],

    // 租约过期续做：清掉失效持有，回到队列，返回最近检查点
    [/^\/api\/plates\/([^/]+)\/recover$/, "POST", routeMutation(store, (state, p, input, ctx) =>
      recover(state, p[0], input, ctx))],

    [/^\/api\/leases\/reap-expired$/, "POST", routeMutation(store, (state, _p, input, ctx) =>
      reapExpired(state, input, ctx))],

    // 推进工艺检查点；幂等键 requestId 默认 = 租约令牌+步骤，重试安全
    [/^\/api\/plates\/([^/]+)\/advance$/, "POST", routeMutation(store, (state, p, input, ctx) =>
      advance(state, p[0], input, ctx))],

    [/^\/api\/chemicals$/, "POST", routeMutation(store, (state, _p, input, ctx) =>
      registerChemical(state, input, ctx))],

    [/^\/api\/plates\/([^/]+)\/chemical$/, "PUT", routeMutation(store, (state, p, input, ctx) =>
      assignChemical(state, p[0], input, ctx))],

    [/^\/api\/chemicals\/rotate$/, "POST", routeMutation(store, (state, _p, input, ctx) =>
      rotateChemical(state, input, ctx))],

    [/^\/api\/box-batches\/seal$/, "POST", routeMutation(store, (state, _p, input, ctx) =>
      sealBoxBatch(state, input, ctx))],
  ];

  return async function apiRouter(req, res, pathname) {
    for (const [pattern, method, handler] of routes) {
      const m = pathname.match(pattern);
      if (m && req.method === method) return handler(req, res, m.slice(1));
    }
    send(res, 404, { ok: false, error: "not_found", message: `没有 ${req.method} ${pathname} 接口` });
  };
}

// 首次启动迁移：v1 { items } → v2 转手链结构，迁移本身也是一次原子事务
export async function ensureMigrated(store) {
  let didMigrate = false;
  await store.transact((snapshot) => {
    if (snapshot.version === 2) return { state: snapshot, result: { migrated: false } };
    didMigrate = true;
    return { state: migrateV1(snapshot), result: { migrated: true } };
  });
  return didMigrate;
}
