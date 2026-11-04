@tool
extends ScrollContainer

## 「设置」页面：Bridge 连接管理 + Godot/MCP 环境信息 + 插件信息。
##
## 只做"查看与开关"，不承担安装职责（Node.js / MCP 包的安装都在「开始」页面）。
## 所有数值都来自真实检测；取不到就显示"未检测"，不编造。

const UiKit := preload("ui_kit.gd")
const GsShell := preload("../gs_shell.gd")
const GsEnv := preload("../gs_env.gd")
const GsConfig := preload("../gs_config.gd")

const TOKEN_ENV := "settings_env"
const BRIDGE_STATUS_INTERVAL_MS := 1000

var _plugin: Node
var _runner: Node
var _next_status_ms := 0

# Bridge
var _bridge_status_icon: TextureRect
var _bridge_status_label: Label
var _bridge_values := {}
var _reconnect_btn: Button
var _auto_connect_check: CheckButton
var _log_level_select: OptionButton
var _bridge_action_label: Label

# Godot 环境
var _godot_values := {}
var _godot_action_label: Label
var _godot_exe_dialog: EditorFileDialog

# MCP 环境
var _mcp_values := {}
var _mcp_action_label: Label
var _env_progress_label: Label

# 插件信息
var _plugin_values := {}
var _plugin_action_label: Label


func _ready() -> void:
	horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	follow_focus = true
	_runner = GsShell.new()
	_runner.name = "SettingsJobs"
	_runner.job_finished.connect(_on_job_finished)
	add_child(_runner)
	_build_ui()
	_refresh_godot()
	_refresh_mcp()
	_refresh_bridge()
	_refresh_env_async()


func _attach(plugin: Node) -> void:
	_plugin = plugin
	# dock 尚未进入场景树时 _ready 还没跑过，界面控件可能不存在：等 _ready 自己刷新。
	if _bridge_status_icon == null:
		return
	_refresh_bridge()
	_refresh_plugin_info()


func _exit_tree() -> void:
	if _runner != null and _runner.has_method("shutdown"):
		_runner.shutdown()


## 插件退出时显式调用：等待后台线程结束，避免线程对象被提前释放。
func shutdown() -> void:
	if _runner != null and _runner.has_method("shutdown"):
		_runner.shutdown()


func _process(_delta: float) -> void:
	if not is_visible_in_tree():
		return
	var now := Time.get_ticks_msec()
	if now < _next_status_ms:
		return
	_next_status_ms = now + BRIDGE_STATUS_INTERVAL_MS
	_refresh_bridge()


# ---------------------------------------------------------------- UI 构建

func _build_ui() -> void:
	var root := VBoxContainer.new()
	root.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	root.add_theme_constant_override("separation", 8)
	add_child(root)

	var header := UiKit.label(root, "设置", Color.TRANSPARENT, 18)
	header.autowrap_mode = TextServer.AUTOWRAP_OFF
	UiKit.label(root, "Bridge 连接、Godot 与 MCP 环境的当前状态（信息只读）", UiKit.COLOR_MUTED, 12)

	_build_bridge_card(root)
	_build_godot_card(root)
	_build_mcp_card(root)
	_build_plugin_card(root)
	_build_dialogs()


