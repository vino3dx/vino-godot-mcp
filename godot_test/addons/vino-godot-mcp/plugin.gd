@tool
extends EditorPlugin

# Vino Godot MCP — Native Editor Bridge.
#
# 帧格式(与 src/godot/bridge/protocol.ts 严格一致):
#   [4 字节小端长度][UTF-8 JSON]
# 长度字节序由引擎决定:PackedByteArray.encode_u32/decode_u32 固定小端
# (Godot 4.6.3 实测:encode_u32(0, 65536) == [0,0,1,0])。
#
# 支持的方法:
#   project_capabilities      Bridge 与 Editor 能力/身份探测
#   editor_scene_info         当前编辑场景 + 打开的场景 + 当前选择
#   editor_scene_tree         当前编辑场景的节点树(深度/数量/内部节点可控)
#   editor_node_info          单个节点信息 + 属性列表/属性值
#   editor_control_layout     Control 布局(anchors/offsets/尺寸/容器语义)
#
# 所有 editor_* 结果都在 data 里带 context="editor"、projectId、instanceId、
# sessionId、scenePath、isValid,并明确标注数据来源。

const PROTOCOL_VERSION := 1
const DEFAULT_PORT := 49731
const MAX_MESSAGE_BYTES := 1048576

# 读取上限:大型场景不得无限制递归,也不能让单个响应超过帧上限把连接撑断。
const DEFAULT_MAX_DEPTH := 32
const HARD_MAX_DEPTH := 128
const DEFAULT_MAX_NODES := 1000
const HARD_MAX_NODES := 5000
const HARD_COUNT_NODES := 100000
const MAX_PROPERTY_VALUES := 400
const MAX_ARRAY_ITEMS := 64
const MAX_NESTING_DEPTH := 3
const MAX_STRING_CHARS := 4096

const SOURCE_EDITOR := "Godot Editor Plugin (EditorInterface.get_edited_scene_root)"
const DIRTY_REASON := "EditorInterface exposes no scene-dirty query in Godot 4.6; is_dirty is reported as null instead of guessed"

var server := TCPServer.new()
var peer: StreamPeerTCP
var input := PackedByteArray()
var token := ""
var session_id := ""
var instance_id := ""
var project_id := ""
var descriptor_path := ""
var port := DEFAULT_PORT
var dock: Control
var status_label: Label
var status_icon: Label
var details_label: Label
var language_select: OptionButton
var reconnect_button: Button
var language := "zh"
const MENU_STATUS := "Vino Godot MCP / Bridge Status"
const MENU_PROJECT_PATH := "Vino Godot MCP / Copy Project Path"
const MENU_DASHBOARD := "Vino Godot MCP / Open Dashboard"

func _enter_tree() -> void:
	_build_dashboard()
	add_control_to_dock(DOCK_SLOT_RIGHT_UL, dock)
	add_tool_menu_item(MENU_STATUS, Callable(self, "_menu_status"))
	add_tool_menu_item(MENU_PROJECT_PATH, Callable(self, "_menu_project_path"))
	add_tool_menu_item(MENU_DASHBOARD, Callable(self, "_toggle_dashboard"))
	port = int(ProjectSettings.get_setting("vino_godot_mcp/bridge_port", DEFAULT_PORT))
	token = _random_token()
	session_id = "%s-%s" % [Time.get_unix_time_from_system(), randi()]
	instance_id = session_id
	project_id = str(ProjectSettings.get_setting("application/config/name", "unknown"))
	var err := server.listen(port, "127.0.0.1")
	if err != OK:
		push_error("Vino Godot MCP Bridge failed to listen on 127.0.0.1:%d (%s)" % [port, error_string(err)])
		return
	descriptor_path = ProjectSettings.globalize_path("res://.vino-godot-mcp/bridge.json")
	DirAccess.make_dir_recursive_absolute(descriptor_path.get_base_dir())
	_write_descriptor()

func _exit_tree() -> void:
	remove_tool_menu_item(MENU_STATUS)
	remove_tool_menu_item(MENU_PROJECT_PATH)
	remove_tool_menu_item(MENU_DASHBOARD)
	if dock:
		remove_control_from_docks(dock)
		dock.queue_free()
		dock = null
	if peer:
		peer.disconnect_from_host()
		peer = null
	server.stop()
	if descriptor_path != "":
		DirAccess.remove_absolute(descriptor_path)

func _menu_status() -> void:
	var state := "running" if server.is_listening() else "stopped"
	if status_label:
		status_label.text = "Bridge: %s" % state.capitalize()
		_update_dashboard()

func _menu_project_path() -> void:
	DisplayServer.clipboard_set(ProjectSettings.globalize_path("res://"))

func _toggle_dashboard() -> void:
	if dock:
		dock.visible = not dock.visible

