@tool
extends EditorPlugin

# Vino Godot MCP — Native Editor Bridge.
#
# 帧格式(与 src/godot/bridge/protocol.ts 严格一致):
#   [4 字节小端长度][UTF-8 JSON]
# 长度字节序由引擎决定:PackedByteArray.encode_u32/decode_u32 固定小端
# (Godot 4.6.3 实测:encode_u32(0, 65536) == [0,0,1,0])。
#
# 读取方法:
#   project_capabilities      Bridge 与 Editor 能力/身份探测
#   editor_scene_info         当前编辑场景 + 打开的场景 + 当前选择 + Inspector 焦点
#   editor_scene_tree         当前编辑场景的节点树(深度/数量/内部节点可控)
#   editor_node_info          单个节点信息 + 属性列表/属性值
#   editor_control_layout     Control 布局(anchors/offsets/尺寸/容器语义)
#   editor_events             事件回灌(环形缓冲,按 seq 补齐,断开期间不丢)
#
# 写入方法(全部走 EditorUndoRedoManager,与 Ctrl+Z 同一条历史):
#   editor_set_node_property  改单个属性
#   editor_add_node           新增节点(带初始属性)
#   editor_remove_node        删除节点
#   editor_select_node        改变编辑器选择/Inspector 焦点(不进 undo 历史)
#   editor_undo / editor_redo 在场景历史上撤销/重做
#
# 事件(Editor → MCP 的非请求帧,字段 {protocolVersion, sessionId, event}):
#   scene_changed / scene_closed / scene_saved / scene_tree_changed /
#   selection_changed / history_changed / log(Error+Warning,来自 OS.add_logger)
#
# 所有 editor_* 结果都在 data 里带 context="editor"、projectId、instanceId、
# sessionId、scenePath、isValid,并明确标注数据来源。

const PROTOCOL_VERSION := 1
const DEFAULT_PORT := 49731
const MAX_MESSAGE_BYTES := 1048576
## 场景指纹轮询间隔(秒):编辑器没有"场景内容变化"的信号,靠轮询兜住
## 不经过 undo 历史的改动(脚本驱动、外部重载等)。
const SCENE_POLL_INTERVAL := 0.4
const MAX_PUSH_TREE_NODES := 200

# 读取上限:大型场景不得无限制递归,也不能让单个响应超过帧上限把连接撑断。
const DEFAULT_MAX_DEPTH := 32
const HARD_MAX_DEPTH := 128
const DEFAULT_MAX_NODES := 1000
const HARD_MAX_NODES := 5000
const HARD_COUNT_NODES := 100000
const MAX_PROPERTY_VALUES := 400

const SOURCE_EDITOR := "Godot Editor Plugin (EditorInterface.get_edited_scene_root)"
const DIRTY_REASON := "EditorInterface exposes no scene-dirty query in Godot 4.6; is_dirty is reported as null instead of guessed"

# 上下文采集：Bridge 与「上下文」页面共用同一套 collectors，避免两套口径。
const ProjectCollector := preload("collectors/project_collector.gd")
const SceneCollector := preload("collectors/scene_collector.gd")
const NodeCollector := preload("collectors/node_collector.gd")
const SelectionCollector := preload("collectors/selection_collector.gd")

# 写入与事件：值编解码只保留一份实现，写入历史与读取输出共用。
const ValueCodec := preload("core/value_codec.gd")
const EventHub := preload("core/event_hub.gd")
const LogCapture := preload("core/log_capture.gd")
const EditorWriter := preload("core/editor_writer.gd")

const EVENT_TYPES := ["scene_changed", "scene_closed", "scene_saved", "scene_tree_changed", "selection_changed", "history_changed", "log"]

const SETTING_AUTO_CONNECT := "vino_godot_mcp/auto_connect"
const SETTING_LOG_LEVEL := "vino_godot_mcp/log_level"
const LOG_LEVELS := ["debug", "info", "warn"]

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
var tabs: TabContainer
var getting_started: Control
var context_panel: Control
var settings_panel: Control
var status_label: Label
var status_icon: Label
var reconnect_button: Button
var log_level := "info"
# 事件枢纽 / 日志订阅 / 场景指纹：Editor → MCP 的实时回灌通路。
var events := EventHub.new()
var log_capture: Logger
var _poll_accum := 0.0
var _scene_fingerprint := 0
var _event_bridge_installed := false
const MENU_STATUS := "Vino Godot MCP / Bridge Status"
const MENU_PROJECT_PATH := "Vino Godot MCP / Copy Project Path"
const MENU_DASHBOARD := "Vino Godot MCP / Open Dashboard"

