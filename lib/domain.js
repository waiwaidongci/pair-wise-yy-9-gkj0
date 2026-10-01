// 领域层：玻璃板（plate）的持有、检查点续做、药液批次失效重排、入盒、幂等消耗。
// 核心不变量：
//   1) 一块板同一时刻只由一个工位持有（租约），晚到者不能覆盖；
//   2) 租约过期后，从最近检查点续做（不重头来）；
//   3) 药液批次更新 -> 旧显影结论失效 -> 重排，下游步骤连带失效；
//   4) 写盘失败按检查点重试：消耗幂等（不重复扣药液）、持有与完成同生共死（不留下占用却没完成记录）。
import { LEASE_MS, PROCESS_STEPS, CHEMICAL_STEPS, DEVELOP_DOWNSTREAM } from "./store.js";

const MAX_ATTEMPTS = 4;
const BACKOFF_MS = 40;

const now = () => new Date().toISOString();
const nowMs = () => Date.now();

function nextId(db, key, prefix) {
  db.counters[key] = (db.counters[key] || 0) + 1;
  return prefix + "-" + String(db.counters[key]).padStart(4, "0");
}

export function leaseActive(plate, at = nowMs()) {
  return !!plate.holder && !!plate.leaseExpiresAt && new Date(plate.leaseExpiresAt).getTime() > at;
}

// 最近一个"有效"检查点（按工艺顺序倒序找）。
export function lastValidCheckpoint(plate) {
  for (let i = PROCESS_STEPS.length - 1; i >= 0; i--) {
    const step = PROCESS_STEPS[i];
    for (let j = plate.checkpoints.length - 1; j >= 0; j--) {
      const c = plate.checkpoints[j];
      if (c.step === step && c.valid) return c;
    }
  }
  return null;
}

// 下一个该做的检查点：第一个还没有"有效"记录的步骤。
export function nextStep(plate) {
  for (const step of PROCESS_STEPS) {
    if (!plate.checkpoints.some(c => c.step === step && c.valid)) return step;
  }
  return null;
}

function statusFor(plate) {
  const ns = nextStep(plate);
  if (!ns) return "已交付";
  if (ns === "冲洗") return "冲洗中";
  if (ns === "复晒" || ns === "入盒") return "待入盒";
  return "待曝光";
}

function addEvent(db, type, plateId, workstation, extra = {}) {
  const ev = { id: nextId(db, "event", "EV"), at: now(), type, plateId, workstation, ...extra };
  db.events.unshift(ev);
  return ev;
}

// 幂等消耗：key = 板+步骤+批次，重试不会重复扣药液。
function consume(db, plate, step, workstation, batch) {
  const key = `${plate.id}:${step}:${batch}`;
  const existing = plate.consumptions.find(c => c.key === key);
  if (existing) return { key, already: true };
  plate.consumptions.push({
    key, plateId: plate.id, step, chemicalBatch: batch, workstation, at: now(), amount: 1
  });
  addEvent(db, "药液消耗", plate.id, workstation, {
    reason: `${step} 消耗药液 ${batch}`,
    detail: `消耗凭证 ${key}（幂等，重复写盘不会重复扣减）`
  });
  return { key, already: false };
}

// 事务：在内存里改 -> 落盘；落盘失败则回滚内存到上一个持久快照，再从检查点重试。
// 因为每次重试都回到"最近一次持久状态"，且消耗按 key 去重，所以重试既不会重复消耗，
// 也不会留下"已占用却没完成记录"的中间态。
async function transact(store, fn, telemetryCtx) {
  const attempts = [];
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const snap = store.snapshot();
    try {
      const outcome = fn(store.db);
      // 重试事件与本次操作并入同一次落盘，原子持久化（不额外写盘）。
      if (attempts.length) {
        addEvent(store.db, "重试", telemetryCtx.plateId, telemetryCtx.workstation || null, {
          reason: `写盘失败后重试 ${attempts.length} 次成功`,
          detail: attempts.map(a => `第${a.attempt}次：${a.error}`).join("；")
        });
      }
      await store.save();
      return { ok: true, attempts, outcome };
    } catch (err) {
      attempts.push({ attempt: i, at: now(), ok: false, error: err.message, code: err.code || "EIO" });
      store.restore(snap);
      if (i === MAX_ATTEMPTS) {
        store.pushTelemetry({ at: now(), ...telemetryCtx, attempts: [...attempts], ok: false, error: err.message });
        return { ok: false, attempts, error: err.message, code: err.code || "EIO" };
      }
      await new Promise(r => setTimeout(r, BACKOFF_MS * i));
    }
  }
}

function recordTelemetry(store, ctx, res) {
  store.pushTelemetry({ at: now(), ...ctx, attempts: res.attempts, ok: res.ok, error: res.error || null });
}

function findPlate(db, id) {
  return db.plates.find(p => p.id === id || p.code === id);
}

