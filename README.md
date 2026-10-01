# 古法蓝晒底片整理室 · 可恢复转手链

玻璃板、工艺检查点和入盒批次的转手链系统。两个工位（工位甲 / 工位乙）同时处理同一批板时：

- **一块板只由一个工位持有**：领取即获得带 TTL 的租约（默认 60 秒，可用 `LEASE_TTL_MS` 调）。
  晚到的工位会被明确拒绝（HTTP 423），不再把盒位、药液占用和状态「盖掉」。
- **租约过期可从最近检查点续做**：过期租约可由任意工位「接管」，系统回到最近一个有效检查点，
  下一步只允许续做该检查点之后的工序（涂布 → 晾干 → 曝光 → 冲洗 → 复晒 → 入盒）。
- **药液批次更新 → 旧显影结论失效重排**：轮换药液或给板改批次时，已显影但未入盒的板，
  其「冲洗」及之后的检查点标记失效，板回到待重排队列、从「曝光」检查点重跑；旧药液消耗
  在台账上标记作废（药液已真实用掉，不退不补），重跑按新批次重新计量，绝不重复消耗。
- **写盘失败按检查点重试**：所有变更在一个串行事务里「改内存副本 → 临时文件 → 原子 rename」，
  落盘自动重试 3 次。中途任何失败都不会留下「占用已落盘、完成记录没落盘」的半成品；
  全部失败返回 503，客户端持同一租约令牌与同一 `requestId` 重试，命中幂等检查点直接回放。
- **入盒原子性**：盒位占用与入盒完成记录同一次提交落盘，入盒后租约自动释放。

## 分层

| 文件 | 职责 |
| --- | --- |
| `src/page.js` | 页面：只负责显示（当前持有人、失效原因、重试结果、队列、台账）和调用接口 |
| `src/api.js` | 接口：HTTP/JSON 路由、错误码映射、请求事务化 |
| `src/workflow.js` | 领域规则：租约、检查点、失效重排、药液台账、入盒批次（纯函数） |
| `src/storage.js` | 存储：串行事务、临时文件原子写、写盘重试与故障注入 |
| `server.js` | 装配启动 |

## 运行

```bash
npm start        # http://localhost:3040
npm test         # 端到端冒烟测试（临时库，不碰 data/）
```

数据保存在 `data/cyanotype-negative-room.json`。检测到旧版（v1 `{items}`）数据会在首次
启动时透明迁移：按已完成工序重建检查点，旧的「盒位」字段因没有占用记录支撑而不保留，
需要重新入盒。

## 接口

- `GET  /api/state` 当前完整视图（板、队列、批次、台账、事件）
- `POST /api/plates` 建档入队
- `POST /api/plates/:id/acquire` `{station}` 领取租约（同工位重复领取=续租；他人持有返回 423）
- `POST /api/plates/:id/heartbeat` `{token}` 续租
- `POST /api/plates/:id/handoff` `{token,toStation?}` 交接回队列
- `POST /api/plates/:id/recover` 回收过期租约，返回续做检查点
- `POST /api/leases/reap-expired` 批量回收过期租约
- `POST /api/plates/:id/advance` `{token,stage?,requestId?,conclusion?,amountMl?,...}` 推进检查点
- `PUT  /api/plates/:id/chemical` `{batchId}` 给单板改批次（已显影则失效重排）
- `POST /api/chemicals` 登记批次
- `POST /api/chemicals/rotate` `{batchId}` 全局轮换并批量失效重排
- `POST /api/box-batches/seal` 封存当前开放入盒批次

写盘故障注入：写操作带请求头 `X-Fail-Writes: N`，让本次落盘的前 N 次 rename 前失败
（页面右上角可直接设置）。N=2 可观察自动重试成功；N≥3 时请求 503、状态完全不提交。
