@tool
extends ScrollContainer

## 「开始 / Getting Started」页面：帮助首次使用者按顺序完成 Node.js、MCP 包和 Agent 配置。
##
## 布局约束（Godot Dock 可能只有 240px 宽）：
## - 所有说明/状态/错误文本都自动换行，Label 不参与"按文本长度撑宽"。
## - 按钮行用 HFlowContainer，宽度不够时折行，而不是横向撑开 Dock。
## - JSON / npm 输出放在独立的代码块里，内部滚动，不改变整体宽度。
##
## 线程模型：UI 全部在主线程；外部命令/下载通过 gs_shell.gd 的 Thread 执行器跑，
## 结果回到主线程后再更新界面（工作线程不碰 UI）。

const GsShell := preload("gs_shell.gd")
const GsEnv := preload("gs_env.gd")
const GsConfig := preload("gs_config.gd")

const COLOR_OK := Color("3fb950")
const COLOR_WARN := Color("d9a038")
const COLOR_ERROR := Color("e5534b")
const COLOR_MUTED := Color("98a2b3")
const COLOR_ACCENT := Color("2f6fd0")

const TOKEN_ENV := "env_check"
const TOKEN_MCP_INSTALL := "mcp_install"
const TOKEN_NODE_PLAN := "node_plan"
const TOKEN_NODE_DOWNLOAD := "node_download"

const NODE_RECHECK_INTERVAL_MS := 5000
const NODE_RECHECK_WINDOW_MS := 180000

var _runner: Node
var _theme: Theme
var _last_width := -1.0

# --- 第 2 节状态
var _env_state := "unchecked"
var _env_report: Dictionary = {}
var _node_install_state := "idle"
var _node_progress_note := ""
var _node_recheck_until := 0
var _node_recheck_next := 0
var _pending_plan: Dictionary = {}

# --- 第 3 节状态
var _mcp_state := "unchecked"
var _mcp_report: Dictionary = {}
var _mcp_progress_note := ""

# --- 第 4 节状态
var _godot_report: Dictionary = {}
var _json_text := ""
var _json_error := ""
var _agent_dirs: Array = []
var _pending_save_path := ""

# --- 控件
var _repo_status: Label
var _node_state_label: Label
var _node_status_icon: TextureRect
var _node_detail_label: Label
var _node_error_label: Label
var _node_progress_label: Label
var _node_check_btn: Button
var _node_install_btn: Button
var _mcp_state_label: Label
var _mcp_status_icon: TextureRect
var _mcp_detail_label: Label
var _mcp_error_label: Label
var _mcp_progress_label: Label
var _mcp_output: TextEdit
var _mcp_output_panel: Control
var _mcp_check_btn: Button
var _mcp_install_btn: Button
var _mcp_open_dir_btn: Button
var _godot_state_label: Label
var _godot_status_icon: TextureRect
var _godot_detail_label: Label
var _godot_error_label: Label
var _json_edit: TextEdit
var _agent_status_label: Label
var _agent_dir_select: OptionButton
var _agent_dir_open_btn: Button
var _agent_dir_path_label: Label
var _clear_manual_btn: Button
var _mascot: TextureRect
var _ready_bar: PanelContainer
var _ready_icon: TextureRect
var _ready_label: Label

# --- 对话框
var _confirm_install_dialog: ConfirmationDialog
var _info_dialog: AcceptDialog
var _overwrite_dialog: ConfirmationDialog
var _save_dialog: EditorFileDialog
var _godot_exe_dialog: EditorFileDialog


func _ready() -> void:
	horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	follow_focus = true
	_theme = EditorInterface.get_editor_theme()
	_runner = GsShell.new()
	_runner.name = "BackgroundJobs"
	_runner.job_finished.connect(_on_job_finished)
	add_child(_runner)
	_build_ui()
	_refresh_installed_package()
	_detect_godot_path()
	_detect_agent_dirs()
	_update_env_ui()
	_update_mcp_ui()
	_update_godot_ui()
	_update_ready_bar()
	_apply_compact_layout()


## 窄面板下隐藏装饰插图，把宽度让给正文；宽面板再显示回来。
## 阈值按"页面可用宽度"判断：Dock 320px 时页面实际约 296px，Dock 240px 时约 216px。
func _apply_compact_layout() -> void:
	if _mascot != null:
		_mascot.visible = size.x >= 280


## 插件退出时调用：等待后台线程结束，避免线程对象被提前释放。
func shutdown() -> void:
	if _runner != null and _runner.has_method("shutdown"):
		_runner.shutdown()


# ---------------------------------------------------------------- 主题 / 样式工具

func _icon(icon_name: String) -> Texture2D:
	if _theme != null and _theme.has_icon(icon_name, "EditorIcons"):
		return _theme.get_icon(icon_name, "EditorIcons")
	return null


func _mono_font() -> Font:
	if _theme != null and _theme.has_font("source", "EditorFonts"):
		return _theme.get_font("source", "EditorFonts")
	return null


## 卡片底色用半透明中性色，浅色/深色编辑器主题下都能正常显示。
func _card_style() -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.55, 0.62, 0.72, 0.10)
	style.set_corner_radius_all(8)
	style.set_border_width_all(1)
	style.border_color = Color(0.60, 0.67, 0.78, 0.20)
	style.content_margin_left = 10
	style.content_margin_right = 10
	style.content_margin_top = 10
	style.content_margin_bottom = 10
	return style


func _code_style() -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.0, 0.0, 0.0, 0.22)
	style.set_corner_radius_all(6)
	style.content_margin_left = 8
	style.content_margin_right = 8
	style.content_margin_top = 6
	style.content_margin_bottom = 6
	return style


