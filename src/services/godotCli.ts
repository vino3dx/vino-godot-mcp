// Godot CLI 探测服务:tools 层唯一能触达 godot 层的入口(架构测试强制 tools 不直接 import godot)。
import { GodotMcpError } from "../core/errors.js";
import {
  getGodotVersion,
  resolveCandidates,
  type GodotCandidate,
  type GodotRunner,
  type GodotVersionInfo,
} from "../godot/cli.js";

export interface GodotCliServiceOptions {
  /** 环境变量来源(默认 process.env)。测试可注入。 */
  env?: NodeJS.ProcessEnv;
  /** 进程执行器(默认 promisified execFile)。测试可注入。 */
  runner?: GodotRunner;
}

export class GodotCliService {
  constructor(private readonly opts: GodotCliServiceOptions = {}) {}

  /** 本服务实际使用的环境变量(注入优先);错误细节必须与探测来源一致。 */
  get env(): NodeJS.ProcessEnv {
    return this.opts.env ?? process.env;
  }

  /** 定位 Godot 并执行一次 `--version`。失败抛 GodotMcpError(GODOT_NOT_FOUND / GODOT_PROCESS_FAILED)。 */
  getVersion(): Promise<GodotVersionInfo> {
    return getGodotVersion({ env: this.opts.env, runner: this.opts.runner });
  }

  /** 仅定位 Godot 可执行文件(不实际执行)。返回首个候选;找不到抛 GODOT_NOT_FOUND。 */
  locate(): GodotCandidate {
    const candidates = resolveCandidates({ env: this.opts.env });
    if (candidates.length === 0) {
      const env = this.opts.env ?? process.env;
      throw new GodotMcpError(
        "GODOT_NOT_FOUND",
        "No Godot executable found: GODOT_PATH is not set and no candidate was found on PATH",
        { godotPath: env["GODOT_PATH"] ?? null },
      );
    }
    return candidates[0]!;
  }
}
