@tool
extends ScrollContainer

## 「上下文」页面：只读展示当前 Godot 编辑器的真实项目/场景上下文。
##
## 数据全部来自 core/editor_context.gd（EditorInterface / ProjectSettings / Node API），
## 不运行游戏、不读 .tscn 文本、不修改场景。
##
## 刷新策略：
## - 手动「刷新上下文」；
## - 编辑器事件（场景切换/关闭、选择变化、保存、项目设置变化）触发防抖刷新；
## - 低频指纹轮询（1.5s，只在页面可见时）兜底捕获没有被信号覆盖的变化；
## - 不做每帧遍历。

const UiKit := preload("ui_kit.gd")
const EditorContext := preload("../core/editor_context.gd")

const REFRESH_DEBOUNCE_MS := 250
const MIN_REFRESH_INTERVAL_MS := 500
const POLL_INTERVAL_MS := 1500
const TREE_AUTO_EXPAND_DEPTH := 2

var _plugin: Node
var _auto_refresh := true
var _pending_refresh_ms := 0
var _last_collect_ms := 0
var _next_poll_ms := 0
var _last_fingerprint := ""
var _last_result: Dictionary = {}

# 顶部工具条
var _status_icon: TextureRect
var _status_label: Label
var _auto_check: CheckButton
var _refresh_btn: Button
var _scene_state_label: Label

# 项目信息 / 当前场景（key -> value label）
var _project_values := {}
var _scene_values := {}
var _summary_label: Label

# 节点树
var _tree: Tree
var _tree_summary: Label

# 选中对象
var _selection_label: RichTextLabel
var _selection_summary: Label

# 信号
var _signal_tree: Tree
var _signal_summary: Label

# 分组
var _group_tree: Tree
var _group_summary: Label

# 统计
var _stats_label: RichTextLabel
var _type_label: RichTextLabel


func _ready() -> void:
	horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	follow_focus = true
	_build_ui()
	_request_refresh()


func _attach(plugin: Node) -> void:
	_plugin = plugin
	if _plugin == null:
		return
	# EditorPlugin 的编辑器事件：场景切换/关闭/保存都只触发一次防抖刷新。
	for signal_name in ["scene_changed", "scene_closed", "resource_saved", "scene_saved", "project_settings_changed"]:
		if _plugin.has_signal(signal_name) and not _plugin.is_connected(signal_name, _on_editor_event):
			_plugin.connect(signal_name, _on_editor_event)
	var selection := EditorInterface.get_selection()
	if selection != null and not selection.selection_changed.is_connected(_on_selection_changed):
		selection.selection_changed.connect(_on_selection_changed)


func _on_editor_event(_arg = null) -> void:
	_request_refresh()


func _on_selection_changed() -> void:
	_request_refresh()


func _request_refresh() -> void:
	_pending_refresh_ms = Time.get_ticks_msec() + REFRESH_DEBOUNCE_MS


func _process(_delta: float) -> void:
	var now := Time.get_ticks_msec()
	if _pending_refresh_ms > 0 and now >= _pending_refresh_ms:
		_pending_refresh_ms = 0
		_refresh()
	if not _auto_refresh or not is_visible_in_tree():
		return
	if now < _next_poll_ms:
		return
	_next_poll_ms = now + POLL_INTERVAL_MS
	var fingerprint := EditorContext.fingerprint()
	if fingerprint != _last_fingerprint:
		_request_refresh()


func _refresh() -> void:
	var now := Time.get_ticks_msec()
	if now - _last_collect_ms < MIN_REFRESH_INTERVAL_MS and not _last_result.is_empty():
		_pending_refresh_ms = now + MIN_REFRESH_INTERVAL_MS
		return
	_last_collect_ms = now
	_last_fingerprint = EditorContext.fingerprint()
	_last_result = EditorContext.collect()
	_apply(_last_result)


# ---------------------------------------------------------------- UI 构建