func _ready_style(ready: bool) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	if ready:
		style.bg_color = Color(0.25, 0.68, 0.35, 0.18)
		style.border_color = COLOR_OK
	else:
		style.bg_color = Color(0.55, 0.62, 0.72, 0.10)
		style.border_color = Color(0.60, 0.67, 0.78, 0.20)
	style.set_corner_radius_all(8)
	style.set_border_width_all(1)
	style.content_margin_left = 10
	style.content_margin_right = 10
	style.content_margin_top = 8
	style.content_margin_bottom = 8
	return style


# ---------------------------------------------------------------- UI 构建

func _build_ui() -> void:
	var root := VBoxContainer.new()
	root.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	root.add_theme_constant_override("separation", 8)
	add_child(root)

	var header := Label.new()
	header.text = "开始 / Getting Started"
	header.add_theme_font_size_override("font_size", 18)
	header.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	header.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	header.custom_minimum_size = Vector2.ZERO
	root.add_child(header)

	_build_repo_card(root)
	_build_node_card(root)
	_build_mcp_card(root)
	_build_agent_card(root)
	_build_ready_bar(root)
	_build_dialogs()


func _make_card(parent: Control, number: int, title: String) -> VBoxContainer:
	var panel := PanelContainer.new()
	panel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	panel.add_theme_stylebox_override("panel", _card_style())
	parent.add_child(panel)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 6)
	panel.add_child(box)
	var head := HBoxContainer.new()
	head.add_theme_constant_override("separation", 8)
	box.add_child(head)
	head.add_child(_make_badge(number))
	var title_label := Label.new()
	title_label.text = title
	title_label.add_theme_font_size_override("font_size", 15)
	title_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	title_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	title_label.custom_minimum_size = Vector2.ZERO
	title_label.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	head.add_child(title_label)
	return box


func _make_badge(number: int) -> Control:
	var panel := PanelContainer.new()
	panel.custom_minimum_size = Vector2(22, 22)
	panel.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	var style := StyleBoxFlat.new()
	style.bg_color = COLOR_ACCENT
	style.set_corner_radius_all(11)
	style.content_margin_left = 0
	style.content_margin_right = 0
	style.content_margin_top = 0
	style.content_margin_bottom = 0
	panel.add_theme_stylebox_override("panel", style)
	var label := Label.new()
	label.text = str(number)
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	label.add_theme_font_size_override("font_size", 12)
	label.add_theme_color_override("font_color", Color.WHITE)
	panel.add_child(label)
	return panel


## 说明/状态/错误文本一律自动换行：Label 关闭换行时最小宽度等于整行文本宽度，会把 Dock 撑宽。
func _make_label(parent: Control, text := "", color := Color.TRANSPARENT, font_size := 0) -> Label:
	var label := Label.new()
	label.text = text
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	label.custom_minimum_size = Vector2.ZERO
	if color != Color.TRANSPARENT:
		label.add_theme_color_override("font_color", color)
	if font_size > 0:
		label.add_theme_font_size_override("font_size", font_size)
	parent.add_child(label)
	return label


## 按钮行用 HFlowContainer：宽度不够时自动换行，而不是靠横向撑开 Dock 来容纳所有按钮。
func _make_button_row(parent: Control) -> HFlowContainer:
	var row := HFlowContainer.new()
	row.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_theme_constant_override("h_separation", 6)
	row.add_theme_constant_override("v_separation", 4)
	parent.add_child(row)
	return row


func _make_status_icon(color: Color) -> TextureRect:
	var rect := TextureRect.new()
	rect.custom_minimum_size = Vector2(16, 16)
	rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	rect.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	rect.modulate = color
	rect.texture = _icon("StatusSuccess")
	return rect


func _make_icon_button(text: String, icon_name: String, tooltip := "") -> Button:
	var button := Button.new()
	button.text = text
	if icon_name != "":
		var texture := _icon(icon_name)
		if texture != null:
			button.icon = texture
	if tooltip != "":
		button.tooltip_text = tooltip
	return button


func _build_repo_card(root: VBoxContainer) -> void:
	var box := _make_card(root, 1, "项目介绍")
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	box.add_child(row)
	var column := VBoxContainer.new()
	column.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	column.add_theme_constant_override("separation", 6)
	row.add_child(column)
	var description := _make_label(
		column,
		"Vino Godot MCP 是一个连接 Godot 编辑器与 AI 助手的桥梁，让 AI 更好地理解和操作你的游戏项目。",
		Color.TRANSPARENT,
		13
	)
	description.name = "IntroDescription"
	var actions := _make_button_row(column)
	var repo_btn := _make_icon_button("查看仓库", "ExternalLink", "在浏览器中打开 %s" % GsConfig.REPO_URL)
	repo_btn.pressed.connect(_on_repo_link_pressed)
	actions.add_child(repo_btn)
	_mascot = TextureRect.new()
	_mascot.texture = _icon("Godot")
	_mascot.custom_minimum_size = Vector2(54, 54)
	_mascot.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	_mascot.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
	_mascot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_child(_mascot)
	_repo_status = _make_label(box, "", COLOR_ERROR, 12)


