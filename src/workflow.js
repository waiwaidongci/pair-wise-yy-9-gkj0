// 领域层：玻璃板 / 工艺检查点 / 药液批次 / 入盒批次 的转手链规则。
// 所有变更都经过这里的纯函数，存储层负责把结果原子落盘。
//
// 转手链约定：
//   acquire(租约) → heartbeat(续租) → advance(推进检查点，可幂等重放)
//     → handoff(交接释放) / release(释放)；租约过期后他人可 acquire，从最近检查点续做。
//   药液轮换会使「冲洗」之后的显影结论失效：旧检查点标记 invalid，板回到待重排队列，
//   从最近一个有效检查点（曝光）续做；药液消耗按请求幂等键去重，绝不重复消耗。

export const STATIONS = [
  { id: "station-a", name: "工位甲" },
  { id: "station-b", name: "工位乙" },
];

// 蓝晒工艺：每完成一步就留下一个不可变检查点（重排时旧点标 invalid，不删除）
export const PIPELINE = ["涂布", "晾干", "曝光", "冲洗", "复晒", "入盒"];
export const LEASE_TTL_MS = Number(process.env.LEASE_TTL_MS || 60_000);

// 显影结论从「冲洗」检查点产生；药液轮换让这一步及之后的结论失效，
// 续做的最近检查点是冲洗前的「曝光」。
export const DEVELOP_STAGE = "冲洗";

export class DomainError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = 409;
    Object.assign(this, extra);
  }
}

const pad = (n) => String(n).padStart(2, "0");
export const nowIso = () => new Date().toISOString();
export const timestamp = () => new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const id = (prefix, seq) => `${prefix}-${timestamp()}-${pad(seq)}`;

const clone = (x) => structuredClone(x);
const stationName = (sid) => STATIONS.find((s) => s.id === sid)?.name || sid;

function assert(condition, code, message, extra) {
  if (!condition) throw new DomainError(code, message, extra);
}

// ---------- 视图（页面/接口共用） ----------

export function activeLease(plate, nowMs = Date.now()) {
  if (!plate.lease || plate.lease.releasedAt) return null;
  return plate.lease.expiresAt > nowMs ? plate.lease : null;
}

export function validCheckpoints(plate) {
  return (plate.checkpoints || []).filter((c) => c.valid !== false);
}

export function nextStage(plate) {
  return PIPELINE[validCheckpoints(plate).length] || null;
}

// 显影结论（冲洗检查点）是否有效
export function developConclusion(plate) {
  const cp = validCheckpoints(plate).find((c) => c.stage === DEVELOP_STAGE);
  if (!cp) return null;
  return {
    batchId: cp.batchId,
    conclusion: cp.conclusion || "",
    defect: cp.defect || "",
    at: cp.at,
  };
}

export function plateStatus(plate, nowMs = Date.now()) {
  const cps = validCheckpoints(plate);
  if (cps.length === 0) return "待开始";
  if (cps.length >= PIPELINE.length) return "已交付";
  if (activeLease(plate, nowMs)) return "处理中";
  if (plate.invalidated) return "待重排";
  return "排队中";
}

// 排队位置：未完成且无人持有的板，按入队时间先后（重排板到队尾）
export function queueOf(view) {
  const nowMs = Date.now();
  return view.plates
    .filter((p) => plateStatus(p, nowMs) === "排队中" || plateStatus(p, nowMs) === "待重排")
    .sort((a, b) => (a.queuedAt || "").localeCompare(b.queuedAt || ""))
    .map((p) => p.id);
}

export function buildView(state) {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const plates = state.plates.map((p) => {
    const held = activeLease(p, nowMs);
    const cps = validCheckpoints(p);
    const resume = held
      ? null
      : { stage: PIPELINE[cps.length] || null, checkpoint: cps[cps.length - 1]?.stage || null };
    return {
      ...p,
      lease: held ? { ...held, holderName: stationName(held.station) } : null,
      status: plateStatus(p, nowMs),
      nextStage: nextStage(p),
      resume,
      develop: developConclusion(p),
      queuePosition: 0,
    };
  });
  const queue = plates
    .filter((p) => p.status === "排队中" || p.status === "待重排")
    .sort((a, b) => (a.queuedAt || "").localeCompare(b.queuedAt || ""))
    .map((p) => p.id);
  queue.forEach((pid, i) => {
    plates.find((p) => p.id === pid).queuePosition = i + 1;
  });
  const stats = Object.fromEntries(
    ["待开始", "排队中", "处理中", "待重排", "已交付"].map((s) => [s, 0]),
  );
  for (const p of plates) stats[p.status] += 1;

  const eventsByPlate = new Map();
  for (const e of state.events || []) {
    if (!e.plateId) continue;
    if (!eventsByPlate.has(e.plateId)) eventsByPlate.set(e.plateId, []);
    eventsByPlate.get(e.plateId).push(e);
  }
  return {
    serverTime: nowIso,
    leaseTtlMs: LEASE_TTL_MS,
    pipeline: PIPELINE,
    stations: STATIONS,
    stats,
    queue,
    plates: plates.map((p) => ({ ...p, events: eventsByPlate.get(p.id) || [] })),
    chemicalBatches: state.chemicalBatches,
    activeBatchId: state.activeBatchId,
    boxBatches: state.boxBatches,
    consumptions: state.consumptions,
    events: (state.events || []).slice(-60),
    lastRetry: state.lastRetry || null,
  };
}