func _build_dashboard() -> void:
	dock = VBoxContainer.new()
	dock.name = "VinoGodotMCP"
	dock.custom_minimum_size = Vector2(320, 240)
	var title := Label.new()
	title.text = "Vino Godot MCP"
	title.add_theme_font_size_override("font_size", 18)
	dock.add_child(title)
	var language_row := HBoxContainer.new()
	dock.add_child(language_row)
	var language_caption := Label.new()
	language_caption.text = "语言 / Language"
	language_row.add_child(language_caption)
	language_select = OptionButton.new()
	language_select.add_item("简体中文")
	language_select.add_item("English")
	language_select.add_item("日本語")
	language_select.add_item("한국어")
	language_select.item_selected.connect(_on_language_selected)
	language_row.add_child(language_select)
	var status_row := HBoxContainer.new()
	dock.add_child(status_row)
	status_icon = Label.new()
	status_icon.add_theme_font_size_override("font_size", 22)
	status_row.add_child(status_icon)
	status_label = Label.new()
	status_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	status_row.add_child(status_label)
	reconnect_button = Button.new()
	reconnect_button.pressed.connect(_reconnect_bridge)
	status_row.add_child(reconnect_button)
	details_label = Label.new()
	details_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	dock.add_child(details_label)
	var tabs := TabContainer.new()
	tabs.size_flags_vertical = Control.SIZE_EXPAND_FILL
	dock.add_child(tabs)
	var service := RichTextLabel.new()
	service.bbcode_enabled = true
	service.text = "[b]MCP Service[/b]\nPackage: vino-godot-mcp\nStatus: use npx -y for zero-install startup\nInstall/check: npm i vino-godot-mcp\nConfig: npx -y vino-godot-mcp\n\nGODOT_PATH and GODOT_PROJECT_PATH must point to this Godot installation and project.\nThe service reads .vino-godot-mcp/bridge.json while the editor is open."
	tabs.add_child(service)
	tabs.set_tab_title(0, "MCP Service")
	var docs := RichTextLabel.new()
	docs.bbcode_enabled = true
	docs.text = "[b]Quick start[/b]\n1. Enable Vino Godot MCP.\n2. Keep the editor open.\n3. Set GODOT_PROJECT_PATH to this project.\n4. Call editor_get_scene / editor_get_tree from MCP."
	tabs.add_child(docs)
	tabs.set_tab_title(1, "Documentation")
	_update_dashboard()

func _on_language_selected(index: int) -> void:
	language = ["zh", "en", "ja", "ko"][index]
	_update_dashboard()

func _reconnect_bridge() -> void:
	if peer:
		peer.disconnect_from_host()
		peer = null
	if server.is_listening():
		server.stop()
	var err := server.listen(port, "127.0.0.1")
	if err != OK:
		push_error("Vino Godot MCP reconnect failed: %s" % error_string(err))
	_update_dashboard()

func _text(key: String) -> String:
	var translations := {
		"zh": {"working": "vino-godot-mcp 正在工作", "stopped": "vino-godot-mcp 未连接", "reconnect": "重新连接", "details": "Godot：%s\n项目：%s\n路径：%s\n地址：127.0.0.1\n端口：%d\n协议：%d\nSession：%s"},
		"en": {"working": "vino-godot-mcp is working", "stopped": "vino-godot-mcp disconnected", "reconnect": "Reconnect", "details": "Godot: %s\nProject: %s\nPath: %s\nHost: 127.0.0.1\nPort: %d\nProtocol: %d\nSession: %s"},
		"ja": {"working": "vino-godot-mcp は動作中です", "stopped": "vino-godot-mcp は未接続です", "reconnect": "再接続", "details": "Godot：%s\nプロジェクト：%s\nパス：%s\nホスト：127.0.0.1\nポート：%d\nプロトコル：%d\nセッション：%s"},
		"ko": {"working": "vino-godot-mcp 동작 중", "stopped": "vino-godot-mcp 연결 안 됨", "reconnect": "다시 연결", "details": "Godot: %s\n프로젝트: %s\n경로: %s\n호스트: 127.0.0.1\n포트: %d\n프로토콜: %d\n세션: %s"}
	}
	return translations.get(language, translations["zh"]).get(key, key)

func _update_dashboard() -> void:
	if not status_label or not details_label:
		return
	var working := server.is_listening()
	status_icon.text = "✓" if working else "✕"
	status_icon.add_theme_color_override("font_color", Color("65d681") if working else Color("ed6a6a"))
	status_label.text = _text("working" if working else "stopped")
	reconnect_button.text = _text("reconnect")
	details_label.text = _text("details") % [Engine.get_version_info().get("string", "unknown"), ProjectSettings.get_setting("application/config/name", "unknown"), ProjectSettings.globalize_path("res://"), port, PROTOCOL_VERSION, session_id]

func _process(_delta: float) -> void:
	if not server.is_connection_available():
		return
	peer = server.take_connection()
	peer.set_no_delay(true)
	input = PackedByteArray()

func _random_token() -> String:
	var bytes := PackedByteArray()
	for i in 32:
		bytes.append(randi() & 255)
	return bytes.hex_encode()

func _write_descriptor() -> void:
	var f := FileAccess.open(descriptor_path, FileAccess.WRITE)
	if f:
		f.store_string(JSON.stringify({
			"host": "127.0.0.1",
			"port": port,
			"token": token,
			"sessionId": session_id,
			"instanceId": instance_id,
			"projectId": project_id,
			"projectPath": ProjectSettings.globalize_path("res://"),
			"pid": OS.get_process_id(),
			"godotVersion": Engine.get_version_info().get("string", "unknown"),
			"protocolVersion": PROTOCOL_VERSION,
		}))
		f.close()

func _physics_process(_delta: float) -> void:
	if not peer:
		return
	if peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		# Editor 侧连接已断:释放 peer,下一次 _process 才能正常接受新连接。
		peer = null
		input = PackedByteArray()
		return
	var available := peer.get_available_bytes()
	if available > 0:
		input.append_array(peer.get_data(available)[1])
		_process_frames()

func _process_frames() -> void:
	while input.size() >= 4:
		var length := input.decode_u32(0)
		if length > MAX_MESSAGE_BYTES:
			# 帧头不可信(通常是字节序/协议不匹配):断开而不是死等。
			push_warning("Vino Godot MCP: incoming frame length %d exceeds limit, closing connection" % length)
			peer.disconnect_from_host()
			peer = null
			input = PackedByteArray()
			return
		if input.size() < length + 4:
			return
		var body := input.slice(4, length + 4).get_string_from_utf8()
		input = input.slice(length + 4)
		var parsed = null
		var json := JSON.new()
		if json.parse(body) == OK:
			parsed = json.data
		var response := _handle(parsed)
		_send(response)

