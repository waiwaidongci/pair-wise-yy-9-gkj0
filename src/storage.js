// 存储层：只负责 JSON 文件的串行读写与原子落盘。
// - transact 串行化所有「读-改-写」，两个工位并发时第二个一定看到第一个的提交结果；
// - 临时文件 + rename 原子写：写盘失败不会留下半截文件，更不会出现「占用已落盘、完成记录没落盘」；
// - 每次落盘自带有限重试，重试次数写进业务负载（lastRetry），页面可展示重试结果；
// - X-Fail-Writes 故障注入：让 rename 前失败，用于验证「按检查点重试、不重复消耗药液」。
import { mkdir, readFile, writeFile, rename, unlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_MAX_ATTEMPTS = 3;

export class PersistError extends Error {
  constructor(cause, attempts) {
    super(`写盘连续 ${attempts} 次失败：${cause.message}`);
    this.name = "PersistError";
    this.code = "persist_failed";
    this.status = 503;
    this.cause = cause;
    this.attempts = attempts;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();

export class JsonStore {
  constructor(file, initial, { maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
    this.file = file;
    this.initial = initial;
    this.maxAttempts = maxAttempts;
    this.#tail = Promise.resolve();
  }

  #tail; // 互斥队列
  #cache;

  // 初次读取：文件不存在则用 initial 建文件；存在则原样返回（迁移由上层判断）。
  async #loadOnce() {
    if (this.#cache) return this.#cache;
    if (!existsSync(this.file)) {
      await mkdir(dirname(this.file), { recursive: true });
      const seeded = structuredClone(this.initial);
      await this.#atomicWrite(seeded, { value: 0 }, true);
      this.#cache = seeded;
      return seeded;
    }
    this.#cache = JSON.parse(await readFile(this.file, "utf8"));
    return this.#cache;
  }

  async read() {
    const release = await this.#lock();
    try {
      return structuredClone(await this.#loadOnce());
    } finally {
      release();
    }
  }

  // mutate 是纯函数：在快照副本上改，返回 { state, result, retry }。
  // retry：本次操作的「重试结果」描述，会随每次落盘尝试写入对应板的 lastRetry。
  // 只有某次尝试真正落盘成功，缓存才会切换；全部失败则内存与磁盘都保持旧状态。
  async transact(mutate, { failCredits = 0 } = {}) {
    const release = await this.#lock();
    try {
      const snapshot = structuredClone(await this.#loadOnce());
      const output = mutate(snapshot, { now: new Date() });
      if (!output || !output.state) throw new Error("mutator 必须返回 { state }");

      const credits = { value: Math.max(0, Number(failCredits) || 0) };
      let lastError;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        const payload = structuredClone(output.state);
        if (output.retry) this.#stampRetry(payload, output.retry, attempt);
        try {
          await this.#atomicWrite(payload, credits, false);
          this.#cache = payload;
          return { attempts: attempt, result: output.result ?? null };
        } catch (error) {
          lastError = error;
          if (attempt < this.maxAttempts) await sleep(40 * attempt);
        }
      }
      throw new PersistError(lastError, this.maxAttempts);
    } finally {
      release();
    }
  }

  #stampRetry(state, retry, attempt) {
    const record = {
      at: iso(),
      kind: retry.kind,
      ok: true,
      attempts: attempt,
      maxAttempts: this.maxAttempts,
      message: retry.message || `写盘第 ${attempt} 次尝试成功`,
    };
    const plates = state.plates || [];
    const targets = retry.plateIds
      ? plates.filter((p) => retry.plateIds.includes(p.id))
      : plates;
    for (const plate of targets) plate.lastRetry = { ...record };
    state.lastRetry = { ...record, scope: retry.plateIds ? "plate" : "global" };
  }

  async #atomicWrite(data, credits, isSeed) {
    const tmp = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    if (!isSeed && credits.value > 0) {
      credits.value -= 1;
      await rm(tmp, { force: true });
      throw new Error("模拟写盘失败（rename 前故障注入，临时文件已丢弃）");
    }
    try {
      await rename(tmp, this.file);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }

  #lock() {
    const previous = this.#tail;
    let release;
    this.#tail = previous.then(() => new Promise((r) => (release = r)));
    return previous.then(() => release);
  }
}
