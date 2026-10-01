// 存储层：JSON 文件持久化 + 原子写 + 故障注入 + 事务快照/回滚
// 页面、接口、存储分开承担 —— 本文件只负责"数据怎么落盘、怎么回滚"。
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");
const dbPath = join(dataDir, "cyanotype-negative-room.json");
const tmpPath = dbPath + ".tmp";

// 租约时长：工位认领后 30s 内持有，过期后别的工位可接管续做。
export const LEASE_MS = 30_000;
// 工艺检查点顺序：一块板必须按此顺序逐站续做。
export const PROCESS_STEPS = ["涂布", "晾干", "曝光", "冲洗", "复晒", "入盒"];
// 消耗药液的检查点（涂布感光液、冲洗显影液）。
export const CHEMICAL_STEPS = new Set(["涂布", "冲洗"]);
// 药液批次失效时，连带失效的下游检查点（显影结论之后的步骤都依赖它）。
export const DEVELOP_DOWNSTREAM = new Set(["冲洗", "复晒", "入盒"]);

function seed() {
  return {
    meta: {
      version: 1,
      leaseMs: LEASE_MS,
      currentChemicalBatch: "B-0620"
    },
    workstations: [
      { id: "W1", name: "东窗工位" },
      { id: "W2", name: "西窗工位" }
    ],
    chemicalBatches: [
      { code: "B-0620", version: 1, updatedAt: new Date().toISOString(), note: "初始药液批次", current: true }
    ],
    boxBatches: [],
    plates: [],
    events: [],
    telemetry: [],
    counters: { plate: 0, box: 0, event: 0 }
  };
}

// 把旧版 items 数据迁移成 plates（保留已有底片与步骤）。
function migrate(raw) {
  if (raw.plates && raw.meta) return raw;
  const db = seed();
  const items = Array.isArray(raw.items) ? raw.items : [];
  for (const it of items) {
    const checkpoints = (it.steps || []).map(s => ({
      step: s.step,
      at: s.at || new Date().toISOString(),
      workstation: null,
      chemicalBatch: it.chemicalBatch || "B-0620",
      developStatus: s.developStatus || null,
      defect: s.defect || it.defect || null,
      result: s.repair || s.note || null,
      valid: true,
      invalidReason: null,
      note: s.note || ""
    }));
    db.plates.push({
      id: it.id || it.code,
      code: it.code,
      plateSize: it.plateSize || "",
      chemicalBatch: it.chemicalBatch || "B-0620",
      exposure: it.exposure || "",
      waterSource: it.waterSource || "",
      box: it.box || "",
      status: it.status || "待曝光",
      defect: it.defect || null,
      holder: null,
      leaseExpiresAt: null,
      checkpoints,
      consumptions: [],
      boxBatchId: null,
      invalidReason: null,
      invalidatedAt: null,
      requeueCount: 0,
      logs: it.logs || []
    });
  }
  db.counters.plate = db.plates.length;
  return db;
}

export class Store {
  constructor() {
    this.db = null;
    // 故障注入：writeFailures 表示接下来几次写盘必失败；randomRate 表示随机失败概率。
    this.fault = { writeFailures: 0, randomRate: 0 };
    // 运行期重试遥测（内存态，环形缓冲；持久结论以 events/checkpoints/consumptions 为准）。
    this.telemetry = [];
  }

  async load() {
    if (this.db) return this.db;
    if (!existsSync(dbPath)) {
      await mkdir(dataDir, { recursive: true });
      this.db = seed();
      await this.save();
      return this.db;
    }
    const raw = JSON.parse(await readFile(dbPath, "utf8"));
    this.db = migrate(raw);
    return this.db;
  }

  // 原子写：先写临时文件再 rename，避免写一半掉电留下坏文件。
  // 故障注入在这里抛错，模拟"写盘失败"。
  async save() {
    if (this.fault.writeFailures > 0) {
      this.fault.writeFailures -= 1;
      const err = new Error("模拟写盘失败 (EIO)：磁盘写入未完成");
      err.code = "EIO";
      throw err;
    }
    if (this.fault.randomRate > 0 && Math.random() < this.fault.randomRate) {
      const err = new Error("模拟写盘失败 (EIO)：随机磁盘错误");
      err.code = "EIO";
      throw err;
    }
    await mkdir(dataDir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(this.db, null, 2));
    await rename(tmpPath, dbPath);
  }

  setFault(f) {
    if (typeof f.writeFailures === "number") this.fault.writeFailures = Math.max(0, f.writeFailures);
    if (typeof f.randomRate === "number") this.fault.randomRate = Math.min(1, Math.max(0, f.randomRate));
    return { ...this.fault };
  }

  snapshot() {
    return structuredClone(this.db);
  }
  restore(snap) {
    this.db = snap;
  }
  pushTelemetry(rec) {
    this.telemetry.unshift(rec);
    if (this.telemetry.length > 60) this.telemetry.length = 60;
  }
}
