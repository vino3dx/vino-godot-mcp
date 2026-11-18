extends SceneTree

## T5 补充:LogCapture 的真实引擎验证。
##
## 为什么不靠 T29:编辑器对脚本的解析是懒加载的,写坏一个 .gd 不会触发 reparse
## (实测 headless 编辑器 stderr 零输出),所以"等编辑器自己报错"在自动化环境里无法成立。
## 这里直接调用 Logger 回调,把订阅/分流/过滤三件事测死。

const LogCapture := preload("res://addons/vino-godot-mcp/core/log_capture.gd")

var fails := 0


func _check(name: String, ok: bool, extra: String = "") -> void:
	if ok:
		print("LOGPASS|" + name)
	else:
		fails += 1
		print("LOGFAIL|" + name + "|" + extra)


func _init() -> void:
	var captured: Array = []
	var lc = LogCapture.new()
	lc.sink = func(entry): captured.append(entry)

	var inst: Dictionary = lc.install()
	_check("install", inst.get("installed") == true, str(inst))
	_check("has_add_logger", OS.has_method("add_logger"), "OS.add_logger 不可脚本调用")

	push_error("PROBE_PLAIN_ERROR")
	push_warning("PROBE_PLAIN_WARNING")
	push_error("[Vino Godot MCP] 插件自身日志不得回灌")
	OS.delay_msec(400)

	# 三条 push,自身前缀那条必须被过滤,只剩两条。
	_check("self_prefix_filtered", captured.size() == 2, "got=" + str(captured.size()) + " " + JSON.stringify(captured))

	var first: Dictionary = captured[0] if captured.size() > 0 else {}
	var second: Dictionary = captured[1] if captured.size() > 1 else {}
	_check("error_message", str(first.get("message", "")).begins_with("PROBE_PLAIN_ERROR"), str(first))
	_check("warning_message", str(second.get("message", "")).begins_with("PROBE_PLAIN_WARNING"), str(second))

	# 分级:push_error → error,push_warning → warning(靠 Logger 的 error_type 分流)。
	_check("error_level", str(first.get("level", "")) == "error", str(first.get("level")))
	_check("warning_level", str(second.get("level", "")) == "warning", str(second.get("level")))
	_check("error_type_value", int(first.get("errorType", -1)) == 0, str(first.get("errorType")))
	_check("warning_type_value", int(second.get("errorType", -1)) == 1, str(second.get("errorType")))

	# 诊断上下文:函数/文件/行号必须带回来(T3 依赖它定位问题)。
	_check("source", str(first.get("source", "")) == "godot_editor_process", str(first.get("source")))
	_check("has_function", str(first.get("function", "")) != "", str(first.get("function")))
	_check("has_file", str(first.get("file", "")) != "", str(first.get("file")))
	_check("has_line", int(first.get("line", 0)) > 0, str(first.get("line")))

	var state: Dictionary = lc.state()
	_check("state_streams", str(state.get("streams", "")).contains("error+warning"), str(state))

	lc.uninstall()
	_check("uninstalled", lc.is_installed() == false, "")

	print("LOGSUMMARY|fails=" + str(fails))
	quit()