func _enter_tree() -> void:
	_build_dashboard()
	add_control_to_dock(DOCK_SLOT_RIGHT_UL, dock)
	add_tool_menu_item(MENU_STATUS, Callable(self, "_menu_status"))
	add_tool_menu_item(MENU_PROJECT_PATH, Callable(self, "_menu_project_path"))
	add_tool_menu_item(MENU_DASHBOARD, Callable(self, "_toggle_dashboard"))
	log_level = str(ProjectSettings.get_setting(SETTING_LOG_LEVEL, "info"))
	port = int(ProjectSettings.get_setting("vino_godot_mcp/bridge_port", DEFAULT_PORT))
	token = _random_token()
	session_id = "%s-%s" % [Time.get_unix_time_from_system(), randi()]
	instance_id = session_id
	project_id = str(ProjectSettings.get_setting("application/config/name", "unknown"))
	descriptor_path = ProjectSettings.globalize_path("res://.vino-godot-mcp/bridge.json")
	_install_event_bridge()
	if is_auto_connect_enabled():
		start_bridge()
	else:
		_log("自动连接已关闭，Bridge 未监听", "info")
		_update_dashboard()

func _exit_tree() -> void:
	remove_tool_menu_item(MENU_STATUS)
	remove_tool_menu_item(MENU_PROJECT_PATH)
	remove_tool_menu_item(MENU_DASHBOARD)
	for panel in [getting_started, context_panel, settings_panel]:
		if panel != null and is_instance_valid(panel) and panel.has_method("shutdown"):
			panel.shutdown()
	getting_started = null
	context_panel = null
	settings_panel = null
	if dock:
		remove_control_from_docks(dock)
		dock.queue_free()
		dock = null
	tabs = null
	_remove_event_bridge()
	stop_bridge()

# ---------------------------------------------------------------- Bridge 生命周期 / 设置项

func is_auto_connect_enabled() -> bool:
	return bool(ProjectSettings.get_setting(SETTING_AUTO_CONNECT, true))

func start_bridge() -> bool:
	if server.is_listening():
		return true
	var configured := port
	var err := server.listen(port, "127.0.0.1")
	if err != OK:
		# 同一台机器多开编辑器是常态,固定端口必然被先启动的实例占住。
		# 退回到系统分配的临时端口:描述文件里的 port 才是权威,调用方从不假设固定端口。
		var fallback := TCPServer.new()
		var fallback_err := fallback.listen(0, "127.0.0.1")
		if fallback_err != OK:
			push_error("Vino Godot MCP Bridge 无法监听 127.0.0.1:%d（%s），临时端口也失败（%s）" % [configured, error_string(err), error_string(fallback_err)])
			_update_dashboard()
			return false
		server = fallback
		port = server.get_local_port()
		_log("端口 %d 已被占用,改用临时端口 %d" % [configured, port], "warn")
	DirAccess.make_dir_recursive_absolute(descriptor_path.get_base_dir())
	_write_descriptor()
	_log("Bridge 已监听 127.0.0.1:%d" % port, "info")
	_update_dashboard()
	return true

func stop_bridge() -> void:
	if peer:
		peer.disconnect_from_host()
		peer = null
	if server.is_listening():
		server.stop()
	if descriptor_path != "" and FileAccess.file_exists(descriptor_path):
		DirAccess.remove_absolute(descriptor_path)
	_update_dashboard()

func reconnect_bridge() -> void:
	stop_bridge()
	start_bridge()
	_log("Bridge 重新连接", "info")

func set_auto_connect(enabled: bool) -> void:
	ProjectSettings.set_setting(SETTING_AUTO_CONNECT, enabled)
	ProjectSettings.save()
	if enabled:
		start_bridge()
	else:
		stop_bridge()

func set_log_level(level: String) -> void:
	if not LOG_LEVELS.has(level):
		level = "info"
	log_level = level
	ProjectSettings.set_setting(SETTING_LOG_LEVEL, level)
	ProjectSettings.save()

func get_bridge_state() -> Dictionary:
	var exists := descriptor_path != "" and FileAccess.file_exists(descriptor_path)
	return {
		"listening": server.is_listening(),
		"host": "127.0.0.1",
		"port": port,
		"protocolVersion": PROTOCOL_VERSION,
		"sessionId": session_id,
		"descriptorPath": descriptor_path if exists else "",
		"descriptorExists": exists,
		"peerConnected": peer != null,
		"autoConnect": is_auto_connect_enabled(),
		"logLevel": log_level,
	}