func _send(response: Dictionary) -> void:
	if not peer:
		return
	var body := JSON.stringify(response, "", false, true).to_utf8_buffer()
	if body.size() > MAX_MESSAGE_BYTES:
		# 响应过大:换成结构化错误,避免超帧把连接撑断。
		var too_large := {"protocolVersion": PROTOCOL_VERSION, "requestId": str(response.get("requestId", "")), "success": false, "error": {"code": "EDITOR_RESPONSE_TOO_LARGE", "message": "Response exceeds %d bytes; narrow the request (maxDepth/maxNodes/propertyNames)" % MAX_MESSAGE_BYTES, "details": {"bytes": body.size()}}}
		body = JSON.stringify(too_large, "", false, true).to_utf8_buffer()
	var frame := PackedByteArray()
	frame.resize(4)
	frame.encode_u32(0, body.size())
	frame.append_array(body)
	peer.put_data(frame)

# ---------------------------------------------------------------- request routing

func _handle(request) -> Dictionary:
	var id := str(request.get("requestId", "")) if request is Dictionary else ""
	var base := {"protocolVersion": PROTOCOL_VERSION, "requestId": id, "success": false, "error": null}
	if not request is Dictionary:
		base.error = {"code": "INVALID_JSON", "message": "Request must be a JSON object"}
		return base
	if int(request.get("protocolVersion", 0)) != PROTOCOL_VERSION:
		base.error = {"code": "UNSUPPORTED_PROTOCOL", "message": "Unsupported bridge protocol version"}
		return base
	if str(request.get("token", "")) != token:
		base.error = {"code": "UNAUTHORIZED", "message": "Invalid bridge token"}
		return base
	var method := str(request.get("method", ""))
	var params = request.get("params", {})
	if not params is Dictionary:
		params = {}
	var result := _dispatch(method, params)
	if result.has("__error"):
		base.error = result["__error"]
		return base
	base.success = true
	base.data = result
	return base

func _dispatch(method: String, params: Dictionary) -> Dictionary:
	match method:
		"project_capabilities":
			return _capabilities()
		"editor_scene_info":
			return _editor_scene_info()
		"editor_scene_tree":
			return _editor_scene_tree(params)
		"editor_node_info":
			return _editor_node_info(params)
		"editor_control_layout":
			return _editor_control_layout(params)
	return _fail("METHOD_NOT_FOUND", "Unsupported bridge method: %s" % method, {"method": method})

func _fail(code: String, message: String, details := {}) -> Dictionary:
	return {"__error": {"code": code, "message": message, "details": details}}

# ---------------------------------------------------------------- identity / capabilities

func _identity() -> Dictionary:
	return {
		"context": "editor",
		"source": SOURCE_EDITOR,
		"projectId": project_id,
		"projectPath": ProjectSettings.globalize_path("res://"),
		"instanceId": instance_id,
		"sessionId": session_id,
		"editorPid": OS.get_process_id(),
		"godotVersion": Engine.get_version_info().get("string", "unknown"),
	}

func _capabilities() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	var data := _identity()
	data["protocolVersion"] = PROTOCOL_VERSION
	data["godotVersion"] = Engine.get_version_info().get("string", "unknown")
	data["godotInstanceId"] = instance_id
	data["bridgeSessionId"] = session_id
	data["editorConnected"] = true
	data["pluginRunning"] = true
	data["hasEditedScene"] = root != null
	data["isPlayingScene"] = EditorInterface.is_playing_scene()
	data["currentScene"] = {
		"path": root.scene_file_path if root else "",
		"rootName": str(root.name) if root else "",
		"rootClass": root.get_class() if root else "",
		"objectId": _id_or_null(root),
		"isDirty": null,
		"isDirtyReason": DIRTY_REASON,
	}
	data["unsavedStateApi"] = "unavailable"
	data["bridgeMethods"] = ["project_capabilities", "editor_scene_info", "editor_scene_tree", "editor_node_info", "editor_control_layout"]
	data["nativeCapabilities"] = {
		"editor_context": true,
		"editor_scene_inspect": true,
		"editor_tree_inspect": true,
		"editor_node_inspect": true,
		"editor_control_layout_inspect": true,
		"editor_selection_inspect": true,
		"editor_dirty_flag": false,
		"editor_scene_write": false,
		"editor_playback_control": false,
		"runtime_context": false,
		"disk_context": false,
		"signal_inspect": false,
		"group_inspect": true,
		"resource_write": false,
	}
	return data

# ---------------------------------------------------------------- scene info