func _build_node_card(root: VBoxContainer) -> void:
	var box := _make_card(root, 2, "Node.js 环境检测")
	var status_row := _make_button_row(box)
	_node_status_icon = _make_status_icon(COLOR_MUTED)
	status_row.add_child(_node_status_icon)
	_node_state_label = _make_label(status_row, "未检查", Color.TRANSPARENT, 13)
	_node_state_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	# HFlowContainer 只按最小宽度分配：给状态文本一个可读下限，
	# 否则在 240px 面板里文字会被压成"每行两三个字"的窄条。
	_node_state_label.custom_minimum_size = Vector2(110, 0)
	_node_check_btn = _make_icon_button("检查环境", "Reload", "执行 node --version 与 npm --version 检测环境")
	_node_check_btn.pressed.connect(_on_check_env_pressed)
	status_row.add_child(_node_check_btn)
	_node_install_btn = _make_icon_button("一键安装", "AssetLib", "下载 Node.js 官方 LTS 安装包并启动系统安装向导")
	_node_install_btn.visible = false
	_node_install_btn.pressed.connect(_on_install_node_pressed)
	status_row.add_child(_node_install_btn)
	_make_label(box, "支持 Node.js %d+ 版本" % GsEnv.NODE_MIN_MAJOR, COLOR_MUTED, 12)
	_node_detail_label = _make_label(box, "", COLOR_MUTED, 12)
	_node_error_label = _make_label(box, "", COLOR_ERROR, 12)
	_node_error_label.visible = false
	_node_progress_label = _make_label(box, "", COLOR_WARN, 12)


func _build_mcp_card(root: VBoxContainer) -> void:
	var box := _make_card(root, 3, "安装 MCP 工具")
	var status_row := _make_button_row(box)
	_mcp_status_icon = _make_status_icon(COLOR_MUTED)
	status_row.add_child(_mcp_status_icon)
	_mcp_state_label = _make_label(status_row, "未安装", Color.TRANSPARENT, 13)
	_mcp_state_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_mcp_state_label.custom_minimum_size = Vector2(110, 0)
	_mcp_install_btn = _make_icon_button("安装", "Reload", "执行 npm i %s（安装到插件专用目录）" % GsEnv.PACKAGE_NAME)
	_mcp_install_btn.pressed.connect(_on_install_mcp_pressed)
	status_row.add_child(_mcp_install_btn)
	_mcp_detail_label = _make_label(box, "", COLOR_MUTED, 12)
	_mcp_error_label = _make_label(box, "", COLOR_ERROR, 12)
	_mcp_error_label.visible = false
	_mcp_progress_label = _make_label(box, "", COLOR_WARN, 12)

	# npm 输出：有内容时才显示，放在代码块里内部滚动。
	_mcp_output_panel = PanelContainer.new()
	_mcp_output_panel.add_theme_stylebox_override("panel", _code_style())
	_mcp_output_panel.visible = false
	box.add_child(_mcp_output_panel)
	_mcp_output = TextEdit.new()
	_mcp_output.editable = false
	_mcp_output.selecting_enabled = true
	_mcp_output.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	_mcp_output.custom_minimum_size = Vector2(0, 96)
	_mcp_output.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var output_font := _mono_font()
	if output_font != null:
		_mcp_output.add_theme_font_override("font", output_font)
		_mcp_output.add_theme_font_size_override("font_size", 11)
	_mcp_output_panel.add_child(_mcp_output)

	var actions := _make_button_row(box)
	_mcp_check_btn = _make_icon_button("重新检测", "Search", "重新读取已安装的包信息")
	_mcp_check_btn.pressed.connect(_refresh_installed_package)
	actions.add_child(_mcp_check_btn)
	_mcp_open_dir_btn = _make_icon_button("打开安装目录", "Folder", "")
	_mcp_open_dir_btn.pressed.connect(_on_open_install_dir_pressed)
	actions.add_child(_mcp_open_dir_btn)