func _build_ui() -> void:
	var root := VBoxContainer.new()
	root.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	root.add_theme_constant_override("separation", 8)
	add_child(root)

	var header := UiKit.label(root, "上下文", Color.TRANSPARENT, 18)
	header.autowrap_mode = TextServer.AUTOWRAP_OFF
	UiKit.label(root, "当前 Godot 项目的实时编辑器信息（只读）", UiKit.COLOR_MUTED, 12)

	var toolbar := UiKit.button_row(root)
	_refresh_btn = UiKit.icon_button("刷新上下文", "Reload", "重新读取当前编辑场景")
	_refresh_btn.pressed.connect(_on_refresh_pressed)
	toolbar.add_child(_refresh_btn)
	_auto_check = CheckButton.new()
	_auto_check.text = "自动刷新"
	_auto_check.button_pressed = true
	_auto_check.tooltip_text = "场景切换、选择变化、保存时自动更新（1.5 秒兜底轮询）"
	_auto_check.toggled.connect(_on_auto_toggled)
	toolbar.add_child(_auto_check)

	var status_row := UiKit.button_row(root)
	_status_icon = UiKit.status_icon(UiKit.COLOR_MUTED, "Info")
	status_row.add_child(_status_icon)
	_status_label = UiKit.label(status_row, "尚未采集", UiKit.COLOR_MUTED, 12)
	_status_label.custom_minimum_size = Vector2(110, 0)
	_scene_state_label = UiKit.label(root, "", UiKit.COLOR_MUTED, 12)

	_build_project_card(root)
	_build_scene_card(root)
	_build_tree_card(root)
	_build_selection_card(root)
	_build_signal_card(root)
	_build_group_card(root)
	_build_stats_card(root)

	_summary_label = UiKit.label(root, "", UiKit.COLOR_MUTED, 11)


func _build_project_card(root: VBoxContainer) -> void:
	var box := UiKit.card(root, "项目信息", "Godot")
	for key in ["项目名称", "项目路径", "project.godot", "Godot 版本", "主场景", "渲染器", "功能配置"]:
		_project_values[key] = UiKit.kv(box, key)


func _build_scene_card(root: VBoxContainer) -> void:
	var box := UiKit.card(root, "当前场景", "Node")
	for key in ["场景名称", "场景路径", "根节点", "节点数量", "未保存修改", "实例化子场景", "播放状态"]:
		_scene_values[key] = UiKit.kv(box, key)


func _build_tree_card(root: VBoxContainer) -> void:
	var box := UiKit.card(root, "场景节点树", "Tree")
	_tree_summary = UiKit.label(box, "", UiKit.COLOR_MUTED, 11)
	_tree = UiKit.tree(box, 220)


func _build_selection_card(root: VBoxContainer) -> void:
	var box := UiKit.card(root, "当前选中对象", "Search")
	_selection_summary = UiKit.label(box, "", UiKit.COLOR_MUTED, 11)
	_selection_label = UiKit.mono_label(box, "当前没有选中对象", 11)
	_selection_label.custom_minimum_size = Vector2(0, 96)


func _build_signal_card(root: VBoxContainer) -> void:
	var box := UiKit.card(root, "信号", "NodeWarning")
	_signal_summary = UiKit.label(box, "", UiKit.COLOR_MUTED, 11)
	_signal_tree = UiKit.tree(box, 160)


func _build_group_card(root: VBoxContainer) -> void:
	var box := UiKit.card(root, "分组", "Object")
	_group_summary = UiKit.label(box, "", UiKit.COLOR_MUTED, 11)
	_group_tree = UiKit.tree(box, 140)


func _build_stats_card(root: VBoxContainer) -> void:
	var box := UiKit.card(root, "场景统计", "GraphNode")
	_stats_label = UiKit.mono_label(box, "—", 11)
	_stats_label.custom_minimum_size = Vector2(0, 110)
	_type_label = UiKit.mono_label(box, "", 11)
	_type_label.custom_minimum_size = Vector2(0, 70)


# ---------------------------------------------------------------- 交互

func _on_refresh_pressed() -> void:
	_last_collect_ms = 0
	_refresh()


func _on_auto_toggled(pressed: bool) -> void:
	_auto_refresh = pressed
	if pressed:
		_request_refresh()