func _editor_scene_info() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	var open_scenes := _open_scenes()
	var selection := _selection()
	var data := _identity()
	data["isDirty"] = null
	data["isDirtyReason"] = DIRTY_REASON
	data["openScenes"] = open_scenes
	data["selection"] = selection
	data["isPlayingScene"] = EditorInterface.is_playing_scene()
	if EditorInterface.is_playing_scene():
		data["playingScene"] = EditorInterface.get_playing_scene()
	if root == null:
		# 两种"没有场景"必须区分:完全没打开场景 vs 打开了但根节点不可用。
		data["isValid"] = false
		data["hasEditedScene"] = false
		data["scenePath"] = ""
		data["objectId"] = null
		if open_scenes.is_empty():
			return _fail("EDITOR_NO_SCENE_OPEN", "No scene is open in the Godot editor", data)
		return _fail("EDITOR_SCENE_ROOT_MISSING", "The editor reports open scene(s) but provides no edited scene root", data)
	if not is_instance_valid(root):
		data["isValid"] = false
		data["hasEditedScene"] = true
		data["scenePath"] = ""
		data["objectId"] = null
		return _fail("EDITOR_OBJECT_INVALID", "The edited scene root object is no longer valid", data)
	var scene_path := root.scene_file_path
	data["isValid"] = true
	data["hasEditedScene"] = true
	data["scenePath"] = scene_path
	data["objectId"] = _id(root)
	data["neverSaved"] = scene_path.is_empty()
	data["rootName"] = str(root.name)
	data["rootClass"] = root.get_class()
	data["rootClassScript"] = _script_global_name(root)
	data["rootScriptPath"] = _script_path(root)
	data["rootIsInsideTree"] = root.is_inside_tree()
	data["nodeCount"] = _count_nodes(root, false)
	data["nodeCountIncludingInternal"] = _count_nodes(root, true)
	var viewport_size = _viewport_size(root)
	if viewport_size != null:
		data["sceneViewportSize"] = viewport_size
		data["sceneViewportSizeSource"] = "Viewport.get_visible_rect() of the editor viewport hosting the edited scene"
	return data

func _open_scenes() -> Array:
	var out := []
	var paths := EditorInterface.get_open_scenes()
	var roots := EditorInterface.get_open_scene_roots()
	var edited := EditorInterface.get_edited_scene_root()
	for i in paths.size():
		var path := str(paths[i])
		var entry := {"path": path, "isCurrent": false}
		var node: Node = null
		if i < roots.size() and roots[i] != null and is_instance_valid(roots[i]):
			node = roots[i]
		if node != null:
			entry["rootName"] = str(node.name)
			entry["rootClass"] = node.get_class()
			entry["objectId"] = _id(node)
			entry["isCurrent"] = node == edited
		else:
			entry["rootName"] = ""
			entry["rootClass"] = ""
			entry["objectId"] = 0
			entry["rootPending"] = true
		out.append(entry)
	return out

func _selection() -> Dictionary:
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
		var root := EditorInterface.get_edited_scene_root()
		out["nodes"].append({
			"isValid": true,
			"name": str(node.name),
			"path": _rel_path(root, node),
			"type": node.get_class(),
			"objectId": _id(node),
			"scenePath": node.scene_file_path if node == root else _scene_of(root),
		})
	return out

func _scene_of(root: Node) -> String:
	if root == null:
		return ""
	return root.scene_file_path

# ---------------------------------------------------------------- tree

func _editor_scene_tree(params: Dictionary) -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	var data := _identity()
	data["isDirty"] = null
	data["isDirtyReason"] = DIRTY_REASON
	if root == null:
		data["isValid"] = false
		data["hasEditedScene"] = false
		data["scenePath"] = ""
		data["objectId"] = null
		if EditorInterface.get_open_scenes().is_empty():
			return _fail("EDITOR_NO_SCENE_OPEN", "No scene is open in the Godot editor", data)
		return _fail("EDITOR_SCENE_ROOT_MISSING", "The editor reports open scene(s) but provides no edited scene root", data)
	if not is_instance_valid(root):
		data["isValid"] = false
		data["scenePath"] = ""
		data["objectId"] = null
		return _fail("EDITOR_OBJECT_INVALID", "The edited scene root object is no longer valid", data)

	var node_path := str(params.get("nodePath", "")).strip_edges()
	var start := _resolve_node(root, node_path)
	data["scenePath"] = root.scene_file_path
	data["isValid"] = true
	data["hasEditedScene"] = true
	if start == null:
		data["objectId"] = null
		return _fail("EDITOR_NODE_NOT_FOUND", "No node matches path '%s' inside the edited scene '%s'" % [node_path, str(root.name)], data)
	data["objectId"] = _id(start)

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
		nodes.append(_describe_node(root, node, depth, include_groups))
		if depth >= max_depth:
			if node.get_child_count(include_internal) > 0:
				truncated_depth = true
			continue
		var children := node.get_children(include_internal)
		for i in range(children.size() - 1, -1, -1):
			stack.push_back({"node": children[i], "depth": depth + 1})

	data["rootPath"] = _rel_path(root, start)
	data["startPath"] = _rel_path(root, start)
	data["nodeCount"] = nodes.size()
	data["subtreeNodeCount"] = _count_nodes(start, include_internal)
	data["maxDepth"] = max_depth
	data["maxNodes"] = max_nodes
	data["includeInternal"] = include_internal
	data["truncated"] = truncated_nodes or truncated_depth
	data["truncatedBy"] = {"maxNodes": truncated_nodes, "maxDepth": truncated_depth}
	data["nodes"] = nodes
	return data

func _describe_node(root: Node, node: Node, depth: int, include_groups: bool) -> Dictionary:
	var entry := {
		"name": str(node.name),
		"path": _rel_path(root, node),
		"parentPath": _rel_path(root, node.get_parent()),
		"depth": depth,
		"type": node.get_class(),
		"className": _script_global_name(node),
		"scriptPath": _script_path(node),
		"ownerPath": _rel_path(root, node.owner),
		"uniqueNameInOwner": node.is_unique_name_in_owner(),
		"instanceId": _id(node),
		"instanceScenePath": node.scene_file_path,
		"isInstance": node.scene_file_path != "" and node != root,
		"childCount": node.get_child_count(),
		"isInsideTree": node.is_inside_tree(),
		"isValid": is_instance_valid(node),
		"context": "editor",
	}
	if include_groups:
		var groups := []
		for g in node.get_groups():
			groups.append(str(g))
		entry["groups"] = groups
	return entry

func _count_nodes(start: Node, include_internal: bool) -> int:
	var total := 0
	var stack := [start]
	while not stack.is_empty() and total < HARD_COUNT_NODES:
		var node: Node = stack.pop_back()
		total += 1
		for child in node.get_children(include_internal):
			stack.push_back(child)
	return total