func _build_agent_card(root: VBoxContainer) -> void:
	var box := _make_card(root, 4, "配置你的 Agent")
	_make_label(box, "以下配置已自动生成，你可以直接使用：", COLOR_MUTED, 13)

	# 代码块：右上角"复制"，JSON 本体带独立横向滚动，不影响整体布局。
	var code_panel := PanelContainer.new()
	code_panel.add_theme_stylebox_override("panel", _code_style())
	box.add_child(code_panel)
	var code_box := VBoxContainer.new()
	code_box.add_theme_constant_override("separation", 2)
	code_panel.add_child(code_box)
	var code_head := HBoxContainer.new()
	code_box.add_child(code_head)
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	code_head.add_child(spacer)
	var copy_btn := _make_icon_button("复制", "Duplicate", "复制 JSON 到剪贴板")
	copy_btn.flat = true
	copy_btn.pressed.connect(_on_copy_json_pressed)
	code_head.add_child(copy_btn)
	_json_edit = TextEdit.new()
	_json_edit.editable = false
	_json_edit.selecting_enabled = true
	_json_edit.context_menu_enabled = true
	_json_edit.wrap_mode = TextEdit.LINE_WRAPPING_NONE
	_json_edit.custom_minimum_size = Vector2(0, 170)
	_json_edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_json_edit.placeholder_text = "尚未生成配置"
	var mono := _mono_font()
	if mono != null:
		_json_edit.add_theme_font_override("font", mono)
		_json_edit.add_theme_font_size_override("font_size", 11)
	# 代码块自身有底色，TextEdit 背景透明，避免出现双层边框。
	var empty := StyleBoxEmpty.new()
	_json_edit.add_theme_stylebox_override("normal", empty)
	_json_edit.add_theme_stylebox_override("focus", empty)
	_json_edit.add_theme_stylebox_override("read_only", empty)
	code_box.add_child(_json_edit)

	var status_row := _make_button_row(box)
	_godot_status_icon = _make_status_icon(COLOR_MUTED)
	status_row.add_child(_godot_status_icon)
	_godot_state_label = _make_label(status_row, "GODOT_PATH 未检测", Color.TRANSPARENT, 13)
	_godot_state_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_godot_state_label.custom_minimum_size = Vector2(110, 0)
	_godot_detail_label = _make_label(box, "", COLOR_MUTED, 12)
	_godot_error_label = _make_label(box, "", COLOR_ERROR, 12)
	_godot_error_label.visible = false

	var actions := _make_button_row(box)
	var redetect_btn := _make_icon_button("重新检测路径", "Reload", "重新获取当前编辑器的可执行文件路径")
	redetect_btn.pressed.connect(_detect_godot_path)
	actions.add_child(redetect_btn)
	var pick_btn := _make_icon_button("手动选择", "Folder", "手动选择一个 Godot Console 可执行文件")
	pick_btn.pressed.connect(func() -> void: _godot_exe_dialog.popup_centered())
	actions.add_child(pick_btn)
	var save_btn := _make_icon_button("保存配置", "Save", "把 JSON 导出为文件（不会静默覆盖已有文件）")
	save_btn.pressed.connect(_on_save_json_pressed)
	actions.add_child(save_btn)
	_clear_manual_btn = _make_icon_button("清除手动路径", "Clear", "")
	_clear_manual_btn.pressed.connect(_on_clear_manual_path_pressed)
	actions.add_child(_clear_manual_btn)

	var dir_row := _make_button_row(box)
	_agent_dir_select = OptionButton.new()
	# 下拉项只放客户端名称；完整路径另起一行显示，避免长路径把 OptionButton 和 Dock 撑宽。
	_agent_dir_select.clip_text = true
	_agent_dir_select.custom_minimum_size = Vector2.ZERO
	_agent_dir_select.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_agent_dir_select.item_selected.connect(_on_agent_dir_selected)
	dir_row.add_child(_agent_dir_select)
	_agent_dir_open_btn = _make_icon_button("打开目录", "Folder", "打开所选 MCP 客户端的配置目录")
	_agent_dir_open_btn.pressed.connect(_on_open_agent_dir_pressed)
	dir_row.add_child(_agent_dir_open_btn)
	_agent_dir_path_label = _make_label(box, "", COLOR_MUTED, 11)
	_agent_status_label = _make_label(box, "", COLOR_MUTED, 12)


func _build_ready_bar(root: VBoxContainer) -> void:
	_ready_bar = PanelContainer.new()
	_ready_bar.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_ready_bar.add_theme_stylebox_override("panel", _ready_style(false))
	root.add_child(_ready_bar)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 6)
	_ready_bar.add_child(row)
	_ready_icon = _make_status_icon(COLOR_MUTED)
	row.add_child(_ready_icon)
	_ready_label = _make_label(row, "按下面 4 步完成配置", Color.TRANSPARENT, 13)


func _build_dialogs() -> void:
	_confirm_install_dialog = ConfirmationDialog.new()
	_confirm_install_dialog.title = "确认下载并安装 Node.js"
	_confirm_install_dialog.ok_button_text = "下载并启动安装"
	_confirm_install_dialog.dialog_autowrap = true
	_confirm_install_dialog.min_size = Vector2i(600, 0)
	_confirm_install_dialog.confirmed.connect(_on_install_confirmed)
	add_child(_confirm_install_dialog)

	_info_dialog = AcceptDialog.new()
	_info_dialog.title = "Node.js 安装说明"
	_info_dialog.dialog_autowrap = true
	_info_dialog.min_size = Vector2i(600, 0)
	var open_page_btn := _info_dialog.add_button("打开官方下载页", true, "open_download_page")
	open_page_btn.pressed.connect(func() -> void: _shell_open(GsEnv.OFFICIAL_DOWNLOAD_PAGE, _node_progress_label))
	add_child(_info_dialog)

	_overwrite_dialog = ConfirmationDialog.new()
	_overwrite_dialog.title = "文件已存在"
	_overwrite_dialog.ok_button_text = "覆盖写入"
	_overwrite_dialog.dialog_autowrap = true
	_overwrite_dialog.confirmed.connect(_on_overwrite_confirmed)
	add_child(_overwrite_dialog)

	_save_dialog = EditorFileDialog.new()
	_save_dialog.title = "保存 MCP 配置"
	_save_dialog.file_mode = EditorFileDialog.FILE_MODE_SAVE_FILE
	_save_dialog.access = EditorFileDialog.ACCESS_FILESYSTEM
	_save_dialog.add_filter("*.json", "JSON 配置文件")
	_save_dialog.current_file = "mcp.json"
	_save_dialog.file_selected.connect(_on_save_path_selected)
	add_child(_save_dialog)

	_godot_exe_dialog = EditorFileDialog.new()
	_godot_exe_dialog.title = "选择 Godot 可执行文件"
	_godot_exe_dialog.file_mode = EditorFileDialog.FILE_MODE_OPEN_FILE
	_godot_exe_dialog.access = EditorFileDialog.ACCESS_FILESYSTEM
	if GsConfig.platform_id() == "windows":
		_godot_exe_dialog.add_filter("*.exe", "Windows 可执行文件")
	_godot_exe_dialog.add_filter("*", "所有文件")
	_godot_exe_dialog.file_selected.connect(_on_godot_exe_selected)
	add_child(_godot_exe_dialog)


# ---------------------------------------------------------------- 第 1 节

func _on_repo_link_pressed() -> void:
	var err := OS.shell_open(GsConfig.REPO_URL)
	_repo_status.text = "" if err == OK else "无法打开浏览器：%s" % error_string(err)


# ---------------------------------------------------------------- 第 2 节：Node.js