// ---------- 事件 ----------

function pushEvent(state, { plateId, type, at, station, message, data }) {
  state.events ||= [];
  const seq = state.seq.event + 1;
  state.seq.event = seq;
  state.events.push({ id: id("EV", seq), at: at || nowIso(), plateId, type, station, message, data });
}

function nextPlateCode(state) {
  const seq = state.seq.plate + 1;
  state.seq.plate = seq;
  const used = new Set(state.plates.map((p) => p.code));
  let code = `CN-${pad(seq)}`;
  let extra = 0;
  while (used.has(code)) code = `CN-${pad(seq)}-${++extra}`;
  return code;
}

// ---------- 租约 ----------

function findPlate(state, plateId) {
  const plate = state.plates.find((p) => p.id === plateId);
  assert(plate, "plate_not_found", "找不到这块玻璃板", { status: 404 });
  return plate;
}

function requireLease(plate, token) {
  assert(plate.lease && !plate.lease.releasedAt, "no_lease", "当前没有工位持有此板，需先领取");
  if (plate.lease.expiresAt <= Date.now()) {
    throw new DomainError(
      "lease_expired",
      `租约已于 ${new Date(plate.lease.expiresAt).toLocaleString("zh-CN")} 过期`,
      { expiredAt: plate.lease.expiresAt },
    );
  }
  assert(plate.lease.token === token, "lease_holder_mismatch", "租约令牌不匹配，本工位不是当前持有人", {
    holder: plate.lease.station,
  });
  return plate.lease;
}

export function createInitialState(now = new Date()) {
  const t = now.toISOString();
  return {
    version: 2,
    seq: { plate: 4, chemical: 2, box: 1, consumption: 2, event: 0 },
    activeBatchId: "B-0921",
    chemicalBatches: [
      { id: "B-0620", createdAt: "2026-06-20T00:00:00.000Z", status: "retired", note: "夏季批次，显影边角不均" },
      { id: "B-0921", createdAt: "2026-09-21T08:00:00.000Z", status: "active", note: "当前在用显影液" },
    ],
    plates: [
      {
        id: "plate-1",
        code: "CN-001",
        plateSize: "18x24cm",
        exposure: "8分钟",
        waterSource: "井水过滤",
        defect: "边角显影不均",
        repair: "边角重涂",
        note: "v1 数据迁移：旧库曾记录入盒但无入盒批次与盒位占用，按已完成到复晒重建",
        batchId: "B-0620",
        queuedAt: t,
        checkpoints: [
          { at: "2026-06-20T00:00:00.000Z", stage: "涂布", station: "station-a", note: "古法铁盐涂布" },
          { at: "2026-06-20T01:00:00.000Z", stage: "晾干", station: "station-a", note: "阴干" },
          { at: "2026-06-20T02:00:00.000Z", stage: "曝光", station: "station-a", note: "阴天补时2分钟", metric: "8分钟" },
          {
            at: "2026-06-21T03:40:00.000Z",
            stage: "冲洗",
            station: "station-a",
            batchId: "B-0620",
            consumptionId: "cons-1",
            conclusion: "边角显影不均",
            defect: "边角显影不均",
          },
          { at: "2026-06-21T03:45:00.000Z", stage: "复晒", station: "station-a", note: "边角重涂后复晒" },
        ],
      },
      {
        id: "plate-2",
        code: "CN-002",
        plateSize: "12x18cm",
        exposure: "6分钟",
        waterSource: "井水过滤",
        batchId: "B-0620",
        queuedAt: "2026-09-21T09:00:00.000Z",
        checkpoints: [
          { at: "2026-09-20T01:00:00.000Z", stage: "涂布", station: "station-b", note: "均匀涂布" },
          { at: "2026-09-20T02:00:00.000Z", stage: "晾干", station: "station-b" },
          { at: "2026-09-20T03:00:00.000Z", stage: "曝光", station: "station-b", metric: "6分钟" },
          {
            at: "2026-09-20T03:10:00.000Z",
            stage: "冲洗",
            station: "station-b",
            batchId: "B-0620",
            consumptionId: "cons-2",
            conclusion: "显影合格",
            valid: true,
          },
        ],
        invalidated: {
          at: "2026-09-21T08:05:00.000Z",
          reasonCode: "chemical_rotated",
          reason: "药液轮换：旧批次 B-0620 停用，9月21日前的显影结论作废，回到曝光检查点重排",
          fromBatchId: "B-0620",
          toBatchId: "B-0921",
          resumeFrom: "曝光",
        },
      },
      {
        id: "plate-3",
        code: "CN-003",
        plateSize: "10x15cm",
        exposure: "5分钟",
        waterSource: "雨水沉淀",
        batchId: "B-0921",
        queuedAt: "2026-09-22T09:00:00.000Z",
        checkpoints: [],
      },
      {
        id: "plate-4",
        code: "CN-004",
        plateSize: "24x30cm",
        exposure: "10分钟",
        waterSource: "井水过滤",
        batchId: "B-0921",
        queuedAt: "2026-09-23T09:00:00.000Z",
        checkpoints: [],
      },
    ],
    consumptions: [
      {
        id: "cons-1",
        plateId: "plate-1",
        code: "CN-001",
        batchId: "B-0620",
        stage: "冲洗",
        amountMl: 300,
        at: "2026-06-21T03:40:00.000Z",
        requestId: "seed-cons-1",
        voided: true,
        voidReason: "显影结论随 B-0620 轮换失效；药液已真实消耗，保留台账不退回",
      },
      {
        id: "cons-2",
        plateId: "plate-2",
        code: "CN-002",
        batchId: "B-0620",
        stage: "冲洗",
        amountMl: 250,
        at: "2026-09-20T03:10:00.000Z",
        requestId: "seed-cons-2",
        voided: true,
        voidReason: "显影结论随 B-0620 轮换失效；重做时按新批次重新计量",
      },
    ],
    boxBatches: [],
    events: [],
  };
}