# ---------------------------------------------------------------- node info

func _editor_node_info(params: Dictionary) -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	var data := _identity()
	data["isDirty"] = null
	data["isDirtyReason"] = DIRTY_REASON
	if root == null:
		data["isValid"] = false
		data["hasEditedScene"] = false
		data["scenePath"] = ""
		data["objectId"] = null
		if EditorInterface.get_open_scenes().is_empty():
			return _fail("EDITOR_NO_SCENE_OPEN", "No scene is open in the Godot editor", data)
		return _fail("EDITOR_SCENE_ROOT_MISSING", "The editor reports open scene(s) but provides no edited scene root", data)
	if not is_instance_valid(root):
		data["isValid"] = false
		data["scenePath"] = ""
		data["objectId"] = null
		return _fail("EDITOR_OBJECT_INVALID", "The edited scene root object is no longer valid", data)

	var node_path := str(params.get("nodePath", "")).strip_edges()
	var node := _resolve_node(root, node_path)
	data["scenePath"] = root.scene_file_path
	data["hasEditedScene"] = true
	if node == null:
		data["isValid"] = false
		data["objectId"] = null
		return _fail("EDITOR_NODE_NOT_FOUND", "No node matches path '%s' inside the edited scene '%s'" % [node_path, str(root.name)], data)

	var mode := str(params.get("properties", "values"))
	if not (mode in ["none", "list", "values"]):
		mode = "values"
	var filter_names := []
	var raw_filter = params.get("propertyNames", [])
	if raw_filter is Array:
		for n in raw_filter:
			filter_names.append(str(n))
	var limit := clampi(int(params.get("maxProperties", MAX_PROPERTY_VALUES)), 1, MAX_PROPERTY_VALUES)

	data["isValid"] = true
	data["objectId"] = _id(node)
	data["path"] = _rel_path(root, node)
	data["name"] = str(node.name)
	data["type"] = node.get_class()
	data["className"] = _script_global_name(node)
	data["scriptPath"] = _script_path(node)
	data["nodePathAbsolute"] = str(node.get_path()) if node.is_inside_tree() else ""
	data["parentPath"] = _rel_path(root, node.get_parent())
	data["ownerPath"] = _rel_path(root, node.owner)
	data["uniqueNameInOwner"] = node.is_unique_name_in_owner()
	data["instanceScenePath"] = node.scene_file_path
	data["isInstance"] = node.scene_file_path != "" and node != root
	data["isInsideTree"] = node.is_inside_tree()
	data["childCount"] = node.get_child_count()
	data["isControl"] = node is Control
	data["isContainer"] = node is Container
	var groups := []
	for g in node.get_groups():
		groups.append(str(g))
	data["groups"] = groups
	# mode="none" 只给节点身份,不枚举属性(省一次 get_property_list 与全部 getter)。
	var props := {"entries": [], "count": 0, "values": 0, "total": 0, "truncated": false}
	if mode != "none":
		props = _property_entries(node, mode, filter_names, limit)
	data["propertyMode"] = mode
	data["properties"] = props["entries"]
	data["propertyCount"] = props["count"]
	data["propertyValuesIncluded"] = props["values"]
	data["propertyCountBeforeFilter"] = props["total"]
	data["truncatedProperties"] = props["truncated"]
	return data

func _property_entries(node: Node, mode: String, filter_names: Array, limit: int) -> Dictionary:
	var entries := []
	var values := 0
	var total := 0
	var truncated := false
	var filter_active := filter_names.size() > 0
	for p in node.get_property_list():
		var usage := int(p.get("usage", 0))
		if usage & (PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP) != 0:
			continue
		var ptype := int(p.get("type", TYPE_NIL))
		if ptype == TYPE_NIL:
			continue
		var pname := str(p.get("name", ""))
		if filter_active and not filter_names.has(pname):
			continue
		total += 1
		if entries.size() >= limit:
			truncated = true
			continue
		var entry := {
			"name": pname,
			"type": type_string(ptype),
			"usage": usage,
			"hint": int(p.get("hint", 0)),
			"hintString": str(p.get("hint_string", "")),
		}
		if mode == "values":
			var read := _read_property(node, pname)
			entry["status"] = read["status"]
			entry["valueType"] = read["valueType"]
			entry["value"] = read["value"]
			if read.has("note"):
				entry["note"] = read["note"]
			values += 1
		entries.append(entry)
	return {"entries": entries, "count": entries.size(), "values": values, "total": total, "truncated": truncated}

func _read_property(node: Object, name: String) -> Dictionary:
	if not is_instance_valid(node):
		return {"status": "object_invalid", "valueType": "Unknown", "value": null}
	var value = node.get(name)
	var encoded := _encode_value(value, 0)
	encoded["status"] = "ok"
	return encoded

# ---------------------------------------------------------------- control layout

