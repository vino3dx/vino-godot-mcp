import path from "node:path";
import { GodotMcpError } from "../errors.js";
import { cancelledError } from "./cancellation.js";

/** 谁在占用/等待锁。用于"提示真正运行的任务"。 */
export interface LockOwner { tool: string; target: string; taskId: string; since: number }
export type LockOwnerInput = Omit<LockOwner, "since" | "taskId"> & { taskId?: string };

export interface LockWaitInfo { key: string; heldBy: LockOwner; queuePosition: number }
/**
 * signal:排队期间的取消。abort 后这个 waiter 会从队列里摘掉并抛 TASK_CANCELLED,
 * 不会占着位置、也不会在之后被 grant(见 grant 里的竞争处理)。
 */
export interface AcquireOptions { timeoutMs?: number; onWait?: (info: LockWaitInfo) => void; signal?: AbortSignal }
export interface LockSnapshotEntry { key: string; holder: LockOwner; waiting: LockOwner[] }

interface Waiter { owner: LockOwner; grant: () => void; reject: (e: Error) => void }
interface Slot { holder: LockOwner; queue: Waiter[] }

let seq = 0;
export const newTaskId = (): string => `t${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** 规范化锁 key:路径统一为绝对路径,Windows 下大小写不敏感。 */
export function normalizeLockKey(p: string): string {
  const abs = path.resolve(p).replace(/\\/g, "/");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * 进程内的 FIFO 互斥锁,按 key 独立排队。
 * 范围:仅同一 MCP 进程有效;跨进程需要磁盘锁文件(后续可选项,见 docs/architecture.md)。
 */
export class LockManager {
  private readonly slots = new Map<string, Slot>();

  async acquire(key: string, input: LockOwnerInput, opts: AcquireOptions = {}): Promise<() => void> {
    const owner: LockOwner = { ...input, taskId: input.taskId ?? newTaskId(), since: Date.now() };
    const slot = this.slots.get(key);
    if (!slot) {
      this.slots.set(key, { holder: owner, queue: [] });
      return this.releaser(key, owner);
    }
    opts.onWait?.({ key, heldBy: slot.holder, queuePosition: slot.queue.length + 1 });
    return new Promise<() => void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        opts.signal?.removeEventListener("abort", onAbort);
      };
      /** 授权与取消的竞争:已经决定放弃的 waiter 即使被 grant 也不能真的拿到锁。 */
      const waiter: Waiter = {
        owner,
        grant: () => {
          if (opts.signal?.aborted) {
            // 先 grant 后 abort(或相反)都可能发生:把刚拿到的锁立刻还回去,再按取消返回,
            // 否则这个 key 会永久卡在一个"已取消却持有锁"的持有者手里。
            cleanup();
            this.releaser(key, owner)();
            reject(cancelledError({ operation: input.tool, stage: "queue", signal: opts.signal, hint: `Cancelled while waiting for lock "${key}".` }));
            return;
          }
          cleanup();
          owner.since = Date.now();
          resolve(this.releaser(key, owner));
        },
        reject,
      };
      const onAbort = (): void => {
        const i = slot.queue.indexOf(waiter);
        if (i >= 0) slot.queue.splice(i, 1);
        cleanup();
        reject(cancelledError({ operation: input.tool, stage: "queue", signal: opts.signal, hint: `Cancelled while waiting for lock "${key}".` }));
      };
      slot.queue.push(waiter);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const i = slot.queue.indexOf(waiter);
          if (i >= 0) slot.queue.splice(i, 1);
          cleanup();
          reject(new GodotMcpError("LOCK_TIMEOUT", `Timed out after ${opts.timeoutMs}ms waiting for lock "${key}"`, {
            key, waitedMs: opts.timeoutMs, heldBy: slot.holder, heldForMs: Date.now() - slot.holder.since,
          }));
        }, opts.timeoutMs);
      }
    });
  }

  /** 按 key 排序依次加锁(固定顺序,防死锁),fn 结束或抛错都会释放。 */
  async withLocks<T>(
    keys: string[], input: LockOwnerInput, fn: () => Promise<T>, opts: AcquireOptions = {},
  ): Promise<T> {
    const sorted = [...new Set(keys)].sort();
    const taskId = input.taskId ?? newTaskId();
    const releases: Array<() => void> = [];
    try {
      for (const k of sorted) releases.push(await this.acquire(k, { ...input, taskId }, opts));
      return await fn();
    } finally {
      for (const r of releases.reverse()) r();
    }
  }

  snapshot(): LockSnapshotEntry[] {
    return [...this.slots.entries()].map(([key, s]) => ({ key, holder: { ...s.holder }, waiting: s.queue.map((w) => ({ ...w.owner })) }));
  }

  private releaser(key: string, owner: LockOwner): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const slot = this.slots.get(key);
      if (!slot || slot.holder !== owner) return;
      const next = slot.queue.shift();
      if (!next) { this.slots.delete(key); return; }
      slot.holder = next.owner;
      next.grant();
    };
  }
}
