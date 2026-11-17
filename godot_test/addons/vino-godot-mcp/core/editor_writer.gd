@tool
extends RefCounted

## 编辑器原生写入器：所有来自 MCP 的场景修改都走 EditorUndoRedoManager。
##
## 为什么要走 UndoRedo（而不是直接 set/add_child）：
##   1. 开发者按 Ctrl+Z 必须能撤销 AI 的每一步 —— 只有进同一条历史才成立；
##   2. create_action(..., mark_unsaved 默认 true) 会让编辑器把场景标记为未保存，
##      和手工编辑的表现一致；
##   3. 每次操作都有名字（"MCP: set position on Player"），历史面板里可辨认。
##
## 实测契约（Godot 4.6.3）：
##   - EditorUndoRedoManager.add_do_method(object, method, ...args) 是 vararg；
##   - UndoRedo 的 do/undo 回调按**注册顺序**执行（不是逆序，已实测）；
##   - create_action(name, merge_mode, custom_context, backward_undo_ops, mark_unsaved)。
##
## 历史归属：get_history_undo_redo(get_object_history_id(root)) 就是编辑器给该场景
## 维护的那条历史，Ctrl+Z 用的也是它。

const NodeCollector := preload("../collectors/node_collector.gd")
const SelectionCollector := preload("../collectors/selection_collector.gd")
const ValueCodec := preload("value_codec.gd")

const MAX_UNDO_STEPS := 20

# ---------------------------------------------------------------- history

static func _manager() -> EditorUndoRedoManager:
	return EditorInterface.get_editor_undo_redo()


static func history_for(root: Node) -> UndoRedo:
	var manager := _manager()
	if manager == null or root == null or not is_instance_valid(root):
		return null
	return manager.get_history_undo_redo(manager.get_object_history_id(root))


static func history_state(root: Node) -> Dictionary:
	var scene_path := root.scene_file_path if root != null and is_instance_valid(root) else ""
	var out := {
		"available": false,
		"canUndo": false,
		"canRedo": false,
		"historyCount": 0,
		"currentAction": "",
		"scenePath": scene_path,
		"owner": "EditorUndoRedoManager history of the edited scene (same stack as Ctrl+Z)",
	}
	var history := history_for(root)
	if history == null:
		return out
	out["available"] = true
	out["canUndo"] = history.has_undo()
	out["canRedo"] = history.has_redo()
	out["historyCount"] = history.get_history_count()
	out["currentAction"] = history.get_current_action_name()
	return out

# ---------------------------------------------------------------- set property

static func set_property(root: Node, node: Node, property: String, spec) -> Dictionary:
	if node == null or not is_instance_valid(node):
		return fail("EDITOR_OBJECT_INVALID", "The target node is no longer valid in this editor session", {})
	var meta := property_meta(node, property)
	if not meta["found"]:
		return fail("EDITOR_PROPERTY_UNKNOWN", "Node '%s' (%s) has no property '%s'" % [str(node.name), node.get_class(), property], {
			"nodePath": NodeCollector.rel_path(root, node),
			"property": property,
			"hint": "call editor_get_node with properties=\"list\" to enumerate property names",
		})
	var decoded := ValueCodec.decode(spec, int(meta["type"]))
	if not decoded["ok"]:
		return fail("EDITOR_PROPERTY_INVALID", str(decoded["error"]), {
			"nodePath": NodeCollector.rel_path(root, node),
			"property": property,
			"propertyType": type_string(int(meta["type"])),
		})
	var before = node.get(property)
	var requested = decoded["value"]
	var rel := NodeCollector.rel_path(root, node)
	if before == requested:
		return {
			"changed": false,
			"nodePath": rel,
			"property": property,
			"before": ValueCodec.encode(before),
			"after": ValueCodec.encode(before),
			"undoable": false,
			"reason": "the property already holds this value; no undo action was created",
			"history": history_state(root),
		}
	var manager := _manager()
	if manager == null:
		return fail("EDITOR_WRITE_UNAVAILABLE", "EditorUndoRedoManager is unavailable in this editor session", {})
	var action_name := "MCP: set %s on %s" % [property, str(node.name)]
	manager.create_action(action_name)
	manager.add_do_property(node, property, requested)
	manager.add_undo_property(node, property, before)
	manager.commit_action()
	return {
		"changed": true,
		"nodePath": rel,
		"property": property,
		"propertyType": type_string(int(meta["type"])),
		"before": ValueCodec.encode(before),
		"after": ValueCodec.encode(node.get(property)),
		"requested": ValueCodec.encode(requested),
		"undoable": true,
		"actionName": action_name,
		"history": history_state(root),
	}

