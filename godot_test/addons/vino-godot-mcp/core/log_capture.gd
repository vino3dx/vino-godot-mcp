@tool
extends Logger

## 引擎日志订阅者（Godot 4.6 起 OS.add_logger / remove_logger 可脚本调用）。
##
## 只回灌 Error / Warning：
##   - _log_error  → level="error"（含 function/file/line/code/rationale/editorNotify）
##   - _log_message 且 error=true → level="warning"
##   - 普通 print 不进入事件流：编辑器里 print 的量级太大，会把真正的错误淹掉。
##
## 两条硬约束：
##   1. 绝不能在这些回调里 print()——Logger 本身就是 stdout 的订阅者，会自激递归。
##   2. 本插件自己的日志（"[Vino Godot MCP] ..."）要过滤，否则插件输出会被当成用户错误。

const SELF_PREFIX := "[Vino Godot MCP]"
const MAX_MESSAGE_CHARS := 4096
## 每秒最多回灌多少条：脚本在 _process 里刷错误时，环形缓冲不该被一个人占满。
const MAX_PER_SECOND := 100

## 回调：Callable(Dictionary) → 交给 EventHub。
var sink := Callable()

var _installed := false
var _window_start_ms := 0
var _window_count := 0
var _suppressed := 0
var _unavailable_reason := ""


func install() -> Dictionary:
	if _installed:
		return {"installed": true, "already": true}
	if not OS.has_method("add_logger"):
		_unavailable_reason = "OS.add_logger is unavailable in this Godot build"
		return {"installed": false, "reason": _unavailable_reason}
	OS.add_logger(self)
	_installed = true
	return {"installed": true, "already": false}


func uninstall() -> void:
	if not _installed:
		return
	OS.remove_logger(self)
	_installed = false


func is_installed() -> bool:
	return _installed


func state() -> Dictionary:
	return {
		"installed": _installed,
		"suppressed": _suppressed,
		"streams": "error+warning only (plain print output is not streamed)",
		"scope": "the whole Godot editor process (editor code and scripts run inside it)",
		"reason": _unavailable_reason,
	}


# ---------------------------------------------------------------- Logger virtuals
# 参数不加类型：这些是引擎虚函数，放宽类型可以避免签名不匹配导致回调不触发。

func _log_error(function, file, line, code, rationale, editor_notify, error_type, script_backtraces) -> void:
	var message := str(rationale)
	if message == "":
		message = str(code)
	_forward({
		"level": "error",
		"message": message,
		"function": str(function),
		"file": str(file),
		"line": int(line),
		"code": str(code),
		"editorNotify": bool(editor_notify),
		"errorType": int(error_type),
	})


func _log_message(message, error) -> void:
	if not bool(error):
		return
	_forward({"level": "warning", "message": str(message)})


# ---------------------------------------------------------------- internals

func _forward(entry: Dictionary) -> void:
	if not sink.is_valid():
		return
	var text := str(entry.get("message", ""))
	if text.contains(SELF_PREFIX):
		return
	entry["message"] = _clip(text)
	entry["source"] = "godot_editor_process"
	if not _allow():
		_suppressed += 1
		return
	if _suppressed > 0:
		sink.call({
			"level": "warning",
			"message": "%d log entries were suppressed by the bridge rate limit (%d/s)" % [_suppressed, MAX_PER_SECOND],
			"source": "godot_editor_process",
			"generated": true,
		})
		_suppressed = 0
	sink.call(entry)


func _allow() -> bool:
	var now := Time.get_ticks_msec()
	if now - _window_start_ms >= 1000:
		_window_start_ms = now
		_window_count = 0
	_window_count += 1
	return _window_count <= MAX_PER_SECOND


func _clip(text: String) -> String:
	if text.length() <= MAX_MESSAGE_CHARS:
		return text
	return text.substr(0, MAX_MESSAGE_CHARS) + "…(truncated)"