func _build_bridge_card(root: VBoxContainer) -> void:
	var box := UiKit.card(root, "Bridge 设置", "Terminal")
	var status_row := UiKit.button_row(box)
	_bridge_status_icon = UiKit.status_icon(UiKit.COLOR_MUTED, "Info")
	status_row.add_child(_bridge_status_icon)
	_bridge_status_label = UiKit.label(status_row, "未启动", UiKit.COLOR_MUTED, 13)
	_bridge_status_label.custom_minimum_size = Vector2(110, 0)
	_reconnect_btn = UiKit.icon_button("重新连接", "Reload", "重新在 127.0.0.1 上监听 Bridge 端口")
	_reconnect_btn.pressed.connect(_on_reconnect_pressed)
	status_row.add_child(_reconnect_btn)

	for key in ["地址", "端口", "协议版本", "Session", "描述文件"]:
		_bridge_values[key] = UiKit.kv(box, key)

	var switches := UiKit.button_row(box)
	_auto_connect_check = CheckButton.new()
	_auto_connect_check.text = "自动连接"
	_auto_connect_check.tooltip_text = "插件启用时自动监听 Bridge 端口（保存到项目设置 vino_godot_mcp/auto_connect）"
	_auto_connect_check.toggled.connect(_on_auto_connect_toggled)
	switches.add_child(_auto_connect_check)
	var level_caption := UiKit.label(switches, "日志等级", UiKit.COLOR_MUTED, 12)
	level_caption.autowrap_mode = TextServer.AUTOWRAP_OFF
	_log_level_select = OptionButton.new()
	for level in ["debug", "info", "warn"]:
		_log_level_select.add_item(level)
	_log_level_select.item_selected.connect(_on_log_level_selected)
	switches.add_child(_log_level_select)
	_bridge_action_label = UiKit.label(box, "", UiKit.COLOR_MUTED, 11)


func _build_godot_card(root: VBoxContainer) -> void:
	var box := UiKit.card(root, "Godot 环境", "Godot")
	for key in ["Godot 版本", "编辑器可执行文件", "Console 可执行文件", "路径来源"]:
		_godot_values[key] = UiKit.kv(box, key)
	var actions := UiKit.button_row(box)
	var redetect := UiKit.icon_button("重新检测路径", "Reload", "重新读取当前编辑器进程的可执行文件路径")
	redetect.pressed.connect(_on_redetect_godot_pressed)
	actions.add_child(redetect)
	var pick := UiKit.icon_button("手动指定", "Folder", "手动选择一个 Godot 可执行文件（写入编辑器设置）")
	pick.pressed.connect(func() -> void: _godot_exe_dialog.popup_centered())
	actions.add_child(pick)
	_godot_action_label = UiKit.label(box, "", UiKit.COLOR_MUTED, 11)


func _build_mcp_card(root: VBoxContainer) -> void:
	var box := UiKit.card(root, "MCP 环境", "PluginScript")
	for key in ["Node.js", "npm", "MCP 包", "安装目录"]:
		_mcp_values[key] = UiKit.kv(box, key)
	var actions := UiKit.button_row(box)
	var redetect := UiKit.icon_button("重新检测", "Search", "重新执行 node --version / npm --version")
	redetect.pressed.connect(_refresh_env_async)
	actions.add_child(redetect)
	_env_progress_label = UiKit.label(actions, "", UiKit.COLOR_WARN, 12)
	_env_progress_label.autowrap_mode = TextServer.AUTOWRAP_OFF
	_mcp_action_label = UiKit.label(box, "", UiKit.COLOR_MUTED, 11)


func _build_plugin_card(root: VBoxContainer) -> void:
	var box := UiKit.card(root, "插件信息", "Info")
	for key in ["插件名称", "插件版本", "插件说明"]:
		_plugin_values[key] = UiKit.kv(box, key)
	var row := UiKit.button_row(box)
	var repo_btn := UiKit.icon_button("打开 GitHub 仓库", "ExternalLink", GsConfig.REPO_URL)
	repo_btn.pressed.connect(_on_open_repo_pressed)
	row.add_child(repo_btn)
	_plugin_action_label = UiKit.label(box, "", UiKit.COLOR_MUTED, 11)


func _build_dialogs() -> void:
	_godot_exe_dialog = EditorFileDialog.new()
	_godot_exe_dialog.title = "选择 Godot 可执行文件"
	_godot_exe_dialog.file_mode = EditorFileDialog.FILE_MODE_OPEN_FILE
	_godot_exe_dialog.access = EditorFileDialog.ACCESS_FILESYSTEM
	if GsConfig.platform_id() == "windows":
		_godot_exe_dialog.add_filter("*.exe", "Windows 可执行文件")
	_godot_exe_dialog.add_filter("*", "所有文件")
	_godot_exe_dialog.file_selected.connect(_on_godot_exe_selected)
	add_child(_godot_exe_dialog)


