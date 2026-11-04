@tool
extends RefCounted

## 项目上下文采集（只读）。
## 数据全部来自 ProjectSettings / Engine / OS，不解析 .tscn，也不猜路径。


static func collect() -> Dictionary:
	var project_path := ProjectSettings.globalize_path("res://")
	var project_file := project_path.path_join("project.godot")
	var features = ProjectSettings.get_setting("application/config/features", [])
	var feature_list := []
	if features is PackedStringArray or features is Array:
		for feature in features:
			feature_list.append(str(feature))
	var version_info := Engine.get_version_info()
	return {
		"name": str(ProjectSettings.get_setting("application/config/name", "")),
		"projectPath": project_path,
		"projectFile": project_file,
		"projectFileExists": FileAccess.file_exists(project_file),
		"godotVersion": str(version_info.get("string", "unknown")),
		"godotVersionNumber": "%d.%d.%d" % [
			int(version_info.get("major", 0)), int(version_info.get("minor", 0)), int(version_info.get("patch", 0))
		],
		"godotBuild": str(version_info.get("status", "")),
		"mainScene": str(ProjectSettings.get_setting("application/run/main_scene", "")),
		"renderer": str(ProjectSettings.get_setting("rendering/renderer/rendering_method", "")),
		"rendererMobile": str(ProjectSettings.get_setting("rendering/renderer/rendering_method.mobile", "")),
		"features": feature_list,
		"isEditorHint": Engine.is_editor_hint(),
	}
