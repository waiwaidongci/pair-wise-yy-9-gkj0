// 服务器入口：只做装配 —— 存储(storage) ← 领域规则(workflow) ← 接口(api) ← 页面(page)。
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonStore } from "./src/storage.js";
import { createApiRouter, ensureMigrated } from "./src/api.js";
import { createInitialState } from "./src/workflow.js";
import { renderPage } from "./src/page.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "data", "cyanotype-negative-room.json");
const port = Number(process.env.PORT || 3040);

const store = new JsonStore(dbPath, createInitialState(new Date()));
const apiRouter = createApiRouter(store);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(renderPage());
    }
    if (url.pathname.startsWith("/api/")) return apiRouter(req, res, url.pathname);
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: error.code || "internal_error", message: error.message }));
  }
});

ensureMigrated(store)
  .then((migrated) => {
    server.listen(port, () => {
      console.log(`古法蓝晒底片整理室 listening on http://localhost:${port}`);
      console.log(`存储：${dbPath}${migrated ? "（已从 v1 迁移到转手链结构）" : ""}`);
    });
  })
  .catch((error) => {
    console.error("启动失败：", error);
    process.exit(1);
  });

export { server, store };