# ---------------------------------------------------------------- 数据填充

func _apply(result: Dictionary) -> void:
	_apply_header(result)
	_apply_project(result.get("project", {}))
	_apply_scene(result.get("scene", {}))
	_apply_tree(result)
	_apply_selection(result.get("selection", {}))
	_apply_signals(result.get("signals", {}))
	_apply_groups(result.get("groups", {}))
	_apply_stats(result)


func _apply_header(result: Dictionary) -> void:
	var ok := bool(result.get("ok", false))
	var reason := str(result.get("reason", ""))
	if ok:
		_status_icon.modulate = UiKit.COLOR_OK
		_status_icon.texture = UiKit.icon("StatusSuccess")
		_status_label.text = "已采集 %s" % str(result.get("collectedAt", ""))
		_status_label.add_theme_color_override("font_color", UiKit.COLOR_MUTED)
	else:
		_status_icon.modulate = UiKit.COLOR_WARN
		_status_icon.texture = UiKit.icon("StatusWarning")
		_status_label.text = {
			"no_open_scene": "未打开场景",
			"scene_root_missing": "有打开的场景，但没有可用的根节点",
			"scene_root_invalid": "场景根节点已失效",
		}.get(reason, "采集失败")
		_status_label.add_theme_color_override("font_color", UiKit.COLOR_WARN)
	var scene: Dictionary = result.get("scene", {})
	if bool(scene.get("hasScene", false)):
		var playing := bool(scene.get("isPlayingScene", false))
		_scene_state_label.text = "当前编辑场景：%s%s" % [
			str(scene.get("path", "")) if str(scene.get("path", "")) != "" else "（未保存的新场景）",
			"（游戏运行中）" if playing else "",
		]
	else:
		_scene_state_label.text = "当前没有打开的场景"


func _apply_project(project: Dictionary) -> void:
	_set_value(_project_values, "项目名称", str(project.get("name", "")))
	_set_value(_project_values, "项目路径", str(project.get("projectPath", "")))
	var project_file := str(project.get("projectFile", ""))
	_set_value(_project_values, "project.godot", "%s%s" % [
		project_file, "" if bool(project.get("projectFileExists", false)) else "（文件不存在）"
	])
	_set_value(_project_values, "Godot 版本", str(project.get("godotVersion", "")))
	var main_scene := str(project.get("mainScene", ""))
	_set_value(_project_values, "主场景", main_scene if main_scene != "" else "未设置")
	_set_value(_project_values, "渲染器", str(project.get("renderer", "")))
	var features: Array = project.get("features", [])
	_set_value(_project_values, "功能配置", ", ".join(PackedStringArray(features)) if not features.is_empty() else "—")


func _apply_scene(scene: Dictionary) -> void:
	var has_scene := bool(scene.get("hasScene", false))
	if not has_scene:
		_set_value(_scene_values, "场景名称", "未打开场景")
		_set_value(_scene_values, "场景路径", "—")
		_set_value(_scene_values, "根节点", "—")
		_set_value(_scene_values, "节点数量", "—")
		_set_value(_scene_values, "未保存修改", str(scene.get("isDirtyReason", "无法获取")))
		_set_value(_scene_values, "实例化子场景", "—")
		_set_value(_scene_values, "播放状态", "未运行" if not bool(scene.get("isPlayingScene", false)) else "运行中")
		return
	var scene_path := str(scene.get("path", ""))
	_set_value(_scene_values, "场景名称", str(scene.get("rootName", "")))
	_set_value(_scene_values, "场景路径", scene_path if scene_path != "" else "（未保存的新场景）")
	_set_value(_scene_values, "根节点", "%s（%s）" % [str(scene.get("rootName", "")), str(scene.get("rootClass", ""))])
	_set_value(_scene_values, "节点数量", "%d（含内部节点 %d）" % [
		int(scene.get("nodeCount", 0)), int(scene.get("nodeCountIncludingInternal", 0))
	])
	# 编辑器没有公开的 dirty 查询：如实说明，不猜。
	_set_value(_scene_values, "未保存修改", "无法获取：%s" % str(scene.get("isDirtyReason", "")))
	var instances: Array = _last_result.get("instances", [])
	_set_value(_scene_values, "实例化子场景", "%d 个" % instances.size() if not instances.is_empty() else "无")
	var playing := bool(scene.get("isPlayingScene", false))
	_set_value(_scene_values, "播放状态", ("运行中：%s" % str(scene.get("playingScene", ""))) if playing else "未运行（读取的是编辑器内场景）")