// ---- 建档 ----
export async function createPlate(store, input) {
  const db = store.db;
  const res = await transact(store, (db) => {
    const id = nextId(db, "plate", "CN");
    const plate = {
      id,
      code: input.code || id,
      plateSize: input.plateSize || "",
      chemicalBatch: db.meta.currentChemicalBatch,
      exposure: input.exposure || "",
      waterSource: input.waterSource || "",
      box: input.box || "",
      status: "待曝光",
      defect: null,
      holder: null,
      leaseExpiresAt: null,
      checkpoints: [],
      consumptions: [],
      boxBatchId: null,
      invalidReason: null,
      invalidatedAt: null,
      requeueCount: 0,
      logs: [{ at: now(), step: "建档", note: "创建玻璃板" }]
    };
    db.plates.unshift(plate);
    addEvent(db, "建档", plate.id, null, { reason: "玻璃板建档", detail: `初始药液批次 ${db.meta.currentChemicalBatch}` });
    return { kind: "建档", plateId: plate.id };
  }, { op: "建档", plateId: null });
  recordTelemetry(store, { op: "建档", plateId: res.outcome && res.outcome.plateId }, res);
  return { ok: res.ok, status: res.ok ? 201 : 500, plateId: res.outcome && res.outcome.plateId, attempts: res.attempts, error: res.error };
}

// ---- 认领 / 持有（租约）。过期则接管续做，续租则延期。 ----
export async function claimPlate(store, plateId, workstationId) {
  const db = store.db;
  const plate = findPlate(db, plateId);
  if (!plate) return { ok: false, status: 404, error: "plate_not_found", reason: "找不到这块玻璃板" };
  if (!db.workstations.some(w => w.id === workstationId)) return { ok: false, status: 404, error: "workstation_not_found", reason: "工位不存在" };

  const t = nowMs();
  if (plate.holder && leaseActive(plate, t) && plate.holder !== workstationId) {
    return {
      ok: false, status: 409, error: "held_by_other",
      holder: plate.holder, leaseExpiresAt: plate.leaseExpiresAt,
      reason: `晚到的工位不能覆盖在持板：${plate.holder} 持有中，租约至 ${plate.leaseExpiresAt}`
    };
  }

  const wasHolder = plate.holder;
  const expired = !!plate.holder && !leaseActive(plate, t);
  const resume = lastValidCheckpoint(plate);
  const res = await transact(store, (db) => {
    const p = findPlate(db, plateId);
    p.holder = workstationId;
    p.leaseExpiresAt = new Date(t + LEASE_MS).toISOString();
    if (expired) {
      addEvent(db, "接管", p.id, workstationId, {
        from: wasHolder,
        reason: "租约过期，由新工位接管",
        detail: resume ? `从最近检查点「${resume.step}」续做，下一站「${nextStep(p)}」` : "尚无检查点，从头开始"
      });
    } else if (wasHolder === workstationId) {
      addEvent(db, "续租", p.id, workstationId, { reason: "工位续租，延长持有" });
    } else {
      addEvent(db, "认领", p.id, workstationId, { reason: "工位认领，开始持有本板" });
    }
    return { kind: expired ? "接管" : (wasHolder === workstationId ? "续租" : "认领"), resumeFrom: resume && resume.step, next: nextStep(p) };
  }, { op: "认领", plateId, workstationId });
  recordTelemetry(store, { op: res.outcome ? res.outcome.kind : "认领", plateId, workstationId }, res);
  return { ok: res.ok, status: res.ok ? 200 : 500, outcome: res.outcome, attempts: res.attempts, error: res.error };
}