# ---------------------------------------------------------------- add node

static func add_node(root: Node, parent: Node, type_name: String, node_name: String, properties: Dictionary) -> Dictionary:
	if parent == null or not is_instance_valid(parent):
		return fail("EDITOR_OBJECT_INVALID", "The parent node is no longer valid in this editor session", {})
	if not ClassDB.class_exists(type_name):
		return fail("EDITOR_NODE_TYPE_UNKNOWN", "ClassDB has no class named '%s'" % type_name, {"type": type_name})
	if not ClassDB.can_instantiate(type_name):
		return fail("EDITOR_NODE_TYPE_UNKNOWN", "Class '%s' cannot be instantiated (abstract or singleton)" % type_name, {"type": type_name})
	var manager := _manager()
	if manager == null:
		return fail("EDITOR_WRITE_UNAVAILABLE", "EditorUndoRedoManager is unavailable in this editor session", {})
	var node = ClassDB.instantiate(type_name)
	if node == null or not node is Node:
		return fail("EDITOR_NODE_TYPE_UNKNOWN", "Failed to instantiate '%s'" % type_name, {"type": type_name})
	# 名字交给引擎净化（空格/非法字符），再按净化后的名字检查同级重名。
	node.name = node_name if node_name != "" else type_name
	var wanted := str(node.name)
	if parent.get_node_or_null(NodePath(wanted)) != null:
		node.free()
		return fail("EDITOR_NODE_EXISTS", "Parent '%s' already has a child named '%s'" % [str(parent.name), wanted], {
			"parentPath": NodeCollector.rel_path(root, parent),
			"name": wanted,
		})
	# 属性先全部解码通过才提交，避免半配置的节点进场景。
	var applied := {}
	var rejected := []
	for key in properties.keys():
		var property := str(key)
		var meta := property_meta(node, property)
		if not meta["found"]:
			rejected.append({"property": property, "reason": "unknown_property_for_%s" % node.get_class()})
			continue
		var decoded := ValueCodec.decode(properties[key], int(meta["type"]))
		if not decoded["ok"]:
			rejected.append({"property": property, "reason": str(decoded["error"])})
			continue
		node.set(property, decoded["value"])
		applied[property] = ValueCodec.encode(node.get(property))
	if rejected.size() > 0:
		node.free()
		return fail("EDITOR_PROPERTY_INVALID", "Some properties could not be applied; the node was NOT added", {"rejected": rejected})
	var action_name := "MCP: add %s (%s)" % [wanted, type_name]
	manager.create_action(action_name)
	manager.add_do_method(parent, "add_child", node, true)
	manager.add_do_method(node, "set_owner", root)
	manager.add_do_reference(node)
	manager.add_undo_method(parent, "remove_child", node)
	manager.commit_action()
	return {
		"added": true,
		"nodePath": NodeCollector.rel_path(root, node),
		"name": str(node.name),
		"requestedName": node_name,
		"renamedByEngine": wanted != node_name,
		"type": node.get_class(),
		"parentPath": NodeCollector.rel_path(root, parent),
		"ownerPath": NodeCollector.rel_path(root, node.owner),
		"properties": applied,
		"undoable": true,
		"actionName": action_name,
		"history": history_state(root),
	}

# ---------------------------------------------------------------- remove node

