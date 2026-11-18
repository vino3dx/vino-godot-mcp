import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

export interface ProcessAdapterOptions { cwd?: string; env?: NodeJS.ProcessEnv }
export interface ProcessExit { exitCode: number | null; signal: NodeJS.Signals | null }
export interface ProcessAdapterHandle {
  readonly pid: number | undefined;
  /** Resolves only after the OS emits spawn; rejects for pre-spawn errors. */
  readonly spawned: Promise<void>;
  readonly exited: Promise<ProcessExit>;
  onStdout(listener: (chunk: Buffer) => void): () => void;
  onStderr(listener: (chunk: Buffer) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  /**
   * 发信号。返回是否成功投递(false = 进程已退出或信号发不出去)。
   * 注意:返回 true 只代表信号发出去了,**不代表进程已经死**;确认退出只能看 `exited`。
   */
  stop(signal?: NodeJS.Signals): Promise<boolean>;
  /**
   * 放弃这个子进程(不再等待、不再收集输出):摘掉 stream 监听与订阅者。
   * 只用于"退出无法确认"的兜底路径 —— 调用方拿不到退出码,必须按未确认退出处理。
   */
  dispose(): void;
}
export type SpawnProcess = (file: string, args: readonly string[], options: ProcessAdapterOptions) => ChildProcess;

/** Owns one spawned child and exposes only stream, exit, PID and stop capabilities. */
export class ProcessAdapter {
  constructor(private readonly spawnProcess: SpawnProcess = defaultSpawn) {}

  start(file: string, args: readonly string[], options: ProcessAdapterOptions = {}): ProcessAdapterHandle {
    let child: ChildProcess;
    try { child = this.spawnProcess(file, args, options); }
    catch (error) { throw error; }

    const stdoutListeners = new Set<(chunk: Buffer) => void>();
    const stderrListeners = new Set<(chunk: Buffer) => void>();
    const errorListeners = new Set<(error: Error) => void>();
    let startupError: Error | undefined;
    /** 返回解绑函数:abort 后放弃子进程时要把 stream 监听也摘掉,不然会一直挂着排空管道。 */
    const onData = (stream: Readable | null, listeners: Set<(chunk: Buffer) => void>): (() => void) => {
      if (!stream) return () => {};
      const handler = (chunk: Buffer | string): void => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (const listener of [...listeners]) listener(data);
      };
      stream.on("data", handler);
      return () => stream.off("data", handler);
    };
    const detachStdout = onData(child.stdout, stdoutListeners);
    const detachStderr = onData(child.stderr, stderrListeners);

    let exited = false;
    let spawnSettled = false;
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => { spawnSettled = true; resolve(); });
      child.once("error", (error) => { if (!spawnSettled) { spawnSettled = true; reject(error); } });
    });
    const exit = new Promise<ProcessExit>((resolve) => {
      child.once("close", (exitCode, signal) => {
        exited = true;
        stdoutListeners.clear(); stderrListeners.clear(); errorListeners.clear();
        resolve({ exitCode, signal });
      });
    });
    child.on("error", (error) => { startupError = error; for (const listener of [...errorListeners]) listener(error); });

    return {
      get pid() { return child.pid; },
      spawned,
      exited: exit,
      onStdout: (listener) => subscribe(stdoutListeners, listener, exited),
      onStderr: (listener) => subscribe(stderrListeners, listener, exited),
      onError: (listener) => { if (startupError) { listener(startupError); return () => {}; } return subscribe(errorListeners, listener, exited); },
      stop: (signal = "SIGTERM") => Promise.resolve(exited ? false : child.kill(signal)),
      dispose: () => {
        detachStdout();
        detachStderr();
        stdoutListeners.clear(); stderrListeners.clear(); errorListeners.clear();
        // 管道另一端的读取端也关掉:即使进程还活着,也不再占用本进程的 fd 与内存。
        child.stdout?.destroy();
        child.stderr?.destroy();
      },
    };
  }
}

function defaultSpawn(file: string, args: readonly string[], options: ProcessAdapterOptions): ChildProcess {
  return spawn(file, [...args], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

function subscribe<T>(listeners: Set<(value: T) => void>, listener: (value: T) => void, exited: boolean): () => void {
  if (exited) return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}