func _on_check_env_pressed() -> void:
	if _runner.is_running(TOKEN_ENV):
		return
	_env_state = "checking"
	_env_report = {}
	_node_progress_note = ""
	_update_env_ui()
	_runner.start_job(TOKEN_ENV, func() -> Dictionary: return GsEnv.detect())


func _on_env_result(result: Dictionary) -> void:
	_env_report = result
	_env_state = "done" if bool(result.get("ok", false)) else "failed"
	if _node_install_state == "launched":
		# 安装向导启动后的自动重检：两个都就绪才结束轮询，否则继续等。
		var node: Dictionary = result.get("node", {})
		var npm: Dictionary = result.get("npm", {})
		if bool(node.get("found", false)) and bool(npm.get("found", false)):
			_node_install_state = "idle"
			_node_progress_note = "已检测到 Node.js 与 npm，安装完成。"
		else:
			_node_progress_note = "安装向导已启动，等待安装完成后自动重新检测…"
	else:
		_node_progress_note = ""
	_update_env_ui()


func _on_install_node_pressed() -> void:
	if _runner.is_running(TOKEN_NODE_PLAN) or _runner.is_running(TOKEN_NODE_DOWNLOAD):
		return
	_node_install_state = "planning"
	_node_progress_note = "正在读取 Node.js 官方版本信息…"
	_update_env_ui()
	_runner.start_job(TOKEN_NODE_PLAN, func() -> Dictionary: return GsEnv.resolve_node_install_plan())


func _on_node_plan_result(result: Dictionary) -> void:
	_pending_plan = result
	if bool(result.get("ok", false)) and str(result.get("url", "")) != "":
		_node_install_state = "idle"
		_node_progress_note = ""
		var lines := PackedStringArray()
		lines.append("版本：Node.js %s（官方 LTS）" % str(result.get("version", "")))
		lines.append("来源：%s" % str(result.get("url", "")))
		lines.append("文件：%s" % str(result.get("filename", "")))
		lines.append("SHA-256：%s" % str(result.get("sha256", "")))
		lines.append("")
		lines.append(str(result.get("instructions", "")))
		_confirm_install_dialog.dialog_text = "\n".join(lines)
		_confirm_install_dialog.popup_centered()
		_update_env_ui()
		return
	_node_install_state = "failed"
	_node_progress_note = ""
	_info_dialog.dialog_text = "%s\n\n%s" % [str(result.get("error", "无法自动安装")), str(result.get("instructions", ""))]
	_info_dialog.popup_centered()
	_update_env_ui()


func _on_install_confirmed() -> void:
	if _pending_plan.is_empty():
		return
	_node_install_state = "downloading"
	_node_progress_note = "正在下载官方安装包…"
	_update_env_ui()
	_runner.start_job(TOKEN_NODE_DOWNLOAD, func() -> Dictionary: return GsEnv.download_node_installer(_pending_plan))


func _on_node_download_result(result: Dictionary) -> void:
	if not bool(result.get("ok", false)):
		_node_install_state = "failed"
		_node_progress_note = ""
		_info_dialog.dialog_text = "安装包下载失败：\n%s\n\n%s" % [
			str(result.get("error", "")), str(result.get("output", ""))
		]
		_info_dialog.popup_centered()
		_update_env_ui()
		return
	# 由系统打开安装向导（不静默安装，不修改环境变量）。
	var err := OS.shell_open(str(result.get("path", "")))
	if err != OK:
		_node_install_state = "failed"
		_node_progress_note = ""
		_info_dialog.dialog_text = "安装包已下载到：\n%s\n\n但无法自动启动安装程序（%s），请手动双击运行。" % [
			str(result.get("path", "")), error_string(err)
		]
		_info_dialog.popup_centered()
		_update_env_ui()
		return
	_node_install_state = "launched"
	_node_progress_note = "安装向导已启动，等待安装完成后自动重新检测…"
	_node_recheck_until = Time.get_ticks_msec() + NODE_RECHECK_WINDOW_MS
	_node_recheck_next = Time.get_ticks_msec() + NODE_RECHECK_INTERVAL_MS
	_update_env_ui()


func _update_env_ui() -> void:
	var busy: bool = _runner != null and bool(_runner.is_running(TOKEN_ENV))
	_node_check_btn.disabled = busy
	if _env_state == "checking":
		_set_state(_node_state_label, _node_status_icon, "检测中…", COLOR_WARN)
		_node_detail_label.text = ""
		_node_error_label.visible = false
		_node_install_btn.visible = false
		_node_progress_label.text = "检查中…"
		_update_ready_bar()
		return
	if _env_report.is_empty():
		_set_state(_node_state_label, _node_status_icon, "未检查", COLOR_MUTED)
		_node_detail_label.text = "点击「检查环境」执行 node --version 与 npm --version。"
		_node_error_label.visible = false
		_node_install_btn.visible = false
		_node_progress_label.text = _node_progress_note
		_update_ready_bar()
		return

	var node: Dictionary = _env_report.get("node", {})
	var npm: Dictionary = _env_report.get("npm", {})
	var node_found := bool(node.get("found", false))
	var npm_found := bool(npm.get("found", false))
	var ok := node_found and npm_found
	if ok:
		_set_state(_node_state_label, _node_status_icon, "已安装： v%s" % str(node.get("version", "?")), COLOR_OK)
	else:
		_set_state(_node_state_label, _node_status_icon, "未安装" if not node_found else "npm 缺失", COLOR_ERROR)
	var detail := PackedStringArray()
	if node_found:
		var source := "PATH" if bool(node.get("in_path", false)) else "常见安装目录"
		var node_path := str(node.get("path", ""))
		detail.append("node（%s）：%s" % [source, node_path if node_path != "" else "未能解析绝对路径"])
	else:
		detail.append("未找到可执行的 node。")
	if bool(_env_report.get("below_minimum", false)):
		detail.append("版本低于项目要求（Node.js %d+）。" % int(_env_report.get("minimum_major", GsEnv.NODE_MIN_MAJOR)))
	if npm_found:
		var npm_path := str(npm.get("path", ""))
		detail.append("npm %s%s" % [str(npm.get("version", "?")), ("：" + npm_path) if npm_path != "" else ""])
	else:
		detail.append("未找到可执行的 npm。")
	if str(node.get("note", "")) != "":
		detail.append(str(node.get("note", "")))
	if str(npm.get("note", "")) != "":
		detail.append(str(npm.get("note", "")))
	_node_detail_label.text = "\n".join(detail)
	var errors := PackedStringArray()
	if not node_found and str(node.get("error", "")) != "":
		errors.append(str(node.get("error", "")))
	if not npm_found and str(npm.get("error", "")) != "":
		errors.append(str(npm.get("error", "")))
	_node_error_label.text = "\n".join(errors)
	_node_error_label.visible = errors.size() > 0
	var needs_install := bool(_env_report.get("needs_install", true))
	var install_busy := _node_install_state == "planning" or _node_install_state == "downloading"
	_node_install_btn.visible = needs_install
	_node_install_btn.disabled = install_busy
	_node_check_btn.text = "重新检测" if not needs_install else "检查环境"
	_node_progress_label.text = _node_progress_note
	_update_ready_bar()