func _editor_control_layout(params: Dictionary) -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	var data := _identity()
	data["isDirty"] = null
	data["isDirtyReason"] = DIRTY_REASON
	if root == null:
		data["isValid"] = false
		data["hasEditedScene"] = false
		data["scenePath"] = ""
		data["objectId"] = null
		if EditorInterface.get_open_scenes().is_empty():
			return _fail("EDITOR_NO_SCENE_OPEN", "No scene is open in the Godot editor", data)
		return _fail("EDITOR_SCENE_ROOT_MISSING", "The editor reports open scene(s) but provides no edited scene root", data)
	if not is_instance_valid(root):
		data["isValid"] = false
		data["scenePath"] = ""
		data["objectId"] = null
		return _fail("EDITOR_OBJECT_INVALID", "The edited scene root object is no longer valid", data)

	var requested := []
	var raw_paths = params.get("nodePaths", [])
	if raw_paths is Array and raw_paths.size() > 0:
		for p in raw_paths:
			requested.append(str(p))
	else:
		requested.append(str(params.get("nodePath", "")))

	data["scenePath"] = root.scene_file_path
	data["hasEditedScene"] = true
	data["isValid"] = true
	var results := []
	var missing := []
	var not_control := []
	for path_text in requested:
		var node := _resolve_node(root, path_text)
		if node == null:
			missing.append({"path": path_text, "reason": "not_found"})
			continue
		if not node is Control:
			not_control.append({"path": _rel_path(root, node), "type": node.get_class(), "reason": "not_control"})
			continue
		results.append(_layout_of(root, node as Control))
	# 只有"一个都没解析到"才算节点不存在;解析到但不是 Control 的走 notControl[](不伪造布局)。
	if results.is_empty() and not_control.is_empty() and not missing.is_empty():
		data["objectId"] = null
		data["isValid"] = false
		return _fail("EDITOR_NODE_NOT_FOUND", "No Control node matches the requested path(s)", data)
	if results.size() == 1:
		data["objectId"] = results[0]["objectId"]
		data["path"] = results[0]["path"]
		data["layout"] = results[0]
		data["layouts"] = results
	else:
		data["objectId"] = null
		data["layouts"] = results
	data["requestedCount"] = requested.size()
	data["layoutCount"] = results.size()
	data["missing"] = missing
	data["notControl"] = not_control
	return data

func _layout_of(root: Node, control: Control) -> Dictionary:
	var parent := control.get_parent()
	var parent_is_container := parent is Container
	var layout := {
		"isValid": is_instance_valid(control),
		"context": "editor",
		"path": _rel_path(root, control),
		"name": str(control.name),
		"type": control.get_class(),
		"objectId": _id(control),
		"anchors": {
			"left": control.get_anchor(SIDE_LEFT),
			"top": control.get_anchor(SIDE_TOP),
			"right": control.get_anchor(SIDE_RIGHT),
			"bottom": control.get_anchor(SIDE_BOTTOM),
		},
		"offsets": {
			"left": control.offset_left,
			"top": control.offset_top,
			"right": control.offset_right,
			"bottom": control.offset_bottom,
		},
		"position": _vec2(control.position),
		"size": _vec2(control.size),
		"globalPosition": _vec2(control.global_position),
		"globalRect": _rect2(control.get_global_rect()),
		"localRect": _rect2(control.get_rect()),
		"pivotOffset": _vec2(control.pivot_offset),
		"rotation": control.rotation,
		"rotationDegrees": rad_to_deg(control.rotation),
		"scale": _vec2(control.scale),
		"customMinimumSize": _vec2(control.custom_minimum_size),
		"combinedMinimumSize": _vec2(control.get_combined_minimum_size()),
		"sizeFlagsHorizontal": _size_flags(control.size_flags_horizontal),
		"sizeFlagsVertical": _size_flags(control.size_flags_vertical),
		"layoutDirection": {"value": control.layout_direction, "name": _layout_direction_name(control.layout_direction)},
		"growHorizontal": {"value": control.grow_horizontal, "name": _grow_direction_name(control.grow_horizontal)},
		"growVertical": {"value": control.grow_vertical, "name": _grow_direction_name(control.grow_vertical)},
		"clipContents": control.clip_contents,
		"isLayoutRtl": control.is_layout_rtl(),
		"visible": control.visible,
		"visibleInTree": control.is_visible_in_tree(),
		"parent": {
			"path": _rel_path(root, parent),
			"type": parent.get_class() if parent else "",
			"isContainer": parent_is_container,
		},
		"containerManaged": parent_is_container,
		"hasLayoutModeProperty": _has_property(control, "layout_mode"),
		# 锚点基准:父 Control 的 rect(root Control 没有父 Control 时为 null,由 projectWindowSize 决定)。
		"parentRect": _rect2((parent as Control).get_global_rect()) if parent is Control else null,
		"projectWindowSize": _project_window_size(),
		"layoutBasis": "parent_control" if parent is Control else "project_window_size",
	}
	if _has_property(control, "layout_mode"):
		layout["layoutMode"] = int(control.get("layout_mode"))
	if control.is_inside_tree():
		# viewportSize 只说明"这个节点所在的 Editor viewport 多大",不是锚点基准,别当成布局依据。
		layout["viewportSize"] = _viewport_size(control)
		layout["screenPosition"] = _vec2(control.get_screen_position())
	layout["notes"] = _layout_notes(parent_is_container, parent is Control)
	return layout

func _project_window_size() -> Dictionary:
	return {
		"x": int(ProjectSettings.get_setting("display/window/size/viewport_width", 1152)),
		"y": int(ProjectSettings.get_setting("display/window/size/viewport_height", 648)),
	}

func _layout_notes(parent_is_container: bool, has_control_parent: bool) -> Array:
	var notes := [
		"Values are read from the live Editor scene instance (EditorInterface.get_edited_scene_root), not from the .tscn file, and include unsaved edits.",
		"position/size/globalRect are what the Editor itself computed for this instance; anchor basis is parentRect (parent Control) or projectWindowSize for a root Control.",
		"viewportSize is only the size of the Editor viewport hosting the scene; it is context, not the value that anchors resolve against.",
	]
	if parent_is_container:
		notes.append("Parent is a Container: the container assigns position/size at layout time, so anchors/offsets on this node are not authoritative.")
	if not has_control_parent:
		notes.append("This Control has no Control parent: the Editor lays it out against the project window size (projectWindowSize).")
	notes.append("Runtime geometry can differ when the runtime viewport size differs; these numbers are Editor-context only. Use runtime_inspect_ui for measured post-layout runtime rects.")
	return notes

