@tool
extends RefCounted

## 信号采集（只读）。
##
## 两件事必须分开：
##   1) 声明（Object.get_signal_list()）——包含内置信号与脚本自定义信号；
##   2) 连接（Object.get_signal_connection_list(name)）——声明不代表已连接。
##
## 内置信号数量很多（一个 CharacterBody2D 就有 20+ 个），UI 默认只列自定义信号和
## 有连接的信号，内置信号只计数，避免把页面刷成一大片无关内容。

const NodeCollector := preload("node_collector.gd")

const DEFAULT_MAX_SIGNAL_NODES := 300


## pairs: NodeCollector.walk_with_nodes() 的结果（含 node 引用与序列化条目）。
static func collect(root: Node, pairs: Array, max_nodes: int = DEFAULT_MAX_SIGNAL_NODES) -> Dictionary:
	var node_entries: Array = []
	var declared_custom := 0
	var declared_builtin := 0
	var persistent_connections := 0
	var runtime_connections := 0
	var skipped_editor_connections := 0
	var truncated := false
	for pair in pairs:
		if node_entries.size() >= max_nodes:
			truncated = true
			break
		var node: Node = pair["node"]
		if node == null or not is_instance_valid(node):
			continue
		var custom_names := _custom_signal_names(node)
		var node_signals: Array = []
		var builtin_count := 0
		for signal_info in node.get_signal_list():
			var signal_name := str(signal_info["name"])
			var is_custom := custom_names.has(signal_name)
			if is_custom:
				declared_custom += 1
			else:
				builtin_count += 1
				declared_builtin += 1
			var kept: Array = []
			for connection in _connections_of(root, node, signal_name):
				if bool(connection["persistent"]):
					persistent_connections += 1
					kept.append(connection)
					continue
				if bool(connection["targetOutsideScene"]):
					# 编辑器自己的内部连接（SceneTreeEditor / Inspector 等）不是场景信号接线，
					# 逐条列出来只会淹没真实数据：这里只计数。
					skipped_editor_connections += 1
					continue
				runtime_connections += 1
				kept.append(connection)
			# 只保留自定义信号与真正有连接的信号；内置且无连接的信号不逐条列出。
			if is_custom or not kept.is_empty():
				node_signals.append({
					"name": signal_name,
					"custom": is_custom,
					"args": _signal_args(signal_info),
					"connections": kept,
				})
		if not node_signals.is_empty():
			node_entries.append({
				"path": NodeCollector.rel_path(root, node),
				"name": str(node.name),
				"type": node.get_class(),
				"scriptPath": NodeCollector.script_path(node),
				"builtinSignalCount": builtin_count,
				"signals": node_signals,
			})
	return {
		"nodes": node_entries,
		"nodeCount": node_entries.size(),
		"declaredCustom": declared_custom,
		"declaredBuiltin": declared_builtin,
		"connectionsPersistent": persistent_connections,
		"connectionsRuntime": runtime_connections,
		"skippedEditorConnections": skipped_editor_connections,
		"truncated": truncated,
	}


## 脚本自定义信号名（不含引擎内置信号）。
static func _custom_signal_names(node: Node) -> Dictionary:
	var names := {}
	var script = node.get_script()
	if script is Script:
		for signal_info in script.get_script_signal_list():
			names[str(signal_info["name"])] = true
	return names


static func _signal_args(signal_info: Dictionary) -> Array:
	var args: Array = []
	for arg in signal_info.get("args", []):
		args.append({
			"name": str(arg.get("name", "")),
			"type": type_string(int(arg.get("type", TYPE_NIL))),
		})
	return args


static func _connections_of(root: Node, node: Node, signal_name: String) -> Array:
	var out: Array = []
	for connection in node.get_signal_connection_list(signal_name):
		var callable: Callable = connection.get("callable", Callable())
		var flags := int(connection.get("flags", 0))
		var target = callable.get_object() if callable.is_valid() else null
		var inside_scene := false
		var target_path := ""
		var target_class := ""
		if target != null and is_instance_valid(target):
			target_class = target.get_class() if target is Object else ""
			if target is Node:
				var target_node := target as Node
				inside_scene = root != null and (root.is_ancestor_of(target_node) or target_node == root)
				target_path = NodeCollector.rel_path(root, target_node) if inside_scene else (
					str(target_node.get_path()) if target_node.is_inside_tree() else ""
				)
		out.append({
			"signal": signal_name,
			"target": target_path,
			"targetClass": target_class,
			"targetOutsideScene": not inside_scene,
			"method": str(callable.get_method()) if callable.is_valid() else "",
			"persistent": (flags & Object.CONNECT_PERSIST) != 0,
			"valid": callable.is_valid(),
		})
	return out
