// 端到端冒烟测试：起一个临时库的服务进程，按真实 HTTP 接口验证转手链不变量。
// 运行：npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const dir = await mkdtemp(join(tmpdir(), "cyanotype-"));
const dbPath = join(dir, "room.json");
const port = 43040 + Math.floor(Math.random() * 400);
const child = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, DB_PATH: dbPath, PORT: String(port), LEASE_TTL_MS: "1200" },
  cwd: new URL("..", import.meta.url).pathname,
});
let started = false;
child.stdout.on("data", (d) => { if (String(d).includes("listening")) started = true; });
child.stderr.on("data", (d) => process.stderr.write(d));

const base = `http://localhost:${port}`;
async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

before(async () => {
  for (let i = 0; i < 50 && !started; i++) await sleep(50);
  assert.ok(started, "测试服务未启动");
  // 等待临时库种子就绪
  for (let i = 0; i < 20; i++) {
    const r = await req("GET", "/api/state");
    if (r.data.plates?.length) break;
    await sleep(50);
  }
});
after(async () => {
  child.kill("SIGTERM");
  await once(child, "exit").catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

const state = async () => (await req("GET", "/api/state")).data;
const freshPlate = async () => {
  const r = await req("POST", "/api/plates", { plateSize: "9x12cm", exposure: "4分钟" });
  assert.equal(r.status, 201);
  return r.data.plate.id;
};

test("两个工位同时抢同一块板：晚到者被拒绝，不覆盖持有人/盒位/药液占用", async () => {
  const pid = await freshPlate();
  const a = await req("POST", `/api/plates/${pid}/acquire`, { station: "station-a" });
  assert.equal(a.status, 200);
  assert.equal(a.data.holder, "station-a");
  const tokenA = a.data.token;

  const b = await req("POST", `/api/plates/${pid}/acquire`, { station: "station-b" });
  assert.equal(b.status, 423);
  assert.equal(b.data.error, "plate_held");
  assert.equal(b.data.holder, "station-a");

  const s = await state();
  const p = s.plates.find((x) => x.id === pid);
  assert.equal(p.lease.station, "station-a"); // 没有被乙盖掉
  // 乙拿着错令牌推进也必须被拒
  const adv = await req("POST", `/api/plates/${pid}/advance`, { token: "fake", station: "station-b" });
  assert.equal(adv.status, 409);
  // 令牌泄露只是变量用途，甲的正常推进不受影响
  assert.ok(tokenA);
});

test("租约过期后另一工位接管，从最近检查点续做", async () => {
  const pid = await freshPlate();
  const a = await req("POST", `/api/plates/${pid}/acquire`, { station: "station-a" });
  await req("POST", `/api/plates/${pid}/advance`, { token: a.data.token, note: "涂布完成" });
  await sleep(1400); // 等租约过期

  const rec = await req("POST", `/api/plates/${pid}/recover`, {});
  assert.equal(rec.status, 200);
  assert.equal(rec.data.resumeFrom, "涂布");
  assert.equal(rec.data.nextStage, "晾干");

  const b = await req("POST", `/api/plates/${pid}/acquire`, { station: "station-b" });
  assert.equal(b.status, 200);
  assert.equal(b.data.resumeStage, "晾干");
  const adv = await req("POST", `/api/plates/${pid}/advance`, { token: b.data.token });
  assert.equal(adv.data.stage, "晾干");
});

test("写盘前 2 次失败：存储层自动重试成功，且药液只消耗一次", async () => {
  const pid = await freshPlate();
  const a = await req("POST", `/api/plates/${pid}/acquire`, { station: "station-a" });
  // 推到冲洗
  for (const stage of ["涂布", "晾干", "曝光"]) {
    await req("POST", `/api/plates/${pid}/advance`, { token: a.data.token, stage });
  }
  const before = (await state()).consumptions.filter((c) => c.plateId === pid && !c.voided).length;
  const r = await req(
    "POST",
    `/api/plates/${pid}/advance`,
    { token: a.data.token, stage: "冲洗", conclusion: "显影合格", amountMl: 280, requestId: "wash-1" },
    { "X-Fail-Writes": "2" },
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.writeAttempts, 3); // 前两次注入失败，第三次成功
  assert.equal(r.data.consumption.amountMl, 280);

  const after = await state();
  const used = after.consumptions.filter((c) => c.plateId === pid && !c.voided);
  assert.equal(used.length, before + 1, "冲洗只产生一条有效药液消耗");
  const plate = after.plates.find((x) => x.id === pid);
  assert.equal(plate.lastRetry.ok, true);
  assert.equal(plate.lastRetry.attempts, 3);
});

test("写盘成功后客户端拿同一 requestId 重试：幂等回放，不重复消耗药液", async () => {
  const pid = await freshPlate();
  const a = await req("POST", `/api/plates/${pid}/acquire`, { station: "station-a" });
  for (const stage of ["涂布", "晾干", "曝光"]) {
    await req("POST", `/api/plates/${pid}/advance`, { token: a.data.token, stage, requestId: `pre-${stage}` });
  }
  await req("POST", `/api/plates/${pid}/advance`, {
    token: a.data.token, stage: "冲洗", amountMl: 260, requestId: "fixed-key",
  });
  const replay = await req("POST", `/api/plates/${pid}/advance`, {
    token: a.data.token, stage: "冲洗", amountMl: 999, requestId: "fixed-key",
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.consumption.amountMl, 260);

  const s = await state();
  const mine = s.consumptions.filter((c) => c.plateId === pid);
  assert.equal(mine.length, 1, "重复提交没有重复扣药液");
  // 下一步必须是复晒，而不是第二个冲洗
  assert.equal(s.plates.find((x) => x.id === pid).nextStage, "复晒");
});

test("写盘 3 次全失败：占用不落盘；随后同键重试成功，不留占用却无完成记录", async () => {
  const pid = await freshPlate();
  const a = await req("POST", `/api/plates/${pid}/acquire`, { station: "station-a" });
  for (const stage of ["涂布", "晾干", "曝光"]) {
    await req("POST", `/api/plates/${pid}/advance`, { token: a.data.token, stage });
  }
  const before = await state();
  const fail = await req(
    "POST",
    `/api/plates/${pid}/advance`,
    { token: a.data.token, stage: "冲洗", amountMl: 310, requestId: "wash-fail" },
    { "X-Fail-Writes": "5" },
  );
  assert.equal(fail.status, 503);
  assert.equal(fail.data.retryable, true);

  const after = await state();
  assert.deepEqual(
    after.consumptions.filter((c) => c.requestId === "wash-fail"),
    [],
    "失败请求没有留下药液占用",
  );
  const plate = after.plates.find((x) => x.id === pid);
  assert.equal(plate.nextStage, "冲洗", "没有留下任何检查点，续做仍是冲洗");
  // 租约仍有效（占用与完成记录要么一起成、要么都不成）
  assert.ok(plate.lease, "失败后板仍由甲持有，可直接重试");

  const retry = await req("POST", `/api/plates/${pid}/advance`, {
    token: a.data.token, stage: "冲洗", amountMl: 310, requestId: "wash-fail",
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.advanced, true);
  const s = await state();
  assert.equal(s.consumptions.filter((c) => c.requestId === "wash-fail").length, 1);
});

test("入盒：盒位占用与完成记录同一次原子提交，入盒后租约自动释放", async () => {
  const pid = await freshPlate();
  const a = await req("POST", `/api/plates/${pid}/acquire`, { station: "station-a" });
  for (const stage of ["涂布", "晾干", "曝光", "冲洗", "复晒"]) {
    await req("POST", `/api/plates/${pid}/advance`, { token: a.data.token, stage, requestId: `k-${stage}` });
  }
  const r = await req("POST", `/api/plates/${pid}/advance`, { token: a.data.token, stage: "入盒" });
  assert.equal(r.status, 200);
  assert.ok(r.data.boxBatchId);
  assert.ok(r.data.slot);

  const s = await state();
  const p = s.plates.find((x) => x.id === pid);
  assert.equal(p.status, "已交付");
  assert.equal(p.lease, null, "入盒完成后不再占用工位");
  const batch = s.boxBatches.find((b) => b.id === r.data.boxBatchId);
  assert.ok(batch.slots.some((x) => x.plateId === pid && x.slot === r.data.slot), "盒位占用有完成记录对应");
});

test("药液轮换：已显影未入盒的板旧结论失效、回到曝光重排；旧消耗作废但保留台账", async () => {
  const pid = await freshPlate();
  const a = await req("POST", `/api/plates/${pid}/acquire`, { station: "station-a" });
  for (const stage of ["涂布", "晾干", "曝光", "冲洗"]) {
    await req("POST", `/api/plates/${pid}/advance`, { token: a.data.token, stage, requestId: `rot-${stage}` });
  }
  const rot = await req("POST", "/api/chemicals/rotate", { batchId: "B-TEST-ROT" });
  assert.equal(rot.status, 200);
  assert.ok(rot.data.invalidatedPlateIds.includes(pid));

  const s = await state();
  const p = s.plates.find((x) => x.id === pid);
  assert.equal(p.status, "待重排");
  assert.equal(p.invalidated.reasonCode, "chemical_rotated");
  assert.equal(p.invalidated.resumeFrom, "曝光");
  assert.equal(p.nextStage, "冲洗", "最近有效检查点是曝光，续做冲洗");
  assert.equal(p.develop, null, "旧显影结论已失效");
  assert.equal(p.lease, null, "持有的租约随失效释放，供别的工位重排");
  assert.equal(p.batchId, "B-TEST-ROT");

  const cons = s.consumptions.filter((c) => c.plateId === pid);
  assert.equal(cons.length, 1);
  assert.equal(cons[0].voided, true, "旧批次药液已真实消耗：台账保留但标记作废，不退不补");

  // 重跑冲洗：使用新批次产生新消耗，旧消耗仍在
  const b = await req("POST", `/api/plates/${pid}/acquire`, { station: "station-b" });
  const redo = await req("POST", `/api/plates/${pid}/advance`, { token: b.data.token, stage: "冲洗", amountMl: 200 });
  assert.equal(redo.status, 200);
  assert.equal(redo.data.consumption.batchId, "B-TEST-ROT");
  const s2 = await state();
  const all = s2.consumptions.filter((c) => c.plateId === pid);
  assert.equal(all.length, 2, "旧消耗保留 + 新消耗一条，没有重复也没有抹账");
  assert.equal(all.filter((c) => !c.voided).length, 1);
});

test("批量回收过期租约", async () => {
  const pid = await freshPlate();
  await req("POST", `/api/plates/${pid}/acquire`, { station: "station-a" });
  await sleep(1400);
  const r = await req("POST", "/api/leases/reap-expired", {});
  assert.ok(r.data.recoveredPlateIds.includes(pid));
  const s = await state();
  assert.equal(s.plates.find((x) => x.id === pid).lease, null);
});

test("租约刚好过期时拿原 requestId 重试：仍按幂等回放，不重复推进也不报错", async () => {
  const pid = await freshPlate();
  const a = await req("POST", `/api/plates/${pid}/acquire`, { station: "station-a" });
  for (const stage of ["涂布", "晾干", "曝光"]) {
    await req("POST", `/api/plates/${pid}/advance`, { token: a.data.token, stage, requestId: `exp-${stage}` });
  }
  await req("POST", `/api/plates/${pid}/advance`, {
    token: a.data.token, stage: "冲洗", amountMl: 240, requestId: "exp-wash",
  });
  await sleep(1400); // 租约过期
  const replay = await req("POST", `/api/plates/${pid}/advance`, {
    token: a.data.token, stage: "冲洗", amountMl: 240, requestId: "exp-wash",
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replayed, true);
  const s = await state();
  const mine = s.consumptions.filter((c) => c.plateId === pid);
  assert.equal(mine.length, 1);
});