func _size_flags(value: int) -> Dictionary:
	var names := []
	if value & Control.SIZE_FILL:
		names.append("SIZE_FILL")
	if value & Control.SIZE_EXPAND:
		names.append("SIZE_EXPAND")
	if value & Control.SIZE_SHRINK_CENTER:
		names.append("SIZE_SHRINK_CENTER")
	if value & Control.SIZE_SHRINK_END:
		names.append("SIZE_SHRINK_END")
	if value == Control.SIZE_SHRINK_BEGIN:
		names.append("SIZE_SHRINK_BEGIN")
	return {"value": value, "flags": names}

func _layout_direction_name(value: int) -> String:
	match value:
		Control.LAYOUT_DIRECTION_INHERITED: return "LAYOUT_DIRECTION_INHERITED"
		Control.LAYOUT_DIRECTION_APPLICATION_LOCALE: return "LAYOUT_DIRECTION_APPLICATION_LOCALE"
		Control.LAYOUT_DIRECTION_LTR: return "LAYOUT_DIRECTION_LTR"
		Control.LAYOUT_DIRECTION_RTL: return "LAYOUT_DIRECTION_RTL"
		Control.LAYOUT_DIRECTION_SYSTEM_LOCALE: return "LAYOUT_DIRECTION_SYSTEM_LOCALE"
	return "UNKNOWN(%d)" % value

func _grow_direction_name(value: int) -> String:
	match value:
		Control.GROW_DIRECTION_BEGIN: return "GROW_DIRECTION_BEGIN"
		Control.GROW_DIRECTION_END: return "GROW_DIRECTION_END"
		Control.GROW_DIRECTION_BOTH: return "GROW_DIRECTION_BOTH"
	return "UNKNOWN(%d)" % value

func _has_property(obj: Object, property_name: String) -> bool:
	for p in obj.get_property_list():
		if str(p.get("name", "")) == property_name:
			return true
	return false

# ---------------------------------------------------------------- helpers

func _resolve_node(root: Node, path_text: String) -> Node:
	var text := path_text.strip_edges()
	if text == "" or text == "." or text == root.name:
		return root
	if text.begins_with("/root/"):
		return root.get_node_or_null(NodePath(text))
	if text.begins_with(str(root.name) + "/"):
		text = text.substr(str(root.name).length() + 1)
	elif text.begins_with("/"):
		text = text.substr(1)
	if text == "":
		return root
	return root.get_node_or_null(NodePath(text))

func _rel_path(root: Node, node: Node) -> String:
	if node == null or not is_instance_valid(node):
		return ""
	if root == null or not is_instance_valid(root):
		return str(node.get_path()) if node.is_inside_tree() else ""
	if node == root:
		return "."
	if root.is_ancestor_of(node):
		return str(root.get_path_to(node))
	return str(node.get_path()) if node.is_inside_tree() else ""

func _script_path(node: Node) -> String:
	var script = node.get_script()
	if script is Script:
		return script.resource_path
	return ""

func _script_global_name(node: Node) -> String:
	var script = node.get_script()
	if script is Script:
		var global_name: String = script.get_global_name()
		return global_name
	return ""

func _vec2(v: Vector2) -> Dictionary:
	return {"x": v.x, "y": v.y}

# ObjectID 是 int64,超过 JS 安全整数范围(2^53-1)后 JSON 数字会被截断成错误的值。
# 所以对外一律给十进制字符串;它只在本 Bridge Session 内有效,不是永久 ID。
func _id(node) -> String:
	if node == null or not is_instance_valid(node):
		return ""
	return str(node.get_instance_id())

func _id_or_null(node):
	if node == null or not is_instance_valid(node):
		return null
	return str(node.get_instance_id())

# 布局数值是在 Editor 的 viewport 里算出来的,必须报告"哪个尺寸算出来的"。
# 注意 CanvasItem.get_viewport_rect() 在 2D 编辑器里给的是画布可见区(实测 2x2),
# 不能用;这里取 Viewport.get_visible_rect()(实测 1152x648,与 Control 尺寸自洽)。
func _viewport_size(node: Node):
	if node == null or not is_instance_valid(node) or not node.is_inside_tree():
		return null
	var vp := node.get_viewport()
	if vp == null:
		return null
	return _vec2(vp.get_visible_rect().size)

func _rect2(v: Rect2) -> Dictionary:
	return {"x": v.position.x, "y": v.position.y, "w": v.size.x, "h": v.size.y}