static func remove_node(root: Node, node: Node) -> Dictionary:
	if node == null or not is_instance_valid(node):
		return fail("EDITOR_OBJECT_INVALID", "The target node is no longer valid in this editor session", {})
	if node == root:
		return fail("EDITOR_CANNOT_REMOVE_ROOT", "The edited scene root cannot be removed", {"scenePath": root.scene_file_path})
	var parent := node.get_parent()
	if parent == null:
		return fail("EDITOR_OBJECT_INVALID", "The target node has no parent", {})
	var manager := _manager()
	if manager == null:
		return fail("EDITOR_WRITE_UNAVAILABLE", "EditorUndoRedoManager is unavailable in this editor session", {})
	var path := NodeCollector.rel_path(root, node)
	var index := node.get_index()
	var owner_path := NodeCollector.rel_path(root, node.owner)
	var action_name := "MCP: remove %s" % str(node.name)
	manager.create_action(action_name)
	manager.add_do_method(parent, "remove_child", node)
	# 实测 UndoRedo 按注册顺序执行 undo：先 add_child，再 move_child 复位同级顺序。
	# owner 在 remove_child 之后不会丢，所以 undo 不需要重设 owner。
	manager.add_undo_method(parent, "add_child", node)
	manager.add_undo_method(parent, "move_child", node, index)
	manager.add_undo_reference(node)
	manager.commit_action()
	return {
		"removed": true,
		"nodePath": path,
		"name": str(node.name),
		"type": node.get_class(),
		"parentPath": NodeCollector.rel_path(root, parent),
		"index": index,
		"ownerPath": owner_path,
		"undoable": true,
		"actionName": action_name,
		"history": history_state(root),
	}

# ---------------------------------------------------------------- selection

static func select_nodes(root: Node, nodes: Array) -> Dictionary:
	var selection := EditorInterface.get_selection()
	if selection == null:
		return fail("EDITOR_SELECTION_UNAVAILABLE", "EditorSelection is unavailable in this editor session", {})
	selection.clear()
	var selected := []
	for node in nodes:
		if node == null or not is_instance_valid(node):
			continue
		selection.add_node(node)
		selected.append({
			"path": NodeCollector.rel_path(root, node),
			"name": str(node.name),
			"type": node.get_class(),
			"objectId": NodeCollector.instance_id(node),
		})
	if nodes.size() > 0:
		EditorInterface.edit_node(nodes[nodes.size() - 1])
	return {
		"selected": true,
		"count": selected.size(),
		"nodes": selected,
		"selection": SelectionCollector.collect_bridge(root),
		"undoable": false,
		"note": "Editor selection is not part of the undo history; Godot does not record selection changes as undoable actions.",
	}

# ---------------------------------------------------------------- undo / redo

static func undo(root: Node, steps: int) -> Dictionary:
	return _step(root, clampi(steps, 1, MAX_UNDO_STEPS), true)


static func redo(root: Node, steps: int) -> Dictionary:
	return _step(root, clampi(steps, 1, MAX_UNDO_STEPS), false)


static func _step(root: Node, steps: int, backwards: bool) -> Dictionary:
	var history := history_for(root)
	if history == null:
		return fail("EDITOR_WRITE_UNAVAILABLE", "No undo history is available for the edited scene", {})
	var performed := 0
	var before := history_state(root)
	while performed < steps:
		if backwards and not history.has_undo():
			break
		if not backwards and not history.has_redo():
			break
		if backwards:
			history.undo()
		else:
			history.redo()
		performed += 1
	var operation := "undo" if backwards else "redo"
	if performed == 0:
		return fail("EDITOR_HISTORY_EMPTY", "Nothing to %s: this scene's undo history has no %s steps" % [operation, operation], {
			"operation": operation,
			"history": before,
		})
	return {
		"performed": performed,
		"operation": operation,
		"undoable": not backwards,
		"historyBefore": before,
		"history": history_state(root),
		"note": "Undo/redo ran on the same EditorUndoRedoManager history the editor uses for Ctrl+Z / Ctrl+Shift+Z.",
	}

# ---------------------------------------------------------------- helpers

static func property_meta(node: Object, property: String) -> Dictionary:
	for p in node.get_property_list():
		if str(p.get("name", "")) != property:
			continue
		return {
			"found": true,
			"type": int(p.get("type", TYPE_NIL)),
			"usage": int(p.get("usage", 0)),
			"hint": int(p.get("hint", 0)),
			"hintString": str(p.get("hint_string", "")),
		}
	return {"found": false, "type": TYPE_NIL, "usage": 0, "hint": 0, "hintString": ""}


static func fail(code: String, message: String, details := {}) -> Dictionary:
	return {"__error": {"code": code, "message": message, "details": details}}
