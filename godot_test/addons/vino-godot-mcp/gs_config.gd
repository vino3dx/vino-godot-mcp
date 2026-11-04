@tool
extends RefCounted

## Godot 可执行文件解析 + Agent MCP 配置 JSON 生成/校验 + MCP 客户端配置目录识别。
##
## 关于 Godot 路径（实测 Godot 4.6.3）：
## - OS.get_executable_path() 在编辑器插件里返回当前运行中的 Godot 编辑器可执行文件。
## - Windows 官方发行版同时提供 <name>.exe 与 <name>_console.exe；
##   MCP Server 走命令行 stdio，优先用 console 版本。
## - Godot 安装路径 ≠ 项目路径；这里只处理编辑器可执行文件，不碰 project.godot。

const REPO_URL := "https://github.com/vino3dx/vino-godot-mcp"
const SERVER_NAME := "vino-godot-mcp"
const SETTINGS_KEY_MANUAL_PATH := "vino_godot_mcp/godot_console_path"


## 解析可用于 MCP Server 的 Godot 可执行文件路径。
## settings 可为 null（非编辑器环境）；editor_exe_path 通常传 OS.get_executable_path()。
static func resolve_godot_executable(settings, editor_exe_path: String) -> Dictionary:
	var candidates: Array = []
	var manual := ""
	if settings != null and settings.has_setting(SETTINGS_KEY_MANUAL_PATH):
		manual = str(settings.get_setting(SETTINGS_KEY_MANUAL_PATH))
	if manual != "":
		candidates.append({
			"path": manual,
			"source": "manual",
			"exists": FileAccess.file_exists(manual),
		})
	for candidate in console_candidates(editor_exe_path):
		candidates.append({
			"path": candidate,
			"source": "editor_process",
			"exists": FileAccess.file_exists(candidate),
		})
	for entry in candidates:
		if bool(entry["exists"]):
			var note := _source_note(str(entry["source"]))
			if manual != "" and str(entry["source"]) != "manual":
				# 手动路径已失效也不能静默忽略：说清楚当前实际用的是哪个路径。
				note = "手动设置的路径不存在（%s），已改用当前编辑器进程的路径。%s" % [manual, note]
			return {
				"ok": true,
				"console_path": str(entry["path"]),
				"editor_path": editor_exe_path,
				"source": str(entry["source"]),
				"manual_path": manual,
				"candidates": candidates,
				"error": "",
				"note": note,
			}
	var error := ""
	if editor_exe_path == "":
		error = "无法获取当前 Godot 编辑器的可执行文件路径（OS.get_executable_path() 返回空）。"
	elif platform_id() == "windows":
		error = "没有在编辑器可执行文件旁边找到 Console 版本（godot.console.exe / godot_console.exe），不会猜测路径。请手动选择。"
	else:
		error = "当前编辑器可执行文件不存在或不可访问：%s" % editor_exe_path
	if manual != "":
		error = "手动设置的路径不存在：%s。%s" % [manual, error]
	return {
		"ok": false,
		"console_path": "",
		"editor_path": editor_exe_path,
		"source": "",
		"manual_path": manual,
		"candidates": candidates,
		"error": error,
		"note": "",
	}


## 从编辑器可执行文件推导候选路径（只推导、不假设、逐个校验存在性）。
static func console_candidates(editor_exe_path: String) -> PackedStringArray:
	var out := PackedStringArray()
	if editor_exe_path == "":
		return out
	if platform_id() != "windows":
		# macOS: /Applications/Godot.app/Contents/MacOS/Godot；Linux: 单一二进制。本身就是命令行入口。
		out.append(editor_exe_path)
		return out
	var lower := editor_exe_path.to_lower()
	if lower.ends_with("_console.exe") or lower.ends_with(".console.exe"):
		out.append(editor_exe_path)
		return out
	var base := editor_exe_path
	if lower.ends_with(".exe"):
		base = editor_exe_path.substr(0, editor_exe_path.length() - 4)
	out.append(base + "_console.exe")
	out.append(base + ".console.exe")
	return out


static func clear_manual_path(settings) -> void:
	if settings == null:
		return
	settings.set_setting(SETTINGS_KEY_MANUAL_PATH, "")
	settings.save()


## Windows 下把正斜杠转成反斜杠，让 JSON 里呈现原生路径（转义交给 JSON.stringify）。
static func native_path(path: String) -> String:
	if platform_id() == "windows":
		return path.replace("/", "\\")
	return path


static func platform_id() -> String:
	match OS.get_name():
		"Windows":
			return "windows"
		"macOS":
			return "macos"
		"Linux":
			return "linux"
	return OS.get_name().to_lower()


# ---------------------------------------------------------------- Agent 配置 JSON

