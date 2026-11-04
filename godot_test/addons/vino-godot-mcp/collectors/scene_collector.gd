@tool
extends RefCounted

## 当前编辑场景采集（只读）。
##
## 数据来源：EditorInterface.get_edited_scene_root()，即编辑器内存里的场景实例，
## 包含尚未保存的修改；不是 .tscn 文本，也不是运行中的 SceneTree。

const NodeCollector := preload("node_collector.gd")

## Godot 4.6.3 的 EditorInterface/EditorNode 没有公开的"场景是否未保存"查询，
## 所以这里如实返回 null，不用 UndoRedo 之类的东西推测。
const DIRTY_REASON := "Godot 4.6.3 的 EditorInterface 未提供场景未保存状态查询接口"


static func collect_open_scene_paths() -> Array:
	var out: Array = []
	for path in EditorInterface.get_open_scenes():
		out.append(str(path))
	return out


## 场景级事实信息（UI 与 Bridge 共用同一套取值逻辑）。
## root 可以为 null（没有打开场景）。
static func collect_facts(root: Node) -> Dictionary:
	var open_paths := collect_open_scene_paths()
	var facts := {
		"hasScene": root != null and is_instance_valid(root),
		"openSceneCount": open_paths.size(),
		"openScenes": open_paths,
		"isDirty": null,
		"isDirtyReason": DIRTY_REASON,
		"isPlayingScene": EditorInterface.is_playing_scene(),
		"playingScene": "",
		"name": "",
		"path": "",
		"rootName": "",
		"rootClass": "",
		"rootScript": "",
		"rootClassScript": "",
		"nodeCount": 0,
		"nodeCountIncludingInternal": 0,
		"neverSaved": false,
		"isInstanceRoot": false,
		"rootSceneFilePath": "",
	}
	if EditorInterface.is_playing_scene():
		facts["playingScene"] = str(EditorInterface.get_playing_scene())
	if not facts["hasScene"]:
		return facts
	facts["path"] = str(root.scene_file_path)
	facts["neverSaved"] = str(root.scene_file_path).is_empty()
	facts["rootName"] = str(root.name)
	facts["rootClass"] = root.get_class()
	facts["rootScript"] = NodeCollector.script_path(root)
	facts["rootClassScript"] = NodeCollector.script_global_name(root)
	facts["name"] = str(root.name)
	facts["nodeCount"] = NodeCollector.count_nodes(root, false)
	facts["nodeCountIncludingInternal"] = NodeCollector.count_nodes(root, true)
	facts["rootSceneFilePath"] = str(root.scene_file_path)
	facts["isInstanceRoot"] = false
	return facts


## 场景里实例化了哪些子场景（PackedScene 实例），用于说明"场景包含实例化子场景"。
static func collect_instance_roots(root: Node, pairs: Array) -> Array:
	var out: Array = []
	if root == null or not is_instance_valid(root):
		return out
	for pair in pairs:
		var node: Node = pair["node"]
		if node == root:
			continue
		var scene_path := str(node.scene_file_path)
		if scene_path == "":
			continue
		# 只记录实例化根（父节点的实例路径与它不同），避免把实例内部的所有节点都列出来。
		var parent := node.get_parent()
		var parent_scene_path := str(parent.scene_file_path) if parent != null else ""
		if parent_scene_path == scene_path:
			continue
		out.append({
			"path": NodeCollector.rel_path(root, node),
			"name": str(node.name),
			"type": node.get_class(),
			"scenePath": scene_path,
		})
	return out