// v1（旧 server.js 的 { items } 结构）迁移：旧记录里「入盒」没有盒位占用，
// 统一按「最近有效检查点」重建，绝不凭空补占用。
export function migrateV1(raw, now = new Date()) {
  const t = now.toISOString();
  const state = createInitialState(now);
  state.plates = [];
  state.consumptions = [];
  state.boxBatches = [];
  state.seq = { plate: 0, chemical: 0, box: 0, consumption: 0, event: 0 };
  state.events = [];

  const batches = new Map();
  const ensureBatch = (bid) => {
    if (!bid) return null;
    if (!batches.has(bid)) {
      batches.set(bid, { id: bid, createdAt: t, status: "unknown", note: "v1 迁移：批次状态未知，轮换时请先登记" });
    }
    return bid;
  };

  (raw.items || []).forEach((item, idx) => {
    state.seq.plate += 1;
    const plateId = `plate-${idx + 1}`;
    const checkpoints = [];
    const steps = item.steps || [];
    const wash = steps.find((s) => s.step === "冲洗" || s.developStatus);
    const delivered = item.status === "已交付";

    for (const stage of PIPELINE) {
      if (stage === "冲洗" && !wash) continue;
      if ((stage === "复晒" || stage === "入盒") && !delivered && checkpoints.length < 3) {
        // 旧库「待入盒」与入盒记录矛盾时保守处理：只重建到复晒
      }
      if (stage === "入盒" && !delivered) continue;
      const cp = { at: t, stage, station: "station-a" };
      if (stage === "曝光") cp.metric = item.exposure || "";
      if (stage === "冲洗") {
        ensureBatch(item.chemicalBatch);
        state.seq.consumption += 1;
        const cid = `cons-${state.seq.consumption}`;
        cp.batchId = item.chemicalBatch || null;
        cp.conclusion = wash?.developStatus || "";
        cp.defect = wash?.defect || item.defect || "";
        cp.consumptionId = cid;
        if (item.chemicalBatch) {
          state.consumptions.push({
            id: cid,
            plateId,
            code: item.code,
            batchId: item.chemicalBatch,
            stage: "冲洗",
            amountMl: null,
            at: wash?.at || t,
            requestId: `migrate-${cid}`,
            voided: false,
            note: "v1 迁移保留的历史消耗",
          });
        }
      }
      if (stage === "复晒" && (item.repair || item.defect)) cp.note = item.repair || item.defect;
      checkpoints.push(cp);
    }

    const plate = {
      id: plateId,
      code: item.code || `CN-${pad(state.seq.plate)}`,
      plateSize: item.plateSize || "",
      exposure: item.exposure || "",
      waterSource: item.waterSource || "",
      defect: item.defect || "",
      repair: item.repair || "",
      note: "v1 数据迁移重建；旧盒位字段无占用记录支撑，需重新入盒",
      batchId: item.chemicalBatch || state.activeBatchId,
      queuedAt: t,
      checkpoints,
    };
    if (item.chemicalBatch) ensureBatch(item.chemicalBatch);
    state.plates.push(plate);
  });

  state.chemicalBatches = [...batches.values()];
  if (!state.chemicalBatches.some((b) => b.id === state.activeBatchId)) {
    state.activeBatchId = state.chemicalBatches[0]?.id || null;
  }
  pushEvent(state, {
    type: "migrated",
    at: t,
    message: `检测到 v1 数据，已迁移 ${state.plates.length} 块板：按最近有效检查点重建，旧盒位不保留占用`,
  });
  return state;
}