func _encode_value(value, depth: int) -> Dictionary:
	if value == null:
		return {"valueType": "Nil", "value": null}
	match typeof(value):
		TYPE_BOOL:
			return {"valueType": "bool", "value": value}
		TYPE_INT:
			return {"valueType": "int", "value": value}
		TYPE_FLOAT:
			return {"valueType": "float", "value": value}
		TYPE_STRING:
			return {"valueType": "String", "value": _clip_string(value)}
		TYPE_STRING_NAME:
			return {"valueType": "StringName", "value": _clip_string(str(value))}
		TYPE_NODE_PATH:
			return {"valueType": "NodePath", "value": str(value)}
		TYPE_VECTOR2:
			return {"valueType": "Vector2", "value": _vec2(value)}
		TYPE_VECTOR2I:
			return {"valueType": "Vector2i", "value": {"x": value.x, "y": value.y}}
		TYPE_VECTOR3:
			return {"valueType": "Vector3", "value": {"x": value.x, "y": value.y, "z": value.z}}
		TYPE_VECTOR3I:
			return {"valueType": "Vector3i", "value": {"x": value.x, "y": value.y, "z": value.z}}
		TYPE_VECTOR4:
			return {"valueType": "Vector4", "value": {"x": value.x, "y": value.y, "z": value.z, "w": value.w}}
		TYPE_VECTOR4I:
			return {"valueType": "Vector4i", "value": {"x": value.x, "y": value.y, "z": value.z, "w": value.w}}
		TYPE_RECT2:
			return {"valueType": "Rect2", "value": _rect2(value)}
		TYPE_RECT2I:
			return {"valueType": "Rect2i", "value": {"x": value.position.x, "y": value.position.y, "w": value.size.x, "h": value.size.y}}
		TYPE_COLOR:
			return {"valueType": "Color", "value": {"r": value.r, "g": value.g, "b": value.b, "a": value.a}}
		TYPE_TRANSFORM2D:
			return {"valueType": "Transform2D", "value": {"x": _vec2(value.x), "y": _vec2(value.y), "origin": _vec2(value.origin)}}
		TYPE_TRANSFORM3D:
			return {"valueType": "Transform3D", "value": {"origin": {"x": value.origin.x, "y": value.origin.y, "z": value.origin.z}}}
		TYPE_BASIS:
			return {"valueType": "Basis", "value": {"x": {"x": value.x.x, "y": value.x.y, "z": value.x.z}, "y": {"x": value.y.x, "y": value.y.y, "z": value.y.z}, "z": {"x": value.z.x, "y": value.z.y, "z": value.z.z}}}
		TYPE_QUATERNION:
			return {"valueType": "Quaternion", "value": {"x": value.x, "y": value.y, "z": value.z, "w": value.w}}
		TYPE_PLANE:
			return {"valueType": "Plane", "value": {"x": value.normal.x, "y": value.normal.y, "z": value.normal.z, "d": value.d}}
		TYPE_AABB:
			return {"valueType": "AABB", "value": {"position": {"x": value.position.x, "y": value.position.y, "z": value.position.z}, "size": {"x": value.size.x, "y": value.size.y, "z": value.size.z}}}
		TYPE_OBJECT:
			return _encode_object(value)
		TYPE_CALLABLE:
			return {"valueType": "Callable", "value": {"text": str(value)}, "note": "Callable is not serializable; descriptor only"}
		TYPE_SIGNAL:
			return {"valueType": "Signal", "value": {"text": str(value)}, "note": "Signal is not serializable; descriptor only"}
		TYPE_RID:
			return {"valueType": "RID", "value": {"text": str(value)}, "note": "RID is session-local; not a stable identifier"}
		TYPE_ARRAY:
			return _encode_array(value, depth)
		TYPE_DICTIONARY:
			return _encode_dictionary(value, depth)
	var vtype := typeof(value)
	# Packed* 数组编号连续(4.6.3 实测 29..37),用区间判断比逐个 match 分支稳。
	if vtype >= TYPE_PACKED_BYTE_ARRAY and vtype <= TYPE_PACKED_COLOR_ARRAY:
		return _encode_packed(value, depth)
	return {"valueType": type_string(vtype), "value": null, "note": "Unsupported value type; only the type name is reported"}

func _encode_object(value) -> Dictionary:
	if not is_instance_valid(value):
		return {"valueType": "Object", "value": {"invalid": true}, "note": "Object reference is no longer valid in this editor session"}
	var info := {"className": value.get_class(), "instanceId": _id(value)}
	if value is Node:
		info["kind"] = "Node"
		info["nodePath"] = str(value.get_path()) if value.is_inside_tree() else ""
		info["sceneFilePath"] = value.scene_file_path
	elif value is Resource:
		info["kind"] = "Resource"
		info["resourcePath"] = value.resource_path
		info["resourceName"] = str(value.resource_name)
	else:
		info["kind"] = "Object"
	# 不做深序列化:只给引用描述(按任务要求不为所有 Object 递归序列化)。
	return {"valueType": "Object", "value": info, "note": "Object/Resource reference descriptor only (no deep serialization)"}

func _encode_array(value: Array, depth: int) -> Dictionary:
	if depth >= MAX_NESTING_DEPTH:
		return {"valueType": "Array", "value": null, "note": "Nesting depth limit reached; contents omitted"}
	var out := []
	var limit := mini(value.size(), MAX_ARRAY_ITEMS)
	for i in limit:
		var item := _encode_value(value[i], depth + 1)
		out.append(item["value"])
	return {"valueType": "Array", "value": out, "truncated": value.size() > limit, "length": value.size()}

func _encode_dictionary(value: Dictionary, depth: int) -> Dictionary:
	if depth >= MAX_NESTING_DEPTH:
		return {"valueType": "Dictionary", "value": null, "note": "Nesting depth limit reached; contents omitted"}
	var out := {}
	var limit := mini(value.size(), MAX_ARRAY_ITEMS)
	var i := 0
	for k in value.keys():
		if i >= limit:
			break
		var item := _encode_value(value[k], depth + 1)
		out[str(k)] = item["value"]
		i += 1
	return {"valueType": "Dictionary", "value": out, "truncated": value.size() > limit, "length": value.size(), "note": "Dictionary keys are stringified"}

func _encode_packed(value, depth: int) -> Dictionary:
	var limit := mini(value.size(), MAX_ARRAY_ITEMS)
	var out := []
	for i in limit:
		var item := _encode_value(value[i], depth + 1)
		out.append(item["value"])
	return {"valueType": type_string(typeof(value)), "value": out, "truncated": value.size() > limit, "length": value.size()}

func _clip_string(text: String) -> String:
	if text.length() <= MAX_STRING_CHARS:
		return text
	return text.substr(0, MAX_STRING_CHARS) + "…(truncated)"