func get_plugin_info() -> Dictionary:
	var info := {"name": "Vino Godot MCP", "version": "", "description": "", "id": "vino-godot-mcp"}
	var script = get_script()
	if script is Script:
		var cfg_path: String = str(script.resource_path).get_base_dir().path_join("plugin.cfg")
		var cfg := ConfigFile.new()
		if cfg.load(cfg_path) == OK:
			info["name"] = str(cfg.get_value("plugin", "name", info["name"]))
			info["version"] = str(cfg.get_value("plugin", "version", ""))
			info["description"] = str(cfg.get_value("plugin", "description", ""))
	return info

## 日志等级：debug < info < warn。只控制插件自身控制台输出，不影响 MCP Server。
func _log(message: String, level := "debug") -> void:
	var order := {"debug": 0, "info": 1, "warn": 2}
	if int(order.get(level, 0)) < int(order.get(log_level, 1)):
		return
	print("[Vino Godot MCP] ", message)

func _menu_status() -> void:
	if status_label:
		_update_dashboard()

func _menu_project_path() -> void:
	DisplayServer.clipboard_set(ProjectSettings.globalize_path("res://"))

func _toggle_dashboard() -> void:
	if dock:
		dock.visible = not dock.visible

func _build_dashboard() -> void:
	dock = VBoxContainer.new()
	dock.name = "VinoGodotMCP"
	# Dock 宽度交给 Godot 编辑器：不设最小宽度，否则窄面板会被强行撑开，挤压主编辑区。
	dock.custom_minimum_size = Vector2(0, 240)
	dock.add_theme_constant_override("separation", 6)

	# 标题行：图标 + 名称（紧凑，不放任何会撑宽的控件）。
	var header := HBoxContainer.new()
	header.add_theme_constant_override("separation", 6)
	dock.add_child(header)
	var header_icon := TextureRect.new()
	header_icon.texture = _dock_icon("Godot")
	header_icon.custom_minimum_size = Vector2(20, 20)
	header_icon.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	header_icon.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	header.add_child(header_icon)
	var title := Label.new()
	title.text = "Vino Godot MCP"
	title.add_theme_font_size_override("font_size", 17)
	var bold_font := _dock_font("bold")
	if bold_font != null:
		title.add_theme_font_override("font", bold_font)
	title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	title.custom_minimum_size = Vector2.ZERO
	header.add_child(title)

	# 状态 + 重连放在同一条 HFlowContainer 里：
	# 窄面板下自动折行，而不是把 Dock 撑到所有控件宽度之和。
	# 这里不给 Label 开自动换行——自动换行的 Label 会按"最小宽度"算最小高度，
	# 容器初始宽度很小时高度会异常膨胀，反而把 Dock 撑高。
	var status_row := HFlowContainer.new()
	status_row.add_theme_constant_override("h_separation", 6)
	status_row.add_theme_constant_override("v_separation", 4)
	dock.add_child(status_row)
	status_icon = Label.new()
	status_icon.add_theme_font_size_override("font_size", 20)
	status_row.add_child(status_icon)
	status_label = Label.new()
	status_label.custom_minimum_size = Vector2.ZERO
	status_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	status_row.add_child(status_label)
	reconnect_button = Button.new()
	reconnect_button.pressed.connect(_reconnect_bridge)
	status_row.add_child(reconnect_button)

	# 只保留三个 Tab：开始 / 上下文 / 设置。
	tabs = TabContainer.new()
	tabs.size_flags_vertical = Control.SIZE_EXPAND_FILL
	dock.add_child(tabs)

	getting_started = _create_page("getting_started.gd", "开始")
	if getting_started:
		tabs.add_child(getting_started)
		tabs.set_tab_title(tabs.get_tab_count() - 1, "开始")
		tabs.set_tab_icon(tabs.get_tab_count() - 1, _dock_icon("Play"))

	context_panel = _create_page("ui/context_panel.gd", "上下文")
	if context_panel:
		tabs.add_child(context_panel)
		tabs.set_tab_title(tabs.get_tab_count() - 1, "上下文")
		tabs.set_tab_icon(tabs.get_tab_count() - 1, _dock_icon("Node"))
		# dock 此时还没进入场景树，页面 _ready 尚未执行：延后注入插件引用。
		if context_panel.has_method("_attach"):
			context_panel.call_deferred("_attach", self)

	settings_panel = _create_page("ui/settings_panel.gd", "设置")
	if settings_panel:
		tabs.add_child(settings_panel)
		tabs.set_tab_title(tabs.get_tab_count() - 1, "设置")
		tabs.set_tab_icon(tabs.get_tab_count() - 1, _dock_icon("Tools"))
		if settings_panel.has_method("_attach"):
			settings_panel.call_deferred("_attach", self)

	tabs.current_tab = 0
	_update_dashboard()


