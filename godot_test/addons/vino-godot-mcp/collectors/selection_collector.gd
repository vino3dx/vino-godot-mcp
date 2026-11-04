@tool
extends RefCounted

## 编辑器当前选择采集（只读）。
## EditorInterface.get_selection() 返回的是编辑器选择对象，不是运行时选中节点。

const NodeCollector := preload("node_collector.gd")


## Bridge 既有格式（editor_scene_info.selection）。字段与历史实现保持一致，
## 避免 MCP Server 侧出现回归。
static func collect_bridge(root: Node) -> Dictionary:
	var out := {"count": 0, "nodes": []}
	var selection := EditorInterface.get_selection()
	if selection == null:
		return out
	var nodes := selection.get_selected_nodes()
	out["count"] = nodes.size()
	for node in nodes:
		if node == null or not is_instance_valid(node):
			out["nodes"].append({"isValid": false})
			continue
		out["nodes"].append({
			"isValid": true,
			"name": str(node.name),
			"path": NodeCollector.rel_path(root, node),
			"type": node.get_class(),
			"objectId": NodeCollector.instance_id(node),
			"scenePath": node.scene_file_path if node == root else (root.scene_file_path if root != null else ""),
		})
	return out


## 上下文页面用的详细信息（多选、脚本、实例来源）。
static func collect_ui(root: Node) -> Dictionary:
	var out := {"count": 0, "nodes": [], "selection": null}
	var selection := EditorInterface.get_selection()
	if selection == null:
		return out
	var nodes := selection.get_selected_nodes()
	out["count"] = nodes.size()
	for node in nodes:
		if node == null or not is_instance_valid(node):
			out["nodes"].append({"isValid": false})
			continue
		var in_scene := root != null and root.is_ancestor_of(node)
		out["nodes"].append({
			"isValid": true,
			"name": str(node.name),
			"type": node.get_class(),
			"className": NodeCollector.script_global_name(node),
			"path": NodeCollector.rel_path(root, node),
			"pathAbsolute": str(node.get_path()) if node.is_inside_tree() else "",
			"inEditedScene": in_scene or node == root,
			"scenePath": str(node.scene_file_path) if str(node.scene_file_path) != "" else (root.scene_file_path if root != null else ""),
			"scriptPath": NodeCollector.script_path(node),
			"instanceScenePath": str(node.scene_file_path),
			"objectId": NodeCollector.instance_id(node),
		})
	return out
