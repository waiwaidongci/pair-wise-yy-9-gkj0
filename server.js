// 入口：组装 存储层(store) + 接口层(api) + 页面层(page)。
import http from "node:http";
import { Store } from "./lib/store.js";
import { createApi } from "./lib/api.js";
import { pageHtml } from "./lib/page.js";

const port = Number(process.env.PORT || 3040);
const store = new Store();
await store.load();

const server = http.createServer(createApi(store, pageHtml));
server.listen(port, () => {
  console.log("古法蓝晒 · 转手链整理室 listening on http://localhost:" + port);
});