# ---------------------------------------------------------------- 第 3 节：MCP 包

func _refresh_installed_package() -> void:
	var info := GsEnv.read_installed_package()
	_mcp_report = info
	_mcp_state = "done" if bool(info.get("found", false)) else "unchecked"
	_update_mcp_ui()


func _on_install_mcp_pressed() -> void:
	if _runner.is_running(TOKEN_MCP_INSTALL):
		return
	_mcp_state = "installing"
	_mcp_output.text = ""
	_mcp_progress_note = ""
	_update_mcp_ui()
	_runner.start_job(TOKEN_MCP_INSTALL, func() -> Dictionary: return GsEnv.install_mcp_package())


func _on_mcp_install_result(result: Dictionary) -> void:
	_mcp_report = result
	_mcp_state = "done" if bool(result.get("ok", false)) else "failed"
	# 安装结果用 verified/version 表达；界面统一读 found/version，安装后重新读一次真实状态。
	var installed := GsEnv.read_installed_package()
	_mcp_report["found"] = bool(installed.get("found", false))
	_mcp_report["version"] = str(installed.get("version", ""))
	_mcp_progress_note = ""
	_mcp_output.text = GsShell.tail(str(result.get("output", "")))
	_mcp_output.scroll_vertical = _mcp_output.get_line_count()
	_update_mcp_ui()


func _update_mcp_ui() -> void:
	var installed := bool(_mcp_report.get("found", false))
	var install_dir := GsEnv.install_dir()
	_mcp_install_btn.text = "重新安装" if installed else "安装"
	_mcp_detail_label.text = "%s · 安装位置：%s" % [GsEnv.PACKAGE_NAME, install_dir]
	if _mcp_state == "installing":
		_set_state(_mcp_state_label, _mcp_status_icon, "安装中…", COLOR_WARN)
		_mcp_error_label.visible = false
		_mcp_install_btn.disabled = true
		_mcp_check_btn.disabled = true
		_update_ready_bar()
		return
	_mcp_install_btn.disabled = false
	_mcp_check_btn.disabled = false
	if _mcp_state == "failed":
		_set_state(_mcp_state_label, _mcp_status_icon, "安装失败", COLOR_ERROR)
	elif installed:
		# 包里名放在下方说明行，状态行只留版本号，窄面板下不会被折成很多行。
		_set_state(_mcp_state_label, _mcp_status_icon, "已安装： v%s" % str(_mcp_report.get("version", "?")), COLOR_OK)
	else:
		_set_state(_mcp_state_label, _mcp_status_icon, "未安装", COLOR_MUTED)
	var error := str(_mcp_report.get("error", ""))
	_mcp_error_label.text = error
	_mcp_error_label.visible = error != ""
	_mcp_output_panel.visible = _mcp_output.text.strip_edges() != ""
	_mcp_progress_label.text = _mcp_progress_note
	_update_ready_bar()


func _on_open_install_dir_pressed() -> void:
	var dir := GsEnv.install_dir()
	var create_error := GsShell.ensure_dir(dir)
	if create_error != "":
		_mcp_error_label.text = create_error
		_mcp_error_label.visible = true
		return
	_shell_open(dir, _mcp_progress_label)


# ---------------------------------------------------------------- 第 4 节：Godot 路径与 JSON

func _detect_godot_path() -> void:
	var settings = EditorInterface.get_editor_settings()
	_godot_report = GsConfig.resolve_godot_executable(settings, OS.get_executable_path())
	_rebuild_json()
	_update_godot_ui()


func _rebuild_json() -> void:
	_json_error = ""
	if not bool(_godot_report.get("ok", false)):
		_json_text = ""
		_json_error = str(_godot_report.get("error", "尚未确定 Godot Console 可执行文件路径"))
		_json_edit.text = ""
		_json_edit.placeholder_text = "无法生成配置：%s" % _json_error
		return
	var native := GsConfig.native_path(str(_godot_report.get("console_path", "")))
	var built := GsConfig.build_agent_config(native)
	if bool(built.get("ok", false)):
		_json_text = str(built.get("text", ""))
		_json_edit.text = _json_text
		_json_edit.placeholder_text = ""
	else:
		_json_text = ""
		_json_error = str(built.get("error", "生成配置失败"))
		_json_edit.text = ""
		_json_edit.placeholder_text = "无法生成配置：%s" % _json_error


