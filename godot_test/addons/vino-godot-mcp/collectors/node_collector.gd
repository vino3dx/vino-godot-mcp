@tool
extends RefCounted

## 节点树采集（只读）。
##
## Bridge 的 editor_scene_tree 与「上下文」页面共用这里的实现，避免两套遍历逻辑
## 产生不一致的数据结构。这里只读节点，不修改场景、不保存、不实例化任何东西。

const DEFAULT_MAX_DEPTH := 32
const HARD_MAX_DEPTH := 128
const DEFAULT_MAX_NODES := 1000
const HARD_MAX_NODES := 5000
const HARD_COUNT_NODES := 100000


## 相对编辑场景根节点的路径；不在场景内时退回引擎绝对路径。
static func rel_path(root: Node, node: Node) -> String:
	if node == null or not is_instance_valid(node):
		return ""
	if root == null or not is_instance_valid(root):
		return str(node.get_path()) if node.is_inside_tree() else ""
	if node == root:
		return "."
	if root.is_ancestor_of(node):
		return str(root.get_path_to(node))
	return str(node.get_path()) if node.is_inside_tree() else ""


static func script_path(node: Node) -> String:
	var script = node.get_script()
	if script is Script:
		return script.resource_path
	return ""


static func script_global_name(node: Node) -> String:
	var script = node.get_script()
	if script is Script:
		return script.get_global_name()
	return ""


## ObjectID 是 int64，直接进 JSON 会被 JS 截断，所以统一转十进制字符串。
static func instance_id(node) -> String:
	if node == null or not is_instance_valid(node):
		return ""
	return str(node.get_instance_id())


static func describe_node(root: Node, node: Node, depth: int, include_groups: bool) -> Dictionary:
	var entry := {
		"name": str(node.name),
		"path": rel_path(root, node),
		"parentPath": rel_path(root, node.get_parent()),
		"depth": depth,
		"type": node.get_class(),
		"className": script_global_name(node),
		"scriptPath": script_path(node),
		"ownerPath": rel_path(root, node.owner),
		"uniqueNameInOwner": node.is_unique_name_in_owner(),
		"instanceId": instance_id(node),
		"instanceScenePath": node.scene_file_path,
		"isInstance": node.scene_file_path != "" and node != root,
		"childCount": node.get_child_count(),
		"isInsideTree": node.is_inside_tree(),
		"isValid": is_instance_valid(node),
		"context": "editor",
	}
	if include_groups:
		var groups := []
		for group in node.get_groups():
			groups.append(str(group))
		entry["groups"] = groups
	return entry


static func count_nodes(start: Node, include_internal: bool) -> int:
	var total := 0
	var stack := [start]
	while not stack.is_empty() and total < HARD_COUNT_NODES:
		var node: Node = stack.pop_back()
		total += 1
		for child in node.get_children(include_internal):
			stack.push_back(child)
	return total


## Bridge 用的深度优先遍历（保持与既有 editor_scene_tree 相同的行为和字段）。
static func collect_tree(root: Node, start: Node, params: Dictionary) -> Dictionary:
	var max_depth := clampi(int(params.get("maxDepth", DEFAULT_MAX_DEPTH)), 0, HARD_MAX_DEPTH)
	var max_nodes := clampi(int(params.get("maxNodes", DEFAULT_MAX_NODES)), 1, HARD_MAX_NODES)
	var include_internal := bool(params.get("includeInternal", false))
	var include_groups := bool(params.get("includeGroups", true))

	var nodes := []
	var truncated_nodes := false
	var truncated_depth := false
	var stack := [{"node": start, "depth": 0}]
	while not stack.is_empty():
		var item: Dictionary = stack.pop_back()
		var node: Node = item["node"]
		var depth: int = item["depth"]
		if nodes.size() >= max_nodes:
			truncated_nodes = true
			break
		nodes.append(describe_node(root, node, depth, include_groups))
		if depth >= max_depth:
			if node.get_child_count(include_internal) > 0:
				truncated_depth = true
			continue
		var children := node.get_children(include_internal)
		for index in range(children.size() - 1, -1, -1):
			stack.push_back({"node": children[index], "depth": depth + 1})

	return {
		"nodes": nodes,
		"nodeCount": nodes.size(),
		"subtreeNodeCount": count_nodes(start, include_internal),
		"maxDepth": max_depth,
		"maxNodes": max_nodes,
		"includeInternal": include_internal,
		"truncated": truncated_nodes or truncated_depth,
		"truncatedBy": {"maxNodes": truncated_nodes, "maxDepth": truncated_depth},
	}


## UI 用：一次遍历拿到"节点对象 + 序列化条目"的配对，
## 后续信号/分组采集直接复用这批节点，避免同一个场景扫三遍。
static func walk_with_nodes(root: Node, max_nodes: int, max_depth: int, include_internal := false) -> Array:
	var out: Array = []
	var stack := [{"node": root, "depth": 0}]
	while not stack.is_empty():
		var item: Dictionary = stack.pop_back()
		var node: Node = item["node"]
		var depth: int = item["depth"]
		if out.size() >= max_nodes:
			break
		if node == null or not is_instance_valid(node):
			continue
		out.append({
			"node": node,
			"entry": describe_node(root, node, depth, false),
		})
		if depth >= max_depth:
			continue
		var children := node.get_children(include_internal)
		for index in range(children.size() - 1, -1, -1):
			stack.push_back({"node": children[index], "depth": depth + 1})
	return out


## 把配对里的节点引用剥离，只留可序列化字段（按深度优先顺序）。
static func serialize_pairs(pairs: Array) -> Array:
	var out: Array = []
	for pair in pairs:
		out.append(pair["entry"])
	return out
