@tool
extends RefCounted

## Editor Context 采集入口（只读）。
##
## 一次采集 = 一次场景树遍历 + 项目/场景/选择/信号/分组汇总，
## 供「上下文」页面使用。Bridge 复用同一批 collectors（见 plugin.gd），
## 因此 UI 与 MCP 拿到的字段含义一致，不会出现两套口径。
##
## 约束：
## - 只用 EditorInterface / ProjectSettings / Engine / Node API；
## - 不运行游戏、不读 .tscn 文本、不修改场景；
## - 输出里不放 Object 引用（ObjectID 一律转字符串）。

const ProjectCollector := preload("../collectors/project_collector.gd")
const SceneCollector := preload("../collectors/scene_collector.gd")
const NodeCollector := preload("../collectors/node_collector.gd")
const SelectionCollector := preload("../collectors/selection_collector.gd")
const SignalCollector := preload("../collectors/signal_collector.gd")
const GroupCollector := preload("../collectors/group_collector.gd")

## UI 侧上限：页面只需要可读的概览，不需要把上万个节点全塞给 Tree。
const UI_MAX_NODES := 800
const UI_MAX_DEPTH := 24


static func collect() -> Dictionary:
	var project := ProjectCollector.collect()
	var root = EditorInterface.get_edited_scene_root()
	var scene_facts := SceneCollector.collect_facts(root)
	var result := {
		"ok": true,
		"reason": "",
		"collectedAt": Time.get_time_string_from_system(),
		"project": project,
		"scene": scene_facts,
		"tree": {"entries": [], "truncated": false, "maxNodes": UI_MAX_NODES, "maxDepth": UI_MAX_DEPTH},
		"instances": [],
		"selection": SelectionCollector.collect_ui(root if scene_facts["hasScene"] else null),
		"signals": {
			"nodes": [], "nodeCount": 0, "declaredCustom": 0, "declaredBuiltin": 0,
			"connectionsPersistent": 0, "connectionsRuntime": 0, "truncated": false,
		},
		"groups": {
			"groups": [], "groupCount": 0, "memberLinks": 0, "nodesWithGroups": 0,
			"internalGroups": [], "internalGroupCount": 0,
		},
		"stats": {
			"nodeCount": 0, "nodeCountIncludingInternal": 0,
			"instanceCount": 0, "typeCounts": [], "typeCount": 0,
			"groupCount": 0, "customSignalCount": 0, "connectionCount": 0,
		},
	}

	if not bool(scene_facts["hasScene"]):
		result["ok"] = false
		result["reason"] = "no_open_scene" if int(scene_facts["openSceneCount"]) == 0 else "scene_root_missing"
		return result
	if not is_instance_valid(root):
		result["ok"] = false
		result["reason"] = "scene_root_invalid"
		return result

	var pairs := NodeCollector.walk_with_nodes(root, UI_MAX_NODES, UI_MAX_DEPTH, false)
	result["tree"] = {
		"entries": NodeCollector.serialize_pairs(pairs),
		"truncated": pairs.size() >= UI_MAX_NODES,
		"maxNodes": UI_MAX_NODES,
		"maxDepth": UI_MAX_DEPTH,
	}
	result["instances"] = SceneCollector.collect_instance_roots(root, pairs)
	result["signals"] = SignalCollector.collect(root, pairs)
	result["groups"] = GroupCollector.collect(root, pairs)
	result["stats"] = _stats(root, pairs, result)

	return result


static func _stats(root: Node, pairs: Array, result: Dictionary) -> Dictionary:
	var type_counts := {}
	for pair in pairs:
		var type_name := str(pair["entry"].get("type", ""))
		type_counts[type_name] = int(type_counts.get(type_name, 0)) + 1
	var type_list: Array = []
	for type_name in type_counts.keys():
		type_list.append({"type": str(type_name), "count": int(type_counts[type_name])})
	type_list.sort_custom(func(a, b) -> bool:
		if int(a["count"]) == int(b["count"]):
			return str(a["type"]) < str(b["type"])
		return int(a["count"]) > int(b["count"])
	)
	var signals: Dictionary = result["signals"]
	var groups: Dictionary = result["groups"]
	var scene: Dictionary = result["scene"]
	return {
		"nodeCount": int(scene["nodeCount"]),
		"nodeCountIncludingInternal": int(scene["nodeCountIncludingInternal"]),
		"traversedNodes": pairs.size(),
		"instanceCount": (result["instances"] as Array).size(),
		"typeCounts": type_list.slice(0, 12),
		"typeCount": type_list.size(),
		"groupCount": int(groups["groupCount"]),
		"customSignalCount": int(signals["declaredCustom"]),
		"builtinSignalCount": int(signals["declaredBuiltin"]),
		"connectionCount": int(signals["connectionsPersistent"]) + int(signals["connectionsRuntime"]),
		"persistentConnectionCount": int(signals["connectionsPersistent"]),
		"runtimeConnectionCount": int(signals["connectionsRuntime"]),
	}


## 轻量指纹：只比较"当前场景 + 选择 + 打开场景"，用于自动刷新判断，
## 不遍历节点树（避免每帧扫全场景）。
static func fingerprint() -> String:
	var root = EditorInterface.get_edited_scene_root()
	var parts := PackedStringArray()
	parts.append(str(OS.get_process_id()))
	if root != null and is_instance_valid(root):
		parts.append(str(root.get_instance_id()))
		parts.append(str(root.scene_file_path))
		parts.append(str(root.get_child_count()))
	else:
		parts.append("no-scene")
	var selection := EditorInterface.get_selection()
	if selection != null:
		var ids := PackedStringArray()
		for node in selection.get_selected_nodes():
			if node != null and is_instance_valid(node):
				ids.append(str(node.get_instance_id()))
		parts.append(",".join(ids))
	parts.append(str(EditorInterface.get_open_scenes().size()))
	parts.append("playing" if EditorInterface.is_playing_scene() else "stopped")
	return "|".join(parts)