## 复用编辑器主题图标/字体；拿不到就返回 null，由调用方降级为纯文本。
func _dock_icon(icon_name: String) -> Texture2D:
	if not Engine.is_editor_hint():
		return null
	var theme := EditorInterface.get_editor_theme()
	if theme != null and theme.has_icon(icon_name, "EditorIcons"):
		return theme.get_icon(icon_name, "EditorIcons")
	return null


func _dock_font(font_name: String) -> Font:
	if not Engine.is_editor_hint():
		return null
	var theme := EditorInterface.get_editor_theme()
	if theme != null and theme.has_font(font_name, "EditorFonts"):
		return theme.get_font(font_name, "EditorFonts")
	return null


## 页面脚本按插件实际安装路径加载，避免把 res://addons/vino-godot-mcp/ 写死。
func _create_page(relative_path: String, label: String) -> Control:
	var script = get_script()
	if not script is Script:
		push_warning("Vino Godot MCP: 无法解析插件脚本路径，跳过「%s」页面。" % label)
		return null
	var page_path: String = str(script.resource_path).get_base_dir().path_join(relative_path)
	if not ResourceLoader.exists(page_path):
		push_warning("Vino Godot MCP: 找不到 %s，跳过「%s」页面。" % [page_path, label])
		return null
	var page_script = load(page_path)
	if page_script == null:
		push_warning("Vino Godot MCP: %s 加载失败，跳过「%s」页面。" % [page_path, label])
		return null
	return page_script.new()

func _reconnect_bridge() -> void:
	reconnect_bridge()

func _update_dashboard() -> void:
	if not status_label or not status_icon:
		return
	var working := server.is_listening()
	status_icon.text = "✓" if working else "✕"
	status_icon.add_theme_color_override("font_color", Color("3fb950") if working else Color("e5534b"))
	status_label.text = "Bridge 正在监听" if working else "Bridge 未启动"
	reconnect_button.text = "重新连接"

func _process(delta: float) -> void:
	if server.is_connection_available():
		peer = server.take_connection()
		if peer:
			peer.set_no_delay(true)
		input = PackedByteArray()
	# 场景变更没有编辑器信号可用：轮询指纹兜住"不走 undo 历史"的改动。
	_poll_accum += delta
	if _poll_accum >= SCENE_POLL_INTERVAL:
		_poll_accum = 0.0
		_poll_scene(false)
	_flush_events()

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
		"editor_events":
			return _editor_events(params)
		"editor_set_node_property":
			return _editor_set_node_property(params)
		"editor_add_node":
			return _editor_add_node(params)
		"editor_remove_node":
			return _editor_remove_node(params)
		"editor_select_node":
			return _editor_select_node(params)
		"editor_undo":
			return _editor_history_step(params, true)
		"editor_redo":
			return _editor_history_step(params, false)
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
	data["bridgeMethods"] = ["project_capabilities", "editor_scene_info", "editor_scene_tree", "editor_node_info", "editor_control_layout", "editor_events", "editor_set_node_property", "editor_add_node", "editor_remove_node", "editor_select_node", "editor_undo", "editor_redo"]
	data["nativeCapabilities"] = {
		"editor_context": true,
		"editor_scene_inspect": true,
		"editor_tree_inspect": true,
		"editor_node_inspect": true,
		"editor_control_layout_inspect": true,
		"editor_selection_inspect": true,
		"editor_dirty_flag": false,
		"editor_scene_write": true,
		"editor_node_add": true,
		"editor_node_remove": true,
		"editor_selection_write": true,
		"editor_undo_redo": true,
		"editor_event_stream": true,
		"editor_log_capture": log_capture != null and log_capture.is_installed(),
		"editor_scene_save": false,
		"editor_playback_control": false,
		"runtime_context": false,
		"disk_context": false,
		"signal_inspect": false,
		"group_inspect": true,
		"resource_write": false,
	}
	data["writeChannel"] = {
		"undoOwner": "EditorUndoRedoManager (same history as Ctrl+Z)",
		"methods": ["editor_set_node_property", "editor_add_node", "editor_remove_node", "editor_select_node", "editor_undo", "editor_redo"],
		"savesFiles": false,
		"note": "Writes mutate the in-memory edited scene and are undoable; saving the .tscn stays an explicit editor action.",
	}
	data["eventTypes"] = EVENT_TYPES
	data["eventState"] = events.state()
	data["logCapture"] = log_capture.state() if log_capture != null else {"installed": false}
	data["history"] = EditorWriter.history_state(root)
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
	# 焦点 = 当前选中节点的路径 + Inspector 属性值(与 selection_changed 事件的 focus 同构)。
	data["focus"] = _selection_focus(root)
	data["history"] = EditorWriter.history_state(root)
	data["eventState"] = events.state()
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