// ---------- 变更操作（返回 { state, result, retry }） ----------

export function createPlate(state, input = {}, { now = new Date() } = {}) {
  const t = now.toISOString();
  const code = (input.code || "").trim() || nextPlateCode(state);
  assert(!state.plates.some((p) => p.code === code), "code_conflict", `编号 ${code} 已存在`);
  const seq = state.seq.plate + 1;
  state.seq.plate = seq;
  const plate = {
    id: `plate-${timestamp()}-${pad(seq)}`,
    code,
    plateSize: input.plateSize || "",
    exposure: input.exposure || "",
    waterSource: input.waterSource || "",
    batchId: input.batchId || state.activeBatchId,
    queuedAt: t,
    checkpoints: [],
    note: input.note || "",
  };
  state.plates.push(plate);
  pushEvent(state, { plateId: plate.id, at: t, type: "created", message: `新板 ${code} 进入待开始队列` });
  return {
    state,
    result: { plate: summarizePlate(plate), hint: "已建档，等待工位领取租约" },
    retry: { kind: "create", plateIds: [plate.id], message: "建档记录写盘重试" },
  };
}

// 领取租约：一块板同一时刻只允许一个工位持有；
// 晚到的工位若遇到未过期租约会被拒（不再覆盖盒位/药液占用），租约过期则可接管续做。
export function acquire(state, plateId, input = {}, { now = new Date() } = {}) {
  const t = now.toISOString();
  const plate = findPlate(state, plateId);
  const station = input.station;
  assert(STATIONS.some((s) => s.id === station), "bad_station", "工位必须是 station-a 或 station-b");
  assert(validCheckpoints(plate).length < PIPELINE.length, "plate_finished", "该板已全部工序完成，无需再领取");

  const held = activeLease(plate, now.getTime());
  if (held) {
    assert(held.station === station, "plate_held", `板正由${stationName(held.station)}持有，租约未过期，不能覆盖`, {
      status: 423,
      holder: held.station,
      holderName: stationName(held.station),
      expiresAt: held.expiresAt,
    });
    // 同工位重复领取：等价续租（幂等），不换令牌
    held.expiresAt = now.getTime() + LEASE_TTL_MS;
    held.heartbeats.push(t);
    pushEvent(state, {
      plateId: plate.id,
      at: t,
      station,
      type: "lease-heartbeat",
      message: `${stationName(station)} 重复领取，按续租处理`,
    });
    return {
      state,
      result: { plate: summarizePlate(plate), acquired: false, renewed: true, token: held.token },
      retry: { kind: "acquire", plateIds: [plate.id], message: "续租写盘重试" },
    };
  }

  const expired = plate.lease && plate.lease.releasedAt !== true && plate.lease.expiresAt <= now.getTime();
  const history = plate.lease ? [...(plate.lease.history || []), { ...plate.lease }] : [];
  const token = `lease-${timestamp()}-${pad(state.seq.event + 1)}-${Math.random().toString(36).slice(2, 8)}`;
  plate.lease = {
    token,
    station,
    acquiredAt: t,
    expiresAt: now.getTime() + LEASE_TTL_MS,
    heartbeats: [],
    history,
  };
  const resumeStage = nextStage(plate);
  pushEvent(state, {
    plateId: plate.id,
    at: t,
    station,
    type: expired ? "lease-takeover" : "lease-acquired",
    message: expired
      ? `${stationName(station)}接管过期租约，从最近检查点「${validCheckpoints(plate).at(-1)?.stage || "无"}」续做「${resumeStage}」`
      : `${stationName(station)}领取 ${plate.code}，当前步骤「${resumeStage}」`,
    data: { resumeStage, expired: !!expired },
  });
  return {
    state,
    result: {
      plate: summarizePlate(plate),
      acquired: true,
      token,
      holder: station,
      resumeStage,
    },
    retry: { kind: "acquire", plateIds: [plate.id], message: "领取租约写盘重试" },
  };
}

export function heartbeat(state, plateId, input = {}, { now = new Date() } = {}) {
  const plate = findPlate(state, plateId);
  const lease = requireLease(plate, input.token);
  lease.expiresAt = now.getTime() + LEASE_TTL_MS;
  lease.heartbeats.push(now.toISOString());
  pushEvent(state, {
    plateId: plate.id,
    at: now.toISOString(),
    station: lease.station,
    type: "lease-heartbeat",
    message: `${stationName(lease.station)}续租至 ${new Date(lease.expiresAt).toLocaleString("zh-CN")}`,
  });
  return {
    state,
    result: { plate: summarizePlate(plate), renewed: true },
    retry: { kind: "heartbeat", plateIds: [plate.id], message: "续租写盘重试" },
  };
}