func _update_godot_ui() -> void:
	var ok := bool(_godot_report.get("ok", false))
	var manual := str(_godot_report.get("manual_path", ""))
	if ok:
		_set_state(_godot_state_label, _godot_status_icon, "GODOT_PATH 已检测", COLOR_OK)
	else:
		_set_state(_godot_state_label, _godot_status_icon, "GODOT_PATH 检测失败", COLOR_ERROR)
	var lines := PackedStringArray()
	if ok:
		lines.append(str(_godot_report.get("console_path", "")))
		lines.append("来源：%s" % str(_godot_report.get("note", "")))
	else:
		lines.append("编辑器可执行文件：%s" % (str(_godot_report.get("editor_path", "")) if str(_godot_report.get("editor_path", "")) != "" else "（未知）"))
	_godot_detail_label.text = "\n".join(lines)
	var error := str(_godot_report.get("error", ""))
	_godot_error_label.text = error
	_godot_error_label.visible = error != ""
	_clear_manual_btn.disabled = manual == ""
	_clear_manual_btn.visible = manual != "" or not ok
	_update_ready_bar()


func _on_clear_manual_path_pressed() -> void:
	var settings = EditorInterface.get_editor_settings()
	if settings == null:
		_set_agent_status("无法访问编辑器设置（EditorSettings 不可用）。", COLOR_ERROR)
		return
	GsConfig.clear_manual_path(settings)
	_detect_godot_path()
	_set_agent_status("已清除手动路径，改回使用当前编辑器进程的路径。", COLOR_MUTED)


func _on_godot_exe_selected(path: String) -> void:
	if not FileAccess.file_exists(path):
		_set_agent_status("所选文件不存在：%s" % path, COLOR_ERROR)
		return
	var settings = EditorInterface.get_editor_settings()
	if settings == null:
		_set_agent_status("无法访问编辑器设置（EditorSettings 不可用），无法保存手动路径。", COLOR_ERROR)
		return
	settings.set_setting(GsConfig.SETTINGS_KEY_MANUAL_PATH, path)
	settings.save()
	_detect_godot_path()
	if bool(_godot_report.get("ok", false)):
		_set_agent_status("已保存手动路径：%s" % str(_godot_report.get("console_path", "")), COLOR_MUTED)
	else:
		_set_agent_status(str(_godot_report.get("error", "路径无效")), COLOR_ERROR)


func _on_copy_json_pressed() -> void:
	if _json_text == "":
		_set_agent_status("没有可复制的 JSON：%s" % _json_error, COLOR_ERROR)
		return
	DisplayServer.clipboard_set(_json_text)
	var readback := DisplayServer.clipboard_get()
	if readback == _json_text:
		_set_agent_status("已复制合法 JSON（%d 字符）到剪贴板。" % _json_text.length(), COLOR_OK)
	else:
		_set_agent_status("剪贴板写入后读回不一致，请改用「保存配置」导出文件。", COLOR_ERROR)


func _on_save_json_pressed() -> void:
	if _json_text == "":
		_set_agent_status("没有可保存的 JSON：%s" % _json_error, COLOR_ERROR)
		return
	_save_dialog.current_file = "mcp.json"
	_save_dialog.popup_centered()


func _on_save_path_selected(path: String) -> void:
	if FileAccess.file_exists(path):
		# 不静默覆盖：先向用户确认。
		_pending_save_path = path
		_overwrite_dialog.dialog_text = "文件已存在：\n%s\n\n要用生成的配置覆盖它吗？" % path
		_overwrite_dialog.popup_centered()
		return
	_write_config(path)


func _on_overwrite_confirmed() -> void:
	if _pending_save_path == "":
		return
	_write_config(_pending_save_path)
	_pending_save_path = ""


func _write_config(path: String) -> void:
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		_set_agent_status("写入失败：%s（%s）" % [path, error_string(FileAccess.get_open_error())], COLOR_ERROR)
		return
	f.store_string(_json_text)
	f.close()
	# 读回校验：确保落盘内容仍是合法 JSON。
	var read_back := FileAccess.open(path, FileAccess.READ)
	if read_back == null:
		_set_agent_status("已写入，但无法读回校验：%s" % path, COLOR_ERROR)
		return
	var text := read_back.get_as_text()
	read_back.close()
	var parsed = JSON.parse_string(text)
	if parsed == null or not parsed is Dictionary:
		_set_agent_status("已写入，但读回内容不是合法 JSON：%s" % path, COLOR_ERROR)
		return
	_set_agent_status("已保存并在读回时通过 JSON 解析校验：%s" % path, COLOR_OK)


func _detect_agent_dirs() -> void:
	_agent_dirs = GsConfig.detect_agent_dirs()
	_agent_dir_select.clear()
	for entry in _agent_dirs:
		_agent_dir_select.add_item(str(entry["name"]))
	if _agent_dirs.is_empty():
		_agent_dir_select.add_item("（未识别到已知客户端）")
		_agent_dir_select.disabled = true
		_agent_dir_open_btn.disabled = true
		_agent_dir_path_label.text = "未识别到已知 MCP 客户端配置目录（不会猜测路径）。"
		return
	_agent_dir_select.disabled = false
	_agent_dir_open_btn.disabled = false
	_agent_dir_select.selected = 0
	_update_agent_dir_path(0)