## 与「上下文」页面共用（collectors/selection_collector.gd 的 Bridge 格式）。
func _selection() -> Dictionary:
	return SelectionCollector.collect_bridge(EditorInterface.get_edited_scene_root())

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

	# 与「上下文」页面共用同一套节点遍历实现（collectors/node_collector.gd）。
	var tree := NodeCollector.collect_tree(root, start, params)
	data["rootPath"] = NodeCollector.rel_path(root, start)
	data["startPath"] = NodeCollector.rel_path(root, start)
	data["nodeCount"] = int(tree["nodeCount"])
	data["subtreeNodeCount"] = int(tree["subtreeNodeCount"])
	data["maxDepth"] = int(tree["maxDepth"])
	data["maxNodes"] = int(tree["maxNodes"])
	data["includeInternal"] = bool(tree["includeInternal"])
	data["truncated"] = bool(tree["truncated"])
	data["truncatedBy"] = tree["truncatedBy"]
	data["nodes"] = tree["nodes"]
	return data

func _describe_node(root: Node, node: Node, depth: int, include_groups: bool) -> Dictionary:
	return NodeCollector.describe_node(root, node, depth, include_groups)

func _count_nodes(start: Node, include_internal: bool) -> int:
	return NodeCollector.count_nodes(start, include_internal)

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
	return NodeCollector.rel_path(root, node)

func _script_path(node: Node) -> String:
	return NodeCollector.script_path(node)

func _script_global_name(node: Node) -> String:
	return NodeCollector.script_global_name(node)

func _vec2(v: Vector2) -> Dictionary:
	return {"x": v.x, "y": v.y}

# ObjectID 是 int64,超过 JS 安全整数范围(2^53-1)后 JSON 数字会被截断成错误的值。
# 所以对外一律给十进制字符串;它只在本 Bridge Session 内有效,不是永久 ID。
func _id(node) -> String:
	return NodeCollector.instance_id(node)

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

# 值编码只有一份实现(core/value_codec.gd):写入回执与读取结果共用同一套类型描述,
# 避免"读出来是 Vector2、写进去变成字典"的错位。
func _encode_value(value, depth: int) -> Dictionary:
	return ValueCodec.encode(value, depth)

# ---------------------------------------------------------------- 事件回灌 (Editor → MCP)

## 事件源：选择 / 场景生命周期 / undo 历史 / 引擎日志 / 场景指纹轮询。
## 全部落到 EventHub 的环形缓冲，并在有 peer 时按帧推送。
func _install_event_bridge() -> void:
	if _event_bridge_installed:
		return
	_event_bridge_installed = true
	if log_capture == null:
		log_capture = LogCapture.new()
		log_capture.sink = Callable(self, "_on_engine_log")
		log_capture.install()
		_log("日志回灌: %s" % ("已订阅 OS.add_logger" if log_capture.is_installed() else "不可用"), "info")
	var selection := EditorInterface.get_selection()
	if selection != null and not selection.selection_changed.is_connected(_on_selection_changed):
		selection.selection_changed.connect(_on_selection_changed)
	var undo_redo := EditorInterface.get_editor_undo_redo()
	if undo_redo != null and not undo_redo.history_changed.is_connected(_on_history_changed):
		undo_redo.history_changed.connect(_on_history_changed)
	if not scene_changed.is_connected(_on_scene_changed):
		scene_changed.connect(_on_scene_changed)
	if not scene_closed.is_connected(_on_scene_closed):
		scene_closed.connect(_on_scene_closed)
	if not scene_saved.is_connected(_on_scene_saved):
		scene_saved.connect(_on_scene_saved)
	_poll_scene(true)