# ---------------------------------------------------------------- Bridge

func _refresh_bridge() -> void:
	var state := {}
	if _plugin != null and _plugin.has_method("get_bridge_state"):
		state = _plugin.get_bridge_state()
	var listening := bool(state.get("listening", false))
	var connected := bool(state.get("peerConnected", false))
	if listening:
		_bridge_status_icon.modulate = UiKit.COLOR_OK
		_bridge_status_icon.texture = UiKit.icon("StatusSuccess")
		_bridge_status_label.text = "监听中（客户端已连接）" if connected else "监听中"
		_bridge_status_label.add_theme_color_override("font_color", UiKit.COLOR_OK)
	else:
		_bridge_status_icon.modulate = UiKit.COLOR_ERROR
		_bridge_status_icon.texture = UiKit.icon("StatusError")
		_bridge_status_label.text = "未启动"
		_bridge_status_label.add_theme_color_override("font_color", UiKit.COLOR_ERROR)
	_set_value(_bridge_values, "地址", str(state.get("host", "127.0.0.1")))
	_set_value(_bridge_values, "端口", str(state.get("port", "—")))
	_set_value(_bridge_values, "协议版本", str(state.get("protocolVersion", "—")))
	_set_value(_bridge_values, "Session", str(state.get("sessionId", "—")))
	_set_value(_bridge_values, "描述文件", str(state.get("descriptorPath", "—")) if str(state.get("descriptorPath", "")) != "" else "（未生成）")
	_auto_connect_check.set_pressed_no_signal(bool(state.get("autoConnect", true)))
	var log_level := str(state.get("logLevel", "info"))
	var index := ["debug", "info", "warn"].find(log_level)
	_log_level_select.select(index if index >= 0 else 1)


func _on_reconnect_pressed() -> void:
	if _plugin != null and _plugin.has_method("reconnect_bridge"):
		_plugin.reconnect_bridge()
		_refresh_bridge()
		_bridge_action_label.text = "已重新尝试监听 %s" % str(_plugin.get_bridge_state().get("port", ""))


func _on_auto_connect_toggled(pressed: bool) -> void:
	if _plugin != null and _plugin.has_method("set_auto_connect"):
		_plugin.set_auto_connect(pressed)
		_refresh_bridge()
		_bridge_action_label.text = "自动连接已开启" if pressed else "自动连接已关闭（Bridge 已停止监听）"


func _on_log_level_selected(index: int) -> void:
	var level: String = ["debug", "info", "warn"][index]
	if _plugin != null and _plugin.has_method("set_log_level"):
		_plugin.set_log_level(level)
		_bridge_action_label.text = "日志等级已设置为 %s" % level


# ---------------------------------------------------------------- Godot 环境

func _refresh_godot() -> void:
	var settings = EditorInterface.get_editor_settings()
	var editor_path := OS.get_executable_path()
	var report: Dictionary = GsConfig.resolve_godot_executable(settings, editor_path)
	var version := str(Engine.get_version_info().get("string", "unknown"))
	_set_value(_godot_values, "Godot 版本", version)
	_set_value(_godot_values, "编辑器可执行文件", editor_path if editor_path != "" else "未检测")
	if bool(report.get("ok", false)):
		_set_value(_godot_values, "Console 可执行文件", str(report.get("console_path", "")))
		_set_value(_godot_values, "路径来源", str(report.get("note", "")))
		_godot_action_label.text = ""
	else:
		_set_value(_godot_values, "Console 可执行文件", "未检测")
		_set_value(_godot_values, "路径来源", "—")
		_godot_action_label.text = str(report.get("error", ""))