// 交接：把板释放回队列（可指定下一个工位）；只有一次状态变更，绝不留「占用却无记录」
export function handoff(state, plateId, input = {}, { now = new Date() } = {}) {
  const t = now.toISOString();
  const plate = findPlate(state, plateId);
  const lease = plate.lease;
  assert(lease && !lease.releasedAt, "no_lease", "当前没有生效租约，无需交接");
  if (lease.expiresAt <= now.getTime()) {
    return recover(state, plateId, {}, { now });
  }
  assert(lease.token === input.token, "lease_holder_mismatch", "不是持有人，不能交接", {
    holder: lease.station,
  });
  lease.releasedAt = t;
  lease.handoffTo = input.toStation || null;
  plate.queuedAt = t; // 回到队尾，避免插队
  pushEvent(state, {
    plateId: plate.id,
    at: t,
    station: lease.station,
    type: "lease-handoff",
    message: `${stationName(lease.station)}交接${input.toStation ? `给${stationName(input.toStation)}` : "回队列"}，停在检查点「${
      validCheckpoints(plate).at(-1)?.stage || "无"
    }」`,
  });
  return {
    state,
    result: { plate: summarizePlate(plate), handedOff: true },
    retry: { kind: "handoff", plateIds: [plate.id], message: "交接写盘重试" },
  };
}

export function release(state, plateId, input = {}, { now = new Date() } = {}) {
  const t = now.toISOString();
  const plate = findPlate(state, plateId);
  assert(plate.lease && !plate.lease.releasedAt, "no_lease", "当前没有生效租约");
  assert(plate.lease.token === input.token, "lease_holder_mismatch", "不是持有人，不能释放", {
    holder: plate.lease.station,
  });
  plate.lease.releasedAt = t;
  plate.queuedAt = t;
  pushEvent(state, {
    plateId: plate.id,
    at: t,
    station: plate.lease.station,
    type: "lease-released",
    message: `${stationName(plate.lease.station)}释放 ${plate.code}，板回到队列`,
  });
  return {
    state,
    result: { plate: summarizePlate(plate), released: true },
    retry: { kind: "release", plateIds: [plate.id], message: "释放写盘重试" },
  };
}

// 从过期租约恢复：当前持有人清空，板回到队列，续做点 = 最近有效检查点
export function recover(state, plateId, _input = {}, { now = new Date() } = {}) {
  const t = now.toISOString();
  const plate = findPlate(state, plateId);
  assert(plate.lease && !plate.lease.releasedAt, "no_expired_lease", "没有可恢复的过期租约");
  assert(plate.lease.expiresAt <= now.getTime(), "lease_alive", "租约尚未过期，不能强制恢复");
  const old = plate.lease;
  old.releasedAt = t;
  old.recovered = true;
  plate.queuedAt = t;
  const cps = validCheckpoints(plate);
  pushEvent(state, {
    plateId: plate.id,
    at: t,
    station: old.station,
    type: "lease-recovered",
    message: `${stationName(old.station)}的租约过期，板释放回队列，从最近检查点「${
      cps.at(-1)?.stage || "无"
    }」续做「${PIPELINE[cps.length] || "—"}」`,
    data: { resumeFrom: cps.at(-1)?.stage || null, nextStage: PIPELINE[cps.length] || null },
  });
  return {
    state,
    result: {
      plate: summarizePlate(plate),
      recovered: true,
      resumeFrom: cps.at(-1)?.stage || null,
      nextStage: PIPELINE[cps.length] || null,
    },
    retry: { kind: "recover", plateIds: [plate.id], message: "租约恢复写盘重试" },
  };
}

export function reapExpired(state, _input = {}, { now = new Date() } = {}) {
  const ids = [];
  for (const plate of state.plates) {
    if (plate.lease && !plate.lease.releasedAt && plate.lease.expiresAt <= now.getTime()) {
      ids.push(plate.id);
      const r = recover(state, plate.id, {}, { now });
      state = r.state;
    }
  }
  return {
    state,
    result: { recoveredPlateIds: ids, count: ids.length },
    retry: ids.length
      ? { kind: "reap", plateIds: ids, message: "批量恢复过期租约写盘重试" }
      : undefined,
  };
}

// ---------- 工艺检查点推进（核心：幂等重放 + 药液不重复消耗） ----------

