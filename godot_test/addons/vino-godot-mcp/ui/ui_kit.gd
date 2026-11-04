@tool
extends RefCounted

## 「上下文」/「设置」两个页面共用的轻量 UI 组件。
##
## 设计约束沿用 Dock 的窄宽度要求：
## - 说明/数值文本一律自动换行，Label 不按文本长度撑宽面板；
## - 按钮行用 HFlowContainer，宽度不够时折行；
## - 卡片用半透明中性底色，浅色/深色编辑器主题下都能看清。

const COLOR_OK := Color("3fb950")
const COLOR_WARN := Color("d9a038")
const COLOR_ERROR := Color("e5534b")
const COLOR_MUTED := Color("98a2b3")
const COLOR_ACCENT := Color("2f6fd0")


static func icon(icon_name: String) -> Texture2D:
	if not Engine.is_editor_hint():
		return null
	var theme := EditorInterface.get_editor_theme()
	if theme != null and theme.has_icon(icon_name, "EditorIcons"):
		return theme.get_icon(icon_name, "EditorIcons")
	return null


static func mono_font() -> Font:
	if not Engine.is_editor_hint():
		return null
	var theme := EditorInterface.get_editor_theme()
	if theme != null and theme.has_font("source", "EditorFonts"):
		return theme.get_font("source", "EditorFonts")
	return null


static func card_style() -> StyleBoxFlat:
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


static func tree_style() -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.0, 0.0, 0.0, 0.16)
	style.set_corner_radius_all(6)
	style.content_margin_left = 4
	style.content_margin_right = 4
	style.content_margin_top = 4
	style.content_margin_bottom = 4
	return style


static func card(parent: Control, title: String, icon_name := "") -> VBoxContainer:
	var panel := PanelContainer.new()
	panel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	panel.add_theme_stylebox_override("panel", card_style())
	parent.add_child(panel)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 6)
	panel.add_child(box)
	var head := HBoxContainer.new()
	head.add_theme_constant_override("separation", 6)
	box.add_child(head)
	if icon_name != "":
		var texture := icon(icon_name)
		if texture != null:
			var texture_rect := TextureRect.new()
			texture_rect.texture = texture
			texture_rect.custom_minimum_size = Vector2(16, 16)
			texture_rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
			texture_rect.size_flags_vertical = Control.SIZE_SHRINK_CENTER
			head.add_child(texture_rect)
	var title_label := Label.new()
	title_label.text = title
	title_label.add_theme_font_size_override("font_size", 14)
	title_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	title_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	title_label.custom_minimum_size = Vector2.ZERO
	head.add_child(title_label)
	return box


static func label(parent: Control, text := "", color := Color.TRANSPARENT, font_size := 0) -> Label:
	var node := Label.new()
	node.text = text
	node.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	node.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	node.custom_minimum_size = Vector2.ZERO
	if color != Color.TRANSPARENT:
		node.add_theme_color_override("font_color", color)
	if font_size > 0:
		node.add_theme_font_size_override("font_size", font_size)
	parent.add_child(node)
	return node


## 键值对：键用小号灰字，值单独一行并自动换行（长路径不会撑宽面板）。
static func kv(parent: Control, key: String) -> Label:
	var key_label := label(parent, key, COLOR_MUTED, 11)
	key_label.autowrap_mode = TextServer.AUTOWRAP_OFF
	return label(parent, "—", Color.TRANSPARENT, 12)


static func button_row(parent: Control) -> HFlowContainer:
	var row := HFlowContainer.new()
	row.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_theme_constant_override("h_separation", 6)
	row.add_theme_constant_override("v_separation", 4)
	parent.add_child(row)
	return row


static func icon_button(text: String, icon_name: String, tooltip := "") -> Button:
	var button := Button.new()
	button.text = text
	if icon_name != "":
		var texture := icon(icon_name)
		if texture != null:
			button.icon = texture
	if tooltip != "":
		button.tooltip_text = tooltip
	return button


static func status_icon(color: Color, icon_name := "StatusSuccess") -> TextureRect:
	var rect := TextureRect.new()
	rect.custom_minimum_size = Vector2(16, 16)
	rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	rect.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	rect.modulate = color
	rect.texture = icon(icon_name)
	return rect


static func mono_label(parent: Control, text := "", font_size := 11) -> RichTextLabel:
	var rich := RichTextLabel.new()
	rich.bbcode_enabled = false
	rich.fit_content = false
	rich.scroll_active = true
	rich.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	rich.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	rich.custom_minimum_size = Vector2(0, 120)
	var font := mono_font()
	if font != null:
		rich.add_theme_font_override("normal_font", font)
	rich.add_theme_font_size_override("normal_font_size", font_size)
	rich.text = text
	parent.add_child(rich)
	return rich


static func tree(parent: Control, min_height := 180) -> Tree:
	var node := Tree.new()
	node.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	node.custom_minimum_size = Vector2(0, min_height)
	node.hide_root = false
	node.allow_reselect = true
	node.select_mode = Tree.SELECT_ROW
	node.add_theme_stylebox_override("panel", tree_style())
	parent.add_child(node)
	return node