func _on_redetect_godot_pressed() -> void:
	_refresh_godot()


func _on_godot_exe_selected(path: String) -> void:
	if not FileAccess.file_exists(path):
		_godot_action_label.text = "所选文件不存在：%s" % path
		return
	var settings = EditorInterface.get_editor_settings()
	if settings == null:
		_godot_action_label.text = "无法访问编辑器设置（EditorSettings 不可用）"
		return
	settings.set_setting(GsConfig.SETTINGS_KEY_MANUAL_PATH, path)
	settings.save()
	_refresh_godot()
	_godot_action_label.text = "已保存手动路径：%s" % path


# ---------------------------------------------------------------- MCP 环境

func _refresh_mcp() -> void:
	var package := GsEnv.read_installed_package()
	if bool(package.get("found", false)):
		_set_value(_mcp_values, "MCP 包", "%s v%s" % [GsEnv.PACKAGE_NAME, str(package.get("version", "?"))])
	else:
		_set_value(_mcp_values, "MCP 包", "未安装" if str(package.get("error", "")) == "" else "未安装（%s）" % str(package.get("error", "")))
	_set_value(_mcp_values, "安装目录", GsEnv.install_dir())


func _refresh_env_async() -> void:
	if _runner == null or _runner.is_running(TOKEN_ENV):
		return
	_env_progress_label.text = "检测中…"
	_set_value(_mcp_values, "Node.js", "检测中…")
	_set_value(_mcp_values, "npm", "检测中…")
	_runner.start_job(TOKEN_ENV, func() -> Dictionary: return GsEnv.detect())


func _on_job_finished(token: String, result: Dictionary) -> void:
	if token != TOKEN_ENV:
		return
	_env_progress_label.text = ""
	var node: Dictionary = result.get("node", {})
	var npm: Dictionary = result.get("npm", {})
	if bool(node.get("found", false)):
		var source := "PATH" if bool(node.get("in_path", false)) else "常见安装目录"
		var node_path := str(node.get("path", ""))
		_set_value(_mcp_values, "Node.js", "v%s（%s）%s" % [
			str(node.get("version", "?")), source, ("\n" + node_path) if node_path != "" else ""
		])
	else:
		_set_value(_mcp_values, "Node.js", "未检测到（%s）" % str(node.get("error", "未知原因")))
	if bool(npm.get("found", false)):
		var npm_path := str(npm.get("path", ""))
		_set_value(_mcp_values, "npm", "%s%s" % [str(npm.get("version", "?")), ("（" + npm_path + "）") if npm_path != "" else ""])
	else:
		_set_value(_mcp_values, "npm", "未检测到（%s）" % str(npm.get("error", "未知原因")))
	if bool(result.get("below_minimum", false)):
		_mcp_action_label.text = "当前 Node.js 版本低于项目要求（Node.js %d+）" % int(result.get("minimum_major", GsEnv.NODE_MIN_MAJOR))
	_refresh_mcp()


# ---------------------------------------------------------------- 插件信息

func _refresh_plugin_info() -> void:
	var info := {}
	if _plugin != null and _plugin.has_method("get_plugin_info"):
		info = _plugin.get_plugin_info()
	_set_value(_plugin_values, "插件名称", str(info.get("name", "")))
	_set_value(_plugin_values, "插件版本", str(info.get("version", "")))
	_set_value(_plugin_values, "插件说明", str(info.get("description", "")))


func _on_open_repo_pressed() -> void:
	var err := OS.shell_open(GsConfig.REPO_URL)
	if err != OK:
		_plugin_action_label.text = "无法打开浏览器：%s" % error_string(err)
	else:
		_plugin_action_label.text = "已在浏览器中打开 %s" % GsConfig.REPO_URL


# ---------------------------------------------------------------- 小工具

func _set_value(target: Dictionary, key: String, value: String) -> void:
	if target.has(key) and target[key] != null:
		target[key].text = value if value != "" else "—"