export function advance(state, plateId, input = {}, { now = new Date() } = {}) {
  const t = now.toISOString();
  const plate = findPlate(state, plateId);
  const station = plate.lease?.station;

  // 幂等键：默认按 令牌+当前应做步骤 派生。写盘成功但响应丢失时（哪怕租约恰好已过期），
  // 工位拿着同一令牌重试也应先识别幂等：命中已完成检查点 → 原样回放，不推进、不扣药液、不占盒位。
  const cpsBefore = validCheckpoints(plate);
  const expectedStage = PIPELINE[cpsBefore.length];
  const requestId = input.requestId || `${input.token || ""}:${expectedStage || ""}`;
  const replayCp = plate.checkpoints.find((c) => c.requestId === requestId && c.valid !== false);
  if (replayCp) {
    pushEvent(state, {
      plateId: plate.id,
      at: t,
      station,
      type: "checkpoint-replay",
      message: `「${replayCp.stage}」重复提交命中幂等检查点，直接回放，未重复消耗药液/盒位`,
      data: { requestId, checkpointId: replayCp.id },
    });
    return {
      state,
      result: {
        plate: summarizePlate(plate),
        advanced: false,
        replayed: true,
        stage: replayCp.stage,
        requestId,
        consumption: replayCp.consumptionId
          ? state.consumptions.find((c) => c.id === replayCp.consumptionId)
          : null,
        hint: "写盘后的重试被识别为重复请求，没有重复消耗药液",
      },
      retry: { kind: "advance", plateIds: [plate.id], message: `「${replayCp.stage}」幂等重放写盘重试` },
    };
  }

  // 非重放的推进必须持有有效租约（一块板同一时刻只有一个工位能写检查点）
  requireLease(plate, input.token);
  assert(expectedStage, "plate_finished", "所有工艺检查点已完成");
  const holderStation = plate.lease.station;

  // 允许调用方显式声明步骤；不传则按最近检查点续做
  const stage = input.stage || expectedStage;
  assert(stage === expectedStage, "stage_mismatch", `最近检查点是「${cpsBefore.at(-1)?.stage || "无"}」，本步只能续做「${expectedStage}」`, {
    expected: expectedStage,
  });

  const cp = {
    id: `cp-${timestamp()}-${pad(state.seq.event + 1)}`,
    at: t,
    stage,
    station: holderStation,
    requestId,
    note: input.note || "",
    valid: true,
  };

  let consumption = null;
  if (stage === DEVELOP_STAGE) {
    // 药液必须属于当前有效批次
    const batchId = plate.batchId;
    const batch = state.chemicalBatches.find((b) => b.id === batchId);
    assert(batch, "no_batch", "该板未指定药液批次");
    assert(batch.status === "active", "batch_not_active", `批次 ${batchId} 已停用，不能用于冲洗，请先轮换药液`, {
      status: 422,
      batchId,
    });
    // 同一幂等键绝不重复记账
    const dup = state.consumptions.find((c) => c.requestId === requestId);
    if (!dup) {
      state.seq.consumption += 1;
      const cid = `cons-${state.seq.consumption}`;
      consumption = {
        id: cid,
        plateId: plate.id,
        code: plate.code,
        batchId,
        stage,
        amountMl: input.amountMl == null ? 300 : Number(input.amountMl),
        at: t,
        station: holderStation,
        requestId,
        voided: false,
      };
      state.consumptions.push(consumption);
      cp.batchId = batchId;
      cp.consumptionId = cid;
    }
    cp.conclusion = input.conclusion || "显影合格";
    cp.defect = input.defect || "";
    if (cp.defect) plate.defect = cp.defect;
  }

  if (stage === "曝光") cp.metric = input.metric || plate.exposure || "";
  if (input.repair) {
    cp.repair = input.repair;
    plate.repair = input.repair;
  }

  if (stage === "入盒") {
    // 盒位占用与入盒完成记录在同一次原子提交里：要么都成立，要么都不成立
    const batch = openBoxBatch(state, t);
    const slot = nextSlot(state, batch);
    batch.slots.push({ slot, plateId: plate.id, code: plate.code, at: t, station: holderStation });
    cp.boxBatchId = batch.id;
    cp.slot = slot;
    plate.boxBatchId = batch.id;
    plate.boxSlot = slot;
    plate.deliveredAt = t;
  }

  plate.checkpoints.push(cp);

  // 重排后的重做走到入盒时，失效记录归档闭环；此前一直保留失效原因展示
  if (stage === "入盒" && plate.invalidated) {
    plate.invalidatedHistory ||= [];
    plate.invalidatedHistory.push({ ...plate.invalidated, clearedAt: t });
    delete plate.invalidated;
  }

  // 入盒后自动释放租约；其他步骤继续持有（工序没做完）
  if (stage === "入盒" && plate.lease) {
    plate.lease.releasedAt = t;
    plate.lease.completed = true;
  }

  pushEvent(state, {
    plateId: plate.id,
    at: t,
    station: holderStation,
    type: "checkpoint",
    message:
      stage === "入盒"
        ? `「入盒」完成：入盒批次 ${cp.boxBatchId} 盒位 ${cp.slot}，租约自动释放`
        : stage === "冲洗"
          ? `「冲洗」完成：使用 ${cp.batchId}，消耗 ${consumption?.amountMl ?? 300}ml，结论「${cp.conclusion}」`
          : `「${stage}」检查点完成`,
    data: { stage, requestId, consumptionId: cp.consumptionId || null, boxBatchId: cp.boxBatchId || null, slot: cp.slot || null },
  });

  return {
    state,
    result: {
      plate: summarizePlate(plate),
      advanced: true,
      stage,
      requestId,
      consumption,
      slot: cp.slot || null,
      boxBatchId: cp.boxBatchId || null,
    },
    retry: {
      kind: "advance",
      plateIds: [plate.id],
      message: `「${stage}」检查点写盘重试（重试不会重复扣药液/占盒位）`,
    },
  };
}

