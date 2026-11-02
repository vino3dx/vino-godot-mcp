// 唯一的工具清单。新增工具:在对应领域目录创建文件 → 在这里加一行。
import type { ToolDefinition } from "../types/index.js";
import type { AppContext } from "../services/context.js";
import { utilityPing } from "./utility/ping.js";
import { utilityTaskStatus } from "./utility/taskStatus.js";
import { runtimeGetVersion } from "./runtime/getVersion.js";
import { runtimeRunProject } from "./runtime/runProject.js";
import { runtimeRunScene } from "./runtime/runScene.js";
import { runtimeExportProject } from "./runtime/exportProject.js";
import { runtimeCaptureScreenshot } from "./runtime/captureScreenshot.js";
import { runtimeInspectUi } from "./runtime/inspectUi.js";
import { runtimeCheckAddonStatus } from "./runtime/checkAddonStatus.js";
import { runtimeVisualDebug } from "./runtime/visualDebug.js";
import { runtimeStartSession, runtimeGetSession, runtimeReadSessionLogs, runtimeStopSession } from "./runtime/sessionTools.js";
import { projectCapabilities } from "./project/capabilities.js";
import { editorGetScene } from "./editor/getScene.js";
import { editorGetTree } from "./editor/getTree.js";
import { editorGetNode } from "./editor/getNode.js";
import { editorGetLayout } from "./editor/getLayout.js";
import { sceneGetTree } from "./scene/getTree.js";
import { sceneGetNodeInfo } from "./scene/getNodeInfo.js";
import { sceneFindNodes } from "./scene/findNodes.js";
import { sceneAddVisualNode } from "./scene/addVisualNode.js";
import { sceneSetUiLayout } from "./scene/setUiLayout.js";
import { sceneGetConnections } from "./scene/getConnections.js";
import { sceneAnalyzeConnections } from "./scene/analyzeConnections.js";
import { sceneUpdateSignalConnection } from "./scene/updateSignalConnection.js";
import { assetList } from "./asset/list.js";
import { assetGetInfo } from "./asset/getInfo.js";
import { sceneUpdateNodeProperty } from "./scene/updateNodeProperty.js";
import { sceneRemoveNode } from "./scene/removeNode.js";
import { sceneAddNode } from "./scene/addNode.js";
import { sceneReparentNode } from "./scene/reparentNode.js";
import { sceneAddToGroup } from "./scene/addToGroup.js";
import { sceneRemoveFromGroup } from "./scene/removeFromGroup.js";
import { sceneInstantiateScene } from "./scene/instantiateScene.js";
import { sceneConnectSignal } from "./scene/connectSignal.js";
import { sceneDisconnectSignal } from "./scene/disconnectSignal.js";
import { resourceGetInfo } from "./resource/getInfo.js";
import { resourceUpdateProperty } from "./resource/updateProperty.js";
import { resourceAddOrUpdateExternal } from "./resource/addOrUpdateExternal.js";
import { projectGetConfig } from "./project/getConfig.js";
import { projectSetConfig } from "./project/setConfig.js";
import { projectValidate } from "./project/validate.js";
import { projectApplyChanges } from "./project/applyChanges.js";
import { projectInputGet } from "./project/inputGet.js";
import { projectInputUpdate } from "./project/inputUpdate.js";
import { shaderGetInfo } from "./shader/getInfo.js";
import { shaderUpdateUniformDefault } from "./shader/updateUniformDefault.js";
import { scriptGetInfo } from "./script/getInfo.js";
import { scriptUpdateExportDefault } from "./script/updateExportDefault.js";
import { scriptCreate } from "./script/create.js";
import { scriptAnalyze } from "./script/analyze.js";
import { scriptFindReferences } from "./script/findReferences.js";
import { scriptUpdateFunction } from "./script/updateFunction.js";
import { scriptProjectGraph } from "./script/projectGraph.js";
import { classGetInfo, classSearch, classValidateMember } from "./class/metadata.js";

export const allTools: ToolDefinition<AppContext>[] = [
  utilityPing,
  utilityTaskStatus,
  runtimeGetVersion,
  runtimeRunProject,
  runtimeRunScene,
  runtimeExportProject,
  runtimeCaptureScreenshot,
  runtimeInspectUi,
  runtimeCheckAddonStatus,
  runtimeVisualDebug,
  runtimeStartSession,
  runtimeGetSession,
  runtimeReadSessionLogs,
  runtimeStopSession,
  projectCapabilities,
  editorGetScene,
  editorGetTree,
  editorGetNode,
  editorGetLayout,
  sceneGetTree,
  sceneGetNodeInfo,
  sceneFindNodes,
  sceneAddVisualNode,
  sceneSetUiLayout,
  sceneGetConnections,
  sceneAnalyzeConnections,
  sceneUpdateSignalConnection,
  sceneUpdateNodeProperty,
  sceneRemoveNode,
  sceneAddNode,
  sceneReparentNode,
  sceneAddToGroup,
  sceneRemoveFromGroup,
  sceneInstantiateScene,
  sceneConnectSignal,
  sceneDisconnectSignal,
  resourceGetInfo,
  resourceUpdateProperty,
  resourceAddOrUpdateExternal,
  projectGetConfig,
  projectSetConfig,
  projectValidate,
  projectApplyChanges,
  projectInputGet,
  projectInputUpdate,
  shaderGetInfo,
  shaderUpdateUniformDefault,
  scriptGetInfo,
  scriptUpdateExportDefault,
  scriptCreate,
  scriptAnalyze,
  scriptFindReferences,
  scriptUpdateFunction,
  scriptProjectGraph,
  classGetInfo,
  classSearch,
  classValidateMember,
  assetList,
  assetGetInfo,
];