func _remove_event_bridge() -> void:
	_event_bridge_installed = false
	if log_capture != null:
		log_capture.uninstall()
		log_capture = null
	var selection := EditorInterface.get_selection()
	if selection != null and selection.selection_changed.is_connected(_on_selection_changed):
		selection.selection_changed.disconnect(_on_selection_changed)
	var undo_redo := EditorInterface.get_editor_undo_redo()
	if undo_redo != null and undo_redo.history_changed.is_connected(_on_history_changed):
		undo_redo.history_changed.disconnect(_on_history_changed)
	if scene_changed.is_connected(_on_scene_changed):
		scene_changed.disconnect(_on_scene_changed)
	if scene_closed.is_connected(_on_scene_closed):
		scene_closed.disconnect(_on_scene_closed)
	if scene_saved.is_connected(_on_scene_saved):
		scene_saved.disconnect(_on_scene_saved)


# 实测信号签名(4.6.3 ClassDB): scene_changed(scene_root: Object)、
# scene_closed(filepath: String)、scene_saved(filepath: String)、
# selection_changed()、history_changed()。参数写成默认值兜住小版本差异。
func _on_scene_changed(scene_root = null) -> void:
	if not _event_bridge_installed:
		return
	_scene_fingerprint = 0
	var root: Node = scene_root if scene_root != null and is_instance_valid(scene_root) else EditorInterface.get_edited_scene_root()
	_emit_event("scene_changed", {
		"rootName": str(root.name) if root != null else "",
		"rootClass": root.get_class() if root != null else "",
		"openScenes": EditorInterface.get_open_scenes(),
		"history": EditorWriter.history_state(root),
	})


func _on_scene_closed(path := "") -> void:
	if not _event_bridge_installed:
		return
	_scene_fingerprint = 0
	_poll_scene(true)
	_emit_event("scene_closed", {"closedPath": str(path), "openScenes": EditorInterface.get_open_scenes()})


func _on_scene_saved(path := "") -> void:
	if not _event_bridge_installed:
		return
	_emit_event("scene_saved", {
		"savedPath": str(path),
		"history": EditorWriter.history_state(EditorInterface.get_edited_scene_root()),
	})


func _on_selection_changed() -> void:
	if not _event_bridge_installed or not Engine.is_editor_hint():
		return
	var root := EditorInterface.get_edited_scene_root()
	var selection := SelectionCollector.collect_bridge(root)
	_emit_event("selection_changed", {
		"count": int(selection.get("count", 0)),
		"nodes": selection.get("nodes", []),
		"focus": _selection_focus(root),
	})


func _on_history_changed() -> void:
	if not _event_bridge_installed:
		return
	# 历史变了，场景内容可能也变了：让下一次轮询强制重算并推一份树快照。
	_scene_fingerprint = 0
	_emit_event("history_changed", EditorWriter.history_state(EditorInterface.get_edited_scene_root()))


func _on_engine_log(entry: Dictionary) -> void:
	_emit_event("log", entry)


func _emit_event(type: String, data: Dictionary) -> Dictionary:
	if events == null:
		events = EventHub.new()
	if not data.has("scenePath"):
		var root := EditorInterface.get_edited_scene_root()
		data["scenePath"] = root.scene_file_path if root != null and is_instance_valid(root) else ""
	return events.emit(type, data)


func _flush_events() -> void:
	var queue := events.take_queue()
	if peer == null or queue.is_empty():
		return
	for event in queue:
		_send_event(event)


func _send_event(event: Dictionary) -> void:
	if peer == null:
		return
	var body := JSON.stringify({
		"protocolVersion": PROTOCOL_VERSION,
		"sessionId": session_id,
		"event": event,
	}, "", false, true).to_utf8_buffer()
	if body.size() > MAX_MESSAGE_BYTES:
		# 单个事件过大就直接丢：事件是通知，权威数据仍可通过 editor_events/editor_* 取。
		return
	var frame := PackedByteArray()
	frame.resize(4)
	frame.encode_u32(0, body.size())
	frame.append_array(body)
	peer.put_data(frame)