func _on_agent_dir_selected(index: int) -> void:
	_update_agent_dir_path(index)


func _update_agent_dir_path(index: int) -> void:
	if index < 0 or index >= _agent_dirs.size():
		_agent_dir_path_label.text = ""
		return
	var dir := str(_agent_dirs[index]["dir"])
	_agent_dir_path_label.text = dir
	_agent_dir_select.tooltip_text = dir


func _on_open_agent_dir_pressed() -> void:
	var index := _agent_dir_select.selected
	if index < 0 or index >= _agent_dirs.size():
		return
	var dir := str(_agent_dirs[index]["dir"])
	_shell_open(dir, _agent_status_label)


func _set_agent_status(text: String, color: Color) -> void:
	_agent_status_label.text = text
	_agent_status_label.add_theme_color_override("font_color", color)


# ---------------------------------------------------------------- 底部完成状态条

## 最后一步的绿色提示条：四个条件都满足才显示"配置已准备完成！"。
func _update_ready_bar() -> void:
	if _ready_bar == null:
		return
	var node: Dictionary = _env_report.get("node", {})
	var npm: Dictionary = _env_report.get("npm", {})
	var node_ok := bool(node.get("found", false))
	var npm_ok := bool(npm.get("found", false))
	var mcp_ok := bool(_mcp_report.get("found", false))
	var godot_ok := bool(_godot_report.get("ok", false))
	var ready := node_ok and npm_ok and mcp_ok and godot_ok
	_ready_bar.add_theme_stylebox_override("panel", _ready_style(ready))
	_ready_icon.modulate = COLOR_OK if ready else COLOR_MUTED
	_ready_icon.texture = _icon("StatusSuccess") if ready else _icon("Info")
	var text := ""
	var color := Color.TRANSPARENT
	if ready:
		text = "配置已准备完成！"
		color = COLOR_OK
	elif _env_report.is_empty():
		text = "第 2 步：点击「检查环境」确认 Node.js 就绪"
	elif not node_ok:
		text = "第 2 步：未检测到 Node.js，可用「一键安装」"
	elif not mcp_ok:
		text = "第 3 步：点击「安装」安装 MCP 工具"
	elif not godot_ok:
		text = "第 4 步：未确定 Godot Console 路径，请手动选择"
	else:
		text = "第 4 步：复制或保存 JSON 到你的 Agent 配置"
	_ready_label.text = text
	if color == Color.TRANSPARENT:
		_ready_label.remove_theme_color_override("font_color")
	else:
		_ready_label.add_theme_color_override("font_color", color)


# ---------------------------------------------------------------- 任务回调 / 帧循环

func _on_job_finished(token: String, result: Dictionary) -> void:
	match token:
		TOKEN_ENV:
			_on_env_result(result)
		TOKEN_MCP_INSTALL:
			_on_mcp_install_result(result)
		TOKEN_NODE_PLAN:
			_on_node_plan_result(result)
		TOKEN_NODE_DOWNLOAD:
			_on_node_download_result(result)


func _process(_delta: float) -> void:
	# 宽度变化时才做一次紧凑布局判定（比依赖 resized 信号更可靠：
	# 页面可能在信号连接前就被容器排版过）。
	if size.x != _last_width:
		_last_width = size.x
		_apply_compact_layout()
	if _runner == null:
		return
	if _runner.is_running(TOKEN_ENV):
		_node_progress_label.text = "检查中… %.1fs" % _runner.elapsed_seconds(TOKEN_ENV)
	elif _runner.is_running(TOKEN_NODE_PLAN):
		_node_progress_label.text = "读取官方版本信息… %.1fs" % _runner.elapsed_seconds(TOKEN_NODE_PLAN)
	elif _runner.is_running(TOKEN_NODE_DOWNLOAD):
		_node_progress_label.text = "下载官方安装包… %.1fs" % _runner.elapsed_seconds(TOKEN_NODE_DOWNLOAD)
	if _runner.is_running(TOKEN_MCP_INSTALL):
		_mcp_progress_label.text = "安装中… %.1fs（后台执行，编辑器可继续使用）" % _runner.elapsed_seconds(TOKEN_MCP_INSTALL)
	_tick_node_recheck()


## 安装向导启动后轮询：装完自动重新检测 node / npm（不阻塞 UI）。
func _tick_node_recheck() -> void:
	if _node_install_state != "launched":
		return
	var now := Time.get_ticks_msec()
	if now > _node_recheck_until:
		_node_install_state = "idle"
		_node_progress_note = "未在 3 分钟内检测到安装完成，可手动点击「检查环境」。"
		_node_progress_label.text = _node_progress_note
		return
	if now < _node_recheck_next:
		return
	if _runner.is_running(TOKEN_ENV):
		return
	_node_recheck_next = now + NODE_RECHECK_INTERVAL_MS
	_runner.start_job(TOKEN_ENV, func() -> Dictionary: return GsEnv.detect())


# ---------------------------------------------------------------- 小工具

## 状态行 = 图标 + 文本；文字与图标颜色一起更新，保持"✓ 已安装"的视觉一致。
func _set_state(label: Label, icon: TextureRect, text: String, color: Color) -> void:
	label.text = text
	label.add_theme_color_override("font_color", color)
	if icon != null:
		icon.modulate = color
		icon.texture = _icon("StatusSuccess") if color == COLOR_OK else _icon("StatusWarning")


func _shell_open(target: String, status_label: Label) -> void:
	var err := OS.shell_open(target)
	if err != OK:
		status_label.text = "无法打开：%s（%s）" % [target, error_string(err)]
		status_label.add_theme_color_override("font_color", COLOR_ERROR)