// ---------- 药液批次：登记 / 指定 / 轮换（失效重排） ----------

export function registerChemical(state, input = {}, { now = new Date() } = {}) {
  const t = now.toISOString();
  const batchId = (input.batchId || "").trim();
  assert(batchId, "bad_batch", "必须填写批次号");
  assert(!state.chemicalBatches.some((b) => b.id === batchId), "batch_exists", `批次 ${batchId} 已登记`);
  state.seq.chemical += 1;
  state.chemicalBatches.push({
    id: batchId,
    createdAt: t,
    status: input.status || "active",
    note: input.note || "",
  });
  if (input.activate || (!state.activeBatchId && input.status !== "retired")) state.activeBatchId = batchId;
  pushEvent(state, { at: t, type: "chemical-registered", message: `登记药液批次 ${batchId}` });
  return {
    state,
    result: { batchId, activated: state.activeBatchId === batchId },
    retry: { kind: "chemical", message: "批次登记写盘重试" },
  };
}

// 给单块板指定批次：显影结论已按旧批次做出且尚未入盒 → 旧结论失效，回曝光重排
export function assignChemical(state, plateId, input = {}, { now = new Date() } = {}) {
  const t = now.toISOString();
  const plate = findPlate(state, plateId);
  const toBatchId = (input.batchId || "").trim();
  const batch = state.chemicalBatches.find((b) => b.id === toBatchId);
  assert(batch, "batch_not_found", `批次 ${toBatchId} 未登记`, { status: 404 });
  if (plate.batchId === toBatchId) {
    return { state, result: { plate: summarizePlate(plate), changed: false }, retry: undefined };
  }
  assert(validCheckpoints(plate).length < PIPELINE.length, "plate_finished", "已入盒完成的板不能改批次", {
    status: 422,
  });

  const fromBatchId = plate.batchId;
  plate.batchId = toBatchId;
  let invalidated = false;
  const developed = validCheckpoints(plate).some((c) => c.stage === DEVELOP_STAGE);
  if (developed) {
    invalidateDevelop(state, plate, {
      reasonCode: "chemical_reassigned",
      reason: `药液批次由 ${fromBatchId || "未指定"} 更新为 ${toBatchId}：旧显影结论失效，从曝光检查点重排`,
      fromBatchId,
      toBatchId,
      at: t,
    });
    invalidated = true;
  }
  pushEvent(state, {
    plateId: plate.id,
    at: t,
    type: invalidated ? "chemical-invalidate" : "chemical-assigned",
    message: invalidated
      ? `${plate.code} 改用药液 ${toBatchId}，旧显影结论作废并重排`
      : `${plate.code} 指定药液 ${toBatchId}（尚未冲洗，直接生效）`,
  });
  return {
    state,
    result: { plate: summarizePlate(plate), changed: true, invalidated },
    retry: invalidated
      ? { kind: "chemical", plateIds: [plate.id], message: "批次更新导致重排，写盘重试" }
      : undefined,
  };
}

// 全局轮换：新批次启用，旧批次停用；所有「已显影未入盒」的板批量失效重排
export function rotateChemical(state, input = {}, { now = new Date() } = {}) {
  const t = now.toISOString();
  const toBatchId = (input.batchId || "").trim();
  assert(toBatchId, "bad_batch", "必须填写新批次号");
  if (!state.chemicalBatches.some((b) => b.id === toBatchId)) {
    state.seq.chemical += 1;
    state.chemicalBatches.push({ id: toBatchId, createdAt: t, status: "active", note: input.note || "" });
  }
  const fromBatchId = state.activeBatchId;
  assert(fromBatchId !== toBatchId, "same_batch", "新批次与当前批次相同");

  for (const b of state.chemicalBatches) if (b.status === "active") b.status = "retired";
  state.chemicalBatches.find((b) => b.id === toBatchId).status = "active";
  state.activeBatchId = toBatchId;

  const invalidatedPlateIds = [];
  for (const plate of state.plates) {
    if (validCheckpoints(plate).length >= PIPELINE.length) continue; // 已入盒的不动
    const developed = validCheckpoints(plate).some((c) => c.stage === DEVELOP_STAGE);
    if (!developed) {
      plate.batchId = toBatchId; // 还没显影：下次冲洗直接用新液
      continue;
    }
    plate.batchId = toBatchId;
    invalidateDevelop(state, plate, {
      reasonCode: "chemical_rotated",
      reason: `药液轮换：${fromBatchId || "旧批次"} → ${toBatchId}，旧显影结论失效，从曝光检查点重排`,
      fromBatchId,
      toBatchId,
      at: t,
    });
    invalidatedPlateIds.push(plate.id);
  }
  pushEvent(state, {
    at: t,
    type: "chemical-rotated",
    message: `药液轮换为 ${toBatchId}，${invalidatedPlateIds.length} 块板显影结论失效并回到待重排队列`,
    data: { fromBatchId, toBatchId, invalidatedPlateIds },
  });
  return {
    state,
    result: { fromBatchId, toBatchId, invalidatedPlateIds, invalidatedCount: invalidatedPlateIds.length },
    retry: invalidatedPlateIds.length
      ? { kind: "rotate", plateIds: invalidatedPlateIds, message: "药液轮换失效重排写盘重试" }
      : { kind: "rotate", message: "药液轮换写盘重试" },
  };
}