## 场景内容指纹：编辑器没有"场景内容改变"的公共信号，用轮询兜住
## 不经过 undo 历史的改动（脚本驱动、外部重载等）。只在变化时推送树快照。
func _poll_scene(force: bool) -> void:
	var root := EditorInterface.get_edited_scene_root()
	if root == null or not is_instance_valid(root):
		if _scene_fingerprint != 0:
			_scene_fingerprint = 0
			_emit_event("scene_tree_changed", {"reason": "no_edited_scene", "nodeCount": 0, "nodes": [], "truncated": false})
		return
	var fingerprint := _scene_fingerprint_of(root)
	if not force and fingerprint == _scene_fingerprint:
		return
	_scene_fingerprint = fingerprint
	var tree := NodeCollector.collect_tree(root, root, {
		"maxNodes": MAX_PUSH_TREE_NODES,
		"maxDepth": DEFAULT_MAX_DEPTH,
		"includeGroups": false,
	})
	_emit_event("scene_tree_changed", {
		"reason": "content_changed",
		"rootName": str(root.name),
		"rootClass": root.get_class(),
		"nodeCount": int(tree["subtreeNodeCount"]),
		"nodes": tree["nodes"],
		"truncated": bool(tree["truncated"]),
		"truncatedBy": tree["truncatedBy"],
		"fingerprint": fingerprint,
		"source": "EditorInterface.get_edited_scene_root (in-memory, includes unsaved edits)",
	})


func _scene_fingerprint_of(root: Node) -> int:
	var parts := PackedStringArray()
	var count := 0
	var stack := [root]
	while not stack.is_empty() and count < 2000:
		var node: Node = stack.pop_back()
		count += 1
		var rel := "." if node == root else str(root.get_path_to(node))
		parts.append("%s|%s|%d" % [rel, node.get_class(), node.get_child_count()])
		for index in range(node.get_child_count() - 1, -1, -1):
			stack.push_back(node.get_child(index))
	return ("|".join(parts)).hash()


# ---------------------------------------------------------------- 焦点 / Inspector 属性

## 当前选中节点 + Inspector 属性值。selection_changed 事件与 editor_scene_info 共用。
func _selection_focus(root: Node) -> Dictionary:
	if root == null or not is_instance_valid(root) or not Engine.is_editor_hint():
		return {}
	var selection := EditorInterface.get_selection()
	if selection == null:
		return {}
	var selected := selection.get_selected_nodes()
	if selected.size() == 0:
		return {}
	var node = selected[selected.size() - 1]
	if node == null or not is_instance_valid(node):
		return {}
	var props := _property_entries(node, "values", [], 48)
	return {
		"path": _rel_path(root, node),
		"name": str(node.name),
		"type": node.get_class(),
		"objectId": _id(node),
		"propertyCount": int(props["total"]),
		"properties": props["entries"],
		"truncated": bool(props["truncated"]),
		"source": "EditorSelection.get_selected_nodes() + node.get_property_list() from the live editor scene",
	}

# ---------------------------------------------------------------- 写入方法 (UndoRedo)

func _editor_events(params: Dictionary) -> Dictionary:
	var since_seq := int(params.get("sinceSeq", 0))
	var limit := clampi(int(params.get("limit", 100)), 1, 200)
	var types := []
	var raw_types = params.get("types", [])
	if raw_types is Array:
		for t in raw_types:
			types.append(str(t))
	var data := _identity()
	var result := events.since(since_seq, limit, types)
	for key in result.keys():
		data[key] = result[key]
	data["state"] = events.state()
	data["logCapture"] = log_capture.state() if log_capture != null else {"installed": false}
	data["note"] = "Events are authoritative in the editor ring buffer; frames are also pushed while a bridge peer is connected. Deduplicate by seq."
	return data


func _editor_set_node_property(params: Dictionary) -> Dictionary:
	var guard := _require_edited_scene()
	if guard.has("__error"):
		return guard
	var root := EditorInterface.get_edited_scene_root()
	var data := _write_context(root)
	var node := _resolve_node(root, str(params.get("nodePath", "")).strip_edges())
	if node == null:
		data["objectId"] = null
		return _fail("EDITOR_NODE_NOT_FOUND", "No node matches path '%s' inside the edited scene" % str(params.get("nodePath", "")), data)
	data["objectId"] = _id(node)
	var property := str(params.get("property", "")).strip_edges()
	if property == "":
		return _fail("EDITOR_PROPERTY_UNKNOWN", "property must be a non-empty string", data)
	return _merge_result(data, EditorWriter.set_property(root, node, property, params.get("value")))


