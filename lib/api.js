// 接口层：HTTP 路由。只负责解析请求、返回响应，业务规则全部在 domain.js。
import { createPlate, claimPlate, recordCheckpoint, invalidateBatch } from "./domain.js";
import { LEASE_MS, PROCESS_STEPS } from "./store.js";

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function sendDomain(res, result) {
  send(res, result.ok ? 200 : (result.status || 500), result);
}

export function createApi(store, pageHtml) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const p = url.pathname;
      const method = req.method;

      if (method === "GET" && p === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(pageHtml);
        return;
      }

      if (method === "GET" && p === "/api/state") {
        const db = store.db;
        return send(res, 200, {
          meta: db.meta,
          leaseMs: LEASE_MS,
          processSteps: PROCESS_STEPS,
          workstations: db.workstations,
          chemicalBatches: db.chemicalBatches,
          boxBatches: db.boxBatches,
          plates: db.plates,
          events: db.events.slice(0, 80),
          telemetry: store.telemetry,
          fault: store.fault
        });
      }

      if (method === "POST" && p === "/api/plates") {
        const input = await readBody(req);
        return sendDomain(res, await createPlate(store, input));
      }

      const claim = p.match(/^\/api\/plates\/([^/]+)\/claim$/);
      if (claim && method === "POST") {
        const input = await readBody(req);
        return sendDomain(res, await claimPlate(store, claim[1], input.workstationId));
      }

      const cp = p.match(/^\/api\/plates\/([^/]+)\/checkpoint$/);
      if (cp && method === "POST") {
        const input = await readBody(req);
        return sendDomain(res, await recordCheckpoint(store, cp[1], input.workstationId, input));
      }

      if (method === "POST" && p === "/api/chemical-batches") {
        const input = await readBody(req);
        return sendDomain(res, await invalidateBatch(store, input.code, input.note));
      }

      if (method === "POST" && p === "/api/faults") {
        const input = await readBody(req);
        const fault = store.setFault(input);
        return send(res, 200, { ok: true, fault });
      }

      send(res, 404, { error: "not_found", path: p });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  };
}