// 让冲洗及之后的检查点失效，旧药液消耗标记 voided（台账保留，不退回、不补扣）
function invalidateDevelop(state, plate, info) {
  const cut = PIPELINE.indexOf(DEVELOP_STAGE);
  const removed = [];
  for (const cp of plate.checkpoints) {
    if (cp.valid !== false && PIPELINE.indexOf(cp.stage) >= cut) {
      cp.valid = false;
      cp.invalidatedAt = info.at;
      cp.invalidReason = info.reason;
      removed.push(cp);
      if (cp.consumptionId) {
        const c = state.consumptions.find((x) => x.id === cp.consumptionId);
        if (c && !c.voided) {
          c.voided = true;
          c.voidReason = info.reason;
        }
      }
    }
  }
  if (plate.lease && !plate.lease.releasedAt) {
    plate.lease.releasedAt = info.at;
    plate.lease.forcedBy = info.reasonCode;
  }
  plate.queuedAt = info.at; // 重排到队尾
  plate.invalidated = {
    at: info.at,
    reasonCode: info.reasonCode,
    reason: info.reason,
    fromBatchId: info.fromBatchId,
    toBatchId: info.toBatchId,
    resumeFrom: PIPELINE[cut - 1],
    voidedCheckpointStages: removed.map((c) => c.stage),
  };
  delete plate.boxBatchId;
  delete plate.boxSlot;
  pushEvent(state, {
    plateId: plate.id,
    at: info.at,
    type: "invalidated",
    message: info.reason,
    data: { resumeFrom: PIPELINE[cut - 1], voidedConsumptions: removed.filter((c) => c.consumptionId).length },
  });
}

// ---------- 入盒批次 ----------

function openBoxBatch(state, at) {
  let batch = state.boxBatches.find((b) => b.status === "open");
  if (!batch) {
    state.seq.box += 1;
    batch = {
      id: `BOX-${new Date(at).getFullYear()}-${pad(state.seq.box)}`,
      openedAt: at,
      status: "open",
      slots: [],
      capacity: 20,
    };
    state.boxBatches.push(batch);
  }
  return batch;
}

function nextSlot(state, batch) {
  const used = new Set(batch.slots.map((s) => s.slot));
  for (let i = 1; i <= batch.capacity; i++) {
    const slot = `A-${pad(i)}`;
    if (!used.has(slot)) return slot;
  }
  throw new DomainError("box_full", `入盒批次 ${batch.id} 已满，请封盒后开新批次`);
}

export function sealBoxBatch(state, input = {}, { now = new Date() } = {}) {
  const t = now.toISOString();
  const batchId = input.boxBatchId || state.boxBatches.find((b) => b.status === "open")?.id;
  const batch = state.boxBatches.find((b) => b.id === batchId);
  assert(batch, "box_batch_not_found", "没有可封存的入盒批次", { status: 404 });
  assert(batch.status === "open", "box_batch_closed", `批次 ${batchId} 已封存`);
  batch.status = "sealed";
  batch.sealedAt = t;
  pushEvent(state, {
    at: t,
    type: "box-sealed",
    message: `入盒批次 ${batch.id} 封存，共 ${batch.slots.length} 块板`,
  });
  return {
    state,
    result: { boxBatch: batch },
    retry: { kind: "box", message: "封盒写盘重试" },
  };
}

// ---------- 汇总 ----------

function summarizePlate(plate) {
  const nowMs = Date.now();
  return {
    id: plate.id,
    code: plate.code,
    holder: activeLease(plate, nowMs)?.station || null,
    status: plateStatus(plate, nowMs),
    nextStage: nextStage(plate),
    checkpoints: plate.checkpoints.length,
    invalidated: plate.invalidated || null,
  };
}