## 用 Dictionary 构建配置，再用 JSON.stringify 序列化；不做任何手工字符串拼接或反斜杠替换。
static func build_agent_config(godot_path: String) -> Dictionary:
	if godot_path == "":
		return {"ok": false, "error": "GODOT_PATH 为空：需要先确定 Godot Console 可执行文件路径。", "text": "", "config": {}}
	var config := {
		"mcpServers": {
			"vino-godot-mcp": {
				"command": "npx",
				"args": ["-y", "vino-godot-mcp"],
				"env": {
					"GODOT_PATH": godot_path,
					"VINO_GODOT_MCP_LOG": "debug",
				},
			},
		},
	}
	var text := JSON.stringify(config, "  ", false)
	var check := validate_agent_config(text, godot_path)
	if not bool(check.get("ok", false)):
		return {"ok": false, "error": "生成的 JSON 自检失败：%s" % str(check.get("error", "")), "text": text, "config": config}
	return {"ok": true, "error": "", "text": text, "config": config}


## 把生成的文本重新解析一遍并逐字段比对，确保是合法 JSON 且结构与约定一致。
static func validate_agent_config(text: String, expected_godot_path: String) -> Dictionary:
	if text.strip_edges() == "":
		return {"ok": false, "error": "内容为空"}
	var parsed = JSON.parse_string(text)
	if parsed == null:
		return {"ok": false, "error": "JSON.parse_string 解析失败"}
	if not parsed is Dictionary:
		return {"ok": false, "error": "顶层不是 JSON 对象"}
	var servers = parsed.get("mcpServers", null)
	if not servers is Dictionary:
		return {"ok": false, "error": "缺少 mcpServers 对象"}
	var entry = servers.get(SERVER_NAME, null)
	if not entry is Dictionary:
		return {"ok": false, "error": "缺少 mcpServers.%s" % SERVER_NAME}
	if str(entry.get("command", "")) != "npx":
		return {"ok": false, "error": "command 必须是 npx"}
	var args = entry.get("args", null)
	if not args is Array or args.size() != 2:
		return {"ok": false, "error": "args 必须是 [\"-y\", \"vino-godot-mcp\"]"}
	if str(args[0]) != "-y" or str(args[1]) != "vino-godot-mcp":
		return {"ok": false, "error": "args 内容与约定不一致"}
	var env = entry.get("env", null)
	if not env is Dictionary:
		return {"ok": false, "error": "缺少 env 对象"}
	if str(env.get("GODOT_PATH", "")) != expected_godot_path:
		return {"ok": false, "error": "GODOT_PATH 与检测到的路径不一致"}
	if str(env.get("VINO_GODOT_MCP_LOG", "")) != "debug":
		return {"ok": false, "error": "VINO_GODOT_MCP_LOG 必须是 debug"}
	return {"ok": true, "error": "", "godot_path": str(env.get("GODOT_PATH", ""))}


# ---------------------------------------------------------------- MCP 客户端配置目录

## 只返回本机真实存在的目录；识别不到就返回空数组（不猜路径）。
static func detect_agent_dirs() -> Array:
	var out: Array = []
	var home := _normalize_path(OS.get_environment("USERPROFILE"))
	if home == "":
		home = _normalize_path(OS.get_environment("HOME"))
	var appdata := _normalize_path(OS.get_environment("APPDATA"))
	var local_appdata := _normalize_path(OS.get_environment("LOCALAPPDATA"))
	var platform := platform_id()
	var candidates: Array = []
	if platform == "windows":
		if appdata != "":
			candidates.append({"name": "Claude Desktop", "dir": appdata.path_join("Claude")})
			candidates.append({"name": "Visual Studio Code", "dir": appdata.path_join("Code").path_join("User")})
		if local_appdata != "":
			candidates.append({"name": "Cursor (Local)", "dir": local_appdata.path_join("Programs").path_join("cursor")})
	elif platform == "macos":
		if home != "":
			candidates.append({"name": "Claude Desktop", "dir": home.path_join("Library").path_join("Application Support").path_join("Claude")})
			candidates.append({"name": "Visual Studio Code", "dir": home.path_join("Library").path_join("Application Support").path_join("Code").path_join("User")})
	else:
		if home != "":
			candidates.append({"name": "Claude Desktop", "dir": home.path_join(".config").path_join("Claude")})
			candidates.append({"name": "Visual Studio Code", "dir": home.path_join(".config").path_join("Code").path_join("User")})
	if home != "":
		candidates.append({"name": "Cursor", "dir": home.path_join(".cursor")})
		candidates.append({"name": "CodeBuddy", "dir": home.path_join(".codebuddy")})
	for entry in candidates:
		var dir := str(entry["dir"])
		if DirAccess.dir_exists_absolute(dir):
			out.append({"name": str(entry["name"]), "dir": dir})
	return out


## 环境变量里的 Windows 路径统一成 Godot 惯用的正斜杠形式，避免出现 "C:\Users\x/.cursor"。
static func _normalize_path(path: String) -> String:
	var text := path.replace("\\", "/")
	while text.ends_with("/"):
		text = text.substr(0, text.length() - 1)
	return text


static func _source_note(source: String) -> String:
	match source:
		"manual":
			return "手动指定的路径（已保存到编辑器设置）。"
		"editor_process":
			return "来自当前编辑器进程的可执行文件路径，并已校验文件存在。"
	return ""