func _apply_tree(result: Dictionary) -> void:
	_tree.clear()
	var tree_data: Dictionary = result.get("tree", {})
	var entries: Array = tree_data.get("entries", [])
	if entries.is_empty():
		_tree_summary.text = "没有可显示的节点" if not bool(result.get("ok", false)) else "场景为空"
		return
	var items := {}
	for entry in entries:
		var path := str(entry.get("path", ""))
		var parent_path := str(entry.get("parentPath", ""))
		var item: TreeItem
		if items.has(parent_path):
			item = _tree.create_item(items[parent_path])
		else:
			item = _tree.create_item()
		items[path] = item
		var text := "%s  (%s)" % [str(entry.get("name", "")), str(entry.get("type", ""))]
		if bool(entry.get("isInstance", false)):
			text += "  [实例]"
		item.set_text(0, text)
		item.set_tooltip_text(0, "%s\n%s%s" % [
			path,
			"脚本：" + str(entry.get("scriptPath", "")) + "\n" if str(entry.get("scriptPath", "")) != "" else "",
			"实例场景：" + str(entry.get("instanceScenePath", "")) if str(entry.get("instanceScenePath", "")) != "" else "",
		])
		item.set_metadata(0, path)
		item.collapsed = int(entry.get("depth", 0)) >= TREE_AUTO_EXPAND_DEPTH
	_tree_summary.text = "共 %d 个节点（已遍历 %d，最多 %d）%s" % [
		int(result.get("stats", {}).get("nodeCount", 0)),
		entries.size(),
		int(tree_data.get("maxNodes", 0)),
		"· 已截断" if bool(tree_data.get("truncated", false)) else "",
	]


func _apply_selection(selection: Dictionary) -> void:
	var count := int(selection.get("count", 0))
	_selection_summary.text = "当前选择数量：%d" % count
	if count == 0:
		_selection_label.text = "当前没有选中对象"
		return
	var lines := PackedStringArray()
	var index := 0
	for node in selection.get("nodes", []):
		index += 1
		if not bool(node.get("isValid", false)):
			lines.append("[%d] 已失效的对象引用" % index)
			continue
		lines.append("[%d] %s（%s）" % [index, str(node.get("name", "")), str(node.get("type", ""))])
		lines.append("    路径：%s" % str(node.get("path", "")))
		lines.append("    场景：%s" % str(node.get("scenePath", "")))
		lines.append("    脚本：%s" % (str(node.get("scriptPath", "")) if str(node.get("scriptPath", "")) != "" else "（无）"))
		if not bool(node.get("inEditedScene", false)):
			lines.append("    注意：该对象不在当前编辑场景内")
	_selection_label.text = "\n".join(lines)


