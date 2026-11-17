# T028 真实引擎探针:由 tests/projectInit.real.test.ts 复制进刚初始化的工程根,
# 让引擎自己回答"刚写下的 project.godot 是否真的被读成了这些 ProjectSettings"。
# 用法:godot --headless --path <project> --script res://t28_verify_settings.gd
extends SceneTree


func _initialize() -> void:
	print("T28_NAME=", ProjectSettings.get_setting("application/config/name"))
	print("T28_MAIN=", ProjectSettings.get_setting("application/run/main_scene"))
	print("T28_RENDERER=", ProjectSettings.get_setting("rendering/renderer/rendering_method"))
	quit(0)