func _editor_add_node(params: Dictionary) -> Dictionary:
	var guard := _require_edited_scene()
	if guard.has("__error"):
		return guard
	var root := EditorInterface.get_edited_scene_root()
	var data := _write_context(root)
	var parent := _resolve_node(root, str(params.get("parentPath", "")).strip_edges())
	if parent == null:
		return _fail("EDITOR_NODE_NOT_FOUND", "No parent node matches path '%s' inside the edited scene" % str(params.get("parentPath", "")), data)
	var type_name := str(params.get("type", "")).strip_edges()
	if type_name == "":
		return _fail("EDITOR_NODE_TYPE_UNKNOWN", "type is required (a ClassDB class name, e.g. 'Sprite2D')", data)
	var properties = params.get("properties", {})
	if not properties is Dictionary:
		properties = {}
	var result := EditorWriter.add_node(root, parent, type_name, str(params.get("name", "")), properties)
	if not result.has("__error"):
		var created := root.get_node_or_null(NodePath(str(result.get("nodePath", ""))))
		data["objectId"] = _id_or_null(created)
	return _merge_result(data, result)


func _editor_remove_node(params: Dictionary) -> Dictionary:
	var guard := _require_edited_scene()
	if guard.has("__error"):
		return guard
	var root := EditorInterface.get_edited_scene_root()
	var data := _write_context(root)
	var node := _resolve_node(root, str(params.get("nodePath", "")).strip_edges())
	if node == null:
		data["objectId"] = null
		return _fail("EDITOR_NODE_NOT_FOUND", "No node matches path '%s' inside the edited scene" % str(params.get("nodePath", "")), data)
	data["objectId"] = _id(node)
	return _merge_result(data, EditorWriter.remove_node(root, node))


func _editor_select_node(params: Dictionary) -> Dictionary:
	var guard := _require_edited_scene()
	if guard.has("__error"):
		return guard
	var root := EditorInterface.get_edited_scene_root()
	var data := _write_context(root)
	var nodes := []
	var missing := []
	var raw_paths = params.get("nodePaths", [])
	if raw_paths is Array and raw_paths.size() > 0:
		for p in raw_paths:
			var node := _resolve_node(root, str(p))
			if node == null:
				missing.append(str(p))
			else:
				nodes.append(node)
	else:
		var single := str(params.get("nodePath", "")).strip_edges()
		var node := _resolve_node(root, single)
		if node == null:
			missing.append(single)
		else:
			nodes.append(node)
	if nodes.is_empty() and not missing.is_empty():
		return _fail("EDITOR_NODE_NOT_FOUND", "No node matches the requested path(s)", data)
	var result := EditorWriter.select_nodes(root, nodes)
	if not result.has("__error"):
		result["missing"] = missing
	if nodes.size() > 0:
		data["objectId"] = _id(nodes[nodes.size() - 1])
	return _merge_result(data, result)


func _editor_history_step(params: Dictionary, backwards: bool) -> Dictionary:
	var guard := _require_edited_scene()
	if guard.has("__error"):
		return guard
	var root := EditorInterface.get_edited_scene_root()
	var data := _write_context(root)
	var steps := int(params.get("steps", 1))
	var result := EditorWriter.undo(root, steps) if backwards else EditorWriter.redo(root, steps)
	return _merge_result(data, result)


## 写入类方法共用：场景存在性守卫。
func _require_edited_scene() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	var data := _identity()
	data["isDirty"] = null
	data["isDirtyReason"] = DIRTY_REASON
	if root == null:
		data["isValid"] = false
		data["hasEditedScene"] = false
		data["scenePath"] = ""
		if EditorInterface.get_open_scenes().is_empty():
			return _fail("EDITOR_NO_SCENE_OPEN", "No scene is open in the Godot editor", data)
		return _fail("EDITOR_SCENE_ROOT_MISSING", "The editor reports open scene(s) but provides no edited scene root", data)
	if not is_instance_valid(root):
		data["isValid"] = false
		data["hasEditedScene"] = true
		data["scenePath"] = ""
		return _fail("EDITOR_OBJECT_INVALID", "The edited scene root object is no longer valid", data)
	return {}


## 写入类方法共用的结果信封：成功时合并，失败时把上下文塞进 error.details。
func _write_context(root: Node) -> Dictionary:
	var data := _identity()
	data["isDirty"] = null
	data["isDirtyReason"] = DIRTY_REASON
	data["isValid"] = root != null and is_instance_valid(root)
	data["hasEditedScene"] = root != null
	data["scenePath"] = root.scene_file_path if root != null and is_instance_valid(root) else ""
	return data


func _merge_result(base: Dictionary, result: Dictionary) -> Dictionary:
	if result.has("__error"):
		var err: Dictionary = result["__error"]
		var details: Dictionary = err.get("details", {})
		for key in base.keys():
			if not details.has(key):
				details[key] = base[key]
		err["details"] = details
		return {"__error": err}
	var out := base.duplicate()
	for key in result.keys():
		out[key] = result[key]
	return out


