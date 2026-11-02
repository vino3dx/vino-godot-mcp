import { LockManager } from "../core/concurrency/lockManager.js";
import { TaskQueue } from "../core/concurrency/taskQueue.js";
import { ProjectResolver } from "../core/project/projectResolver.js";
import type { Logger } from "../types/index.js";
import { FileService } from "./fileService.js";
import { GodotApiService } from "./godotApiService.js";
import { GodotCliService } from "./godotCli.js";
import { ProjectService } from "./projectService.js";
import { ResourceService } from "./resourceService.js";
import { SceneService } from "./sceneService.js";
import { ScriptService } from "./scriptService.js";
import { ShaderService } from "./shaderService.js";
import { StatusService } from "./statusService.js";
import { RuntimeService } from "./runtimeService.js";
import { AssetService } from "./assetService.js";
import { ProjectValidationService } from "./projectValidationService.js";
import { BatchFileService } from "./batchFileService.js";
import { InputMapService } from "./inputMapService.js";
import { RuntimeSessionManager } from "./runtimeSessionManager.js";
import { NativeBridgeService, defaultDescriptorPath } from "./nativeBridgeService.js";
import { NativeBridgeClient } from "../godot/bridge/client.js";
import { GdscriptProjectService } from "./gdscriptProjectService.js";

/** 应用上下文:传给每个 Tool handler。新增 Service 在这里挂载。 */
export interface AppContext {
  logger: Logger;
  locks: LockManager;
  runQueue: TaskQueue;
  status: StatusService;
  /** 项目根解析器(工具参数 projectPath > GODOT_PROJECT_PATH > 从 cwd 向上查找)。 */
  project: ProjectResolver;
  /** Godot CLI 探测(定位可执行文件 + 一次受控 --version)。 */
  godot: GodotCliService;
  /** ClassDB 类元数据(引擎 dump 的 extension_api.json,按引擎版本缓存;引擎不可用时明确报错)。 */
  godotApi: GodotApiService;
  /** 项目文件读写(tools 访问底层文件系统的唯一入口)。 */
  file: FileService;
  /** 场景树解析与无损修改。 */
  scene: SceneService;
  /** 资源依赖与子资源管理。 */
  resource: ResourceService;
  /** project.godot 配置读取与无损修改。 */
  projectConfig: ProjectService;
  /** .gdshader 读取与安全更新。 */
  shader: ShaderService;
  /** .gd 脚本读取与安全更新。 */
  script: ScriptService;
  /** Godot CLI 运行器:启动项目 / 运行场景 / 导出构建(受控进程 + 互斥队列)。 */
  runtime: RuntimeService;
  /** Persistent Godot sessions; intentionally independent from runQueue. */
  runtimeSessions: RuntimeSessionManager;
  nativeBridge: NativeBridgeService;
  gdscriptProject: GdscriptProjectService;
  assets: AssetService;
  validation: ProjectValidationService;
  batchFile: BatchFileService;
  inputMap: InputMapService;
}

export function createAppContext(logger: Logger, project: ProjectResolver = new ProjectResolver()): AppContext {
  const locks = new LockManager();
  const runQueue = new TaskQueue(locks);
  const godot = new GodotCliService();
  const file = new FileService(project);
  const scene = new SceneService();
  const script = new ScriptService();
  return {
    logger,
    locks,
    runQueue,
    status: new StatusService(locks),
    project,
    godot,
    godotApi: new GodotApiService({ godot, project, runQueue }),
    file,
    scene,
    resource: new ResourceService(),
    projectConfig: new ProjectService(),
    shader: new ShaderService(),
    script,
    runtime: new RuntimeService({ godot, project, runQueue }),
    runtimeSessions: new RuntimeSessionManager(),
    nativeBridge: new NativeBridgeService((root) => new NativeBridgeClient({ descriptorPath: defaultDescriptorPath(root) })),
    gdscriptProject: new GdscriptProjectService(file, script, scene),
    assets: new AssetService(project),
    validation: new ProjectValidationService({ godot, project, runQueue }),
    batchFile: new BatchFileService(new FileService(project), locks),
    inputMap: new InputMapService(new ProjectService()),
  };
}