// ---- 记录工艺检查点（含入盒）。必须由在持工位在租约内、按顺序记录。 ----
export async function recordCheckpoint(store, plateId, workstationId, input) {
  const db = store.db;
  const plate = findPlate(db, plateId);
  if (!plate) return { ok: false, status: 404, error: "plate_not_found", reason: "找不到这块玻璃板" };
  if (!db.workstations.some(w => w.id === workstationId)) return { ok: false, status: 404, error: "workstation_not_found", reason: "工位不存在" };

  const t = nowMs();
  if (plate.holder !== workstationId) {
    return { ok: false, status: 409, error: "not_holder", holder: plate.holder, reason: `本板由 ${plate.holder || "（无）"} 持有，请先认领` };
  }
  if (!leaseActive(plate, t)) {
    return { ok: false, status: 409, error: "lease_expired", holder: plate.holder, reason: "租约已过期，请接管后续做" };
  }
  const expected = nextStep(plate);
  if (!expected) return { ok: false, status: 409, error: "already_complete", reason: "本板已完成全部检查点并入盒" };
  if (input.step !== expected) {
    return { ok: false, status: 409, error: "wrong_step", expected, resumeFrom: expected, reason: `应从最近检查点续做：下一站是「${expected}」，不是「${input.step}」` };
  }

  const batch = db.meta.currentChemicalBatch;
  const res = await transact(store, (db) => {
    const p = findPlate(db, plateId);
    const step = input.step;
    const cp = {
      step,
      at: now(),
      workstation: workstationId,
      chemicalBatch: batch,
      developStatus: input.developStatus || null,
      defect: input.defect || null,
      result: input.result || input.note || null,
      valid: true,
      invalidReason: null,
      note: input.note || ""
    };
    p.checkpoints.push(cp);
    if (input.defect) p.defect = input.defect;

    // 重新冲洗成功 -> 清除失效标记（历史失效记录仍保留在 events/checkpoints 上）。
    if (step === "冲洗") {
      p.invalidReason = null;
      p.invalidatedAt = null;
    }

    // 入盒：分配/加入一个进行中的入盒批次。
    if (step === "入盒") {
      let box = db.boxBatches.find(b => b.status === "进行中");
      if (!box) {
        const id = nextId(db, "box", "BOX");
        box = { id, code: `入盒批次 ${id}`, createdAt: now(), status: "进行中", plateIds: [] };
        db.boxBatches.unshift(box);
      }
      if (!box.plateIds.includes(p.id)) box.plateIds.push(p.id);
      p.boxBatchId = box.id;
      addEvent(db, "入盒", p.id, workstationId, { reason: `装入 ${box.code}`, detail: `盒位 ${p.box || "—"}` });
    }

    // 入盒即交付：释放持有，避免"已交付却仍被占用"。
    if (step === "入盒") {
      p.holder = null;
      p.leaseExpiresAt = null;
    }

    // 消耗药液（幂等）。
    let consumeInfo = null;
    if (CHEMICAL_STEPS.has(step)) consumeInfo = consume(db, p, step, workstationId, batch);

    p.status = statusFor(p);
    addEvent(db, "工艺检查点", p.id, workstationId, {
      reason: `「${step}」完成`,
      detail: `药液批次 ${batch}` + (consumeInfo ? (consumeInfo.already ? "；消耗凭证已存在，跳过重复扣减" : "；已消耗 1 份药液") : "")
    });
    return { kind: "工艺检查点", step, batch, consumed: consumeInfo && !consumeInfo.already, alreadyConsumed: consumeInfo && consumeInfo.already, next: nextStep(p) };
  }, { op: "检查点:" + expected, plateId, workstationId });
  recordTelemetry(store, { op: "检查点:" + expected, plateId, workstationId }, res);
  return { ok: res.ok, status: res.ok ? 200 : 500, outcome: res.outcome, attempts: res.attempts, error: res.error };
}

// ---- 药液批次更新：旧显影结论失效 -> 重排 ----
export async function invalidateBatch(store, newCode, note) {
  const db = store.db;
  if (!newCode || !String(newCode).trim()) return { ok: false, status: 400, error: "batch_required", reason: "请提供新药液批次编号" };
  const code = String(newCode).trim();
  const oldCode = db.meta.currentChemicalBatch;
  if (code === oldCode) return { ok: false, status: 409, error: "same_batch", reason: "新批次与当前批次相同" };

  const res = await transact(store, (db) => {
    for (const b of db.chemicalBatches) b.current = false;
    const version = db.chemicalBatches.length + 1;
    db.chemicalBatches.push({ code, version, updatedAt: now(), note: note || "药液批次更新", current: true });
    db.meta.currentChemicalBatch = code;

    const affected = [];
    for (const p of db.plates) {
      let hit = false;
      for (const cp of p.checkpoints) {
        if (DEVELOP_DOWNSTREAM.has(cp.step) && cp.valid && cp.chemicalBatch === oldCode) {
          cp.valid = false;
          cp.invalidReason = cp.step === "冲洗"
            ? `药液批次 ${oldCode} → ${code}，本显影结论失效`
            : `药液批次 ${oldCode} → ${code}，随显影结论连带失效`;
          hit = true;
        }
      }
      if (hit) {
        p.invalidReason = `药液批次更新：${oldCode} → ${code}，旧显影结论失效，需重新冲洗`;
        p.invalidatedAt = now();
        p.status = "待重洗";
        p.requeueCount = (p.requeueCount || 0) + 1;
        const wasHolder = p.holder;
        p.holder = null;
        p.leaseExpiresAt = null;
        addEvent(db, "失效", p.id, null, { reason: p.invalidReason, detail: "显影结论及下游步骤失效，释放持有，重新排队", from: wasHolder });
        addEvent(db, "重排", p.id, null, { reason: "从最近检查点续做", detail: `下一站「${nextStep(p) || "—"}」` });
        affected.push({ id: p.id, code: p.code, resumeFrom: nextStep(p) });
      }
    }
    return { kind: "药液批次更新", oldCode, newCode: code, affected };
  }, { op: "批次更新", plateId: null });
  recordTelemetry(store, { op: "批次更新", plateId: null }, res);
  return { ok: res.ok, status: res.ok ? 200 : 500, outcome: res.outcome, attempts: res.attempts, error: res.error };
}