func _apply_signals(signals: Dictionary) -> void:
	_signal_tree.clear()
	_signal_summary.text = "自定义信号 %d · 内置信号 %d · 场景连接 %d · 运行时连接 %d%s%s" % [
		int(signals.get("declaredCustom", 0)),
		int(signals.get("declaredBuiltin", 0)),
		int(signals.get("connectionsPersistent", 0)),
		int(signals.get("connectionsRuntime", 0)),
		"· 已忽略 %d 条编辑器内部连接" % int(signals.get("skippedEditorConnections", 0)) if int(signals.get("skippedEditorConnections", 0)) > 0 else "",
		"· 已截断" if bool(signals.get("truncated", false)) else "",
	]
	var nodes: Array = signals.get("nodes", [])
	if nodes.is_empty():
		var empty_item := _signal_tree.create_item()
		empty_item.set_text(0, "当前场景没有自定义信号或信号连接")
		return
	for node in nodes:
		var node_item := _signal_tree.create_item()
		node_item.set_text(0, "%s（%s）" % [str(node.get("name", "")), str(node.get("type", ""))])
		node_item.set_tooltip_text(0, str(node.get("path", "")))
		for signal_info in node.get("signals", []):
			var args: Array = signal_info.get("args", [])
			var arg_text := PackedStringArray()
			for arg in args:
				arg_text.append("%s: %s" % [str(arg.get("name", "")), str(arg.get("type", ""))])
			var signal_item := _signal_tree.create_item(node_item)
			signal_item.set_text(0, "%s(%s)%s" % [
				str(signal_info.get("name", "")),
				", ".join(arg_text),
				"" if bool(signal_info.get("custom", false)) else "  [内置]",
			])
			var connections: Array = signal_info.get("connections", [])
			if connections.is_empty():
				var none_item := _signal_tree.create_item(signal_item)
				none_item.set_text(0, "（已声明，未连接）")
				none_item.set_custom_color(0, UiKit.COLOR_MUTED)
				continue
			for connection in connections:
				var target := str(connection.get("target", ""))
				if target == "":
					target = "（场景外对象）"
				var connection_item := _signal_tree.create_item(signal_item)
				connection_item.set_text(0, "→ %s.%s %s" % [
					target,
					str(connection.get("method", "")),
					"（持久连接）" if bool(connection.get("persistent", false)) else "（运行时连接）",
				])
				if not bool(connection.get("valid", true)):
					connection_item.set_custom_color(0, UiKit.COLOR_ERROR)


func _apply_groups(groups: Dictionary) -> void:
	_group_tree.clear()
	_group_summary.text = "分组 %d 个 · 成员关系 %d 条%s" % [
		int(groups.get("groupCount", 0)),
		int(groups.get("memberLinks", 0)),
		"· 已忽略 %d 个编辑器内部组" % int(groups.get("internalGroupCount", 0)) if int(groups.get("internalGroupCount", 0)) > 0 else "",
	]
	var group_list: Array = groups.get("groups", [])
	if group_list.is_empty():
		var empty_item := _group_tree.create_item()
		empty_item.set_text(0, "当前场景没有使用任何分组")
		return
	for group in group_list:
		var group_item := _group_tree.create_item()
		group_item.set_text(0, "%s（%d）" % [str(group.get("name", "")), int(group.get("count", 0))])
		for member in group.get("members", []):
			var member_item := _group_tree.create_item(group_item)
			member_item.set_text(0, str(member))


func _apply_stats(result: Dictionary) -> void:
	var stats: Dictionary = result.get("stats", {})
	var lines := PackedStringArray()
	lines.append("节点总数：%d（含内部节点 %d）" % [
		int(stats.get("nodeCount", 0)), int(stats.get("nodeCountIncludingInternal", 0))
	])
	lines.append("已遍历节点：%d" % int(stats.get("traversedNodes", 0)))
	lines.append("节点类型：%d 种" % int(stats.get("typeCount", 0)))
	lines.append("实例化子场景：%d 个" % int(stats.get("instanceCount", 0)))
	lines.append("信号声明：自定义 %d · 内置 %d" % [
		int(stats.get("customSignalCount", 0)), int(stats.get("builtinSignalCount", 0))
	])
	lines.append("信号连接：持久 %d · 运行时 %d" % [
		int(stats.get("persistentConnectionCount", 0)), int(stats.get("runtimeConnectionCount", 0))
	])
	lines.append("分组：%d 个" % int(stats.get("groupCount", 0)))
	_stats_label.text = "\n".join(lines)
	var type_lines := PackedStringArray()
	for entry in stats.get("typeCounts", []):
		type_lines.append("%-24s %d" % [str(entry.get("type", "")), int(entry.get("count", 0))])
	_type_label.text = "节点类型分布：\n" + "\n".join(type_lines) if not type_lines.is_empty() else "节点类型分布：—"


func _set_value(target: Dictionary, key: String, value: String) -> void:
	if target.has(key) and target[key] != null:
		target[key].text = value if value != "" else "—"
