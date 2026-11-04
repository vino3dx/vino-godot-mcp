@tool
extends RefCounted

## Node.js / npm 环境探测、MCP 包安装、Node.js 官方安装包解析与下载。
##
## 这里的函数都只在后台线程里被调用：不得访问 EditorInterface、不得触碰任何 UI 节点。
## 所有命令一律以「程序 + 参数数组」方式执行，不拼接 shell 字符串。
##
## 实测结论（Godot 4.6.3 / Windows 11）：
## - OS.execute("node", ["--version"]) 可用（node.exe 在 PATH 中）。
## - OS.execute("npm", [...]) 返回 -1：Windows 上 npm 是 .cmd，必须经 cmd.exe 调用。
## - OS.execute 没有工作目录参数，因此 npm 安装用 --prefix 指向插件专用目录。

const GsShell := preload("gs_shell.gd")

const PACKAGE_NAME := "vino-godot-mcp"
const SERVER_NAME := "vino-godot-mcp"
const NODE_MIN_MAJOR := 22

const OFFICIAL_SITE := "https://nodejs.org/"
const OFFICIAL_DOWNLOAD_PAGE := "https://nodejs.org/en/download"
const DIST_INDEX_URL := "https://nodejs.org/dist/index.json"
const DIST_ROOT := "https://nodejs.org/dist"


static func platform_id() -> String:
	match OS.get_name():
		"Windows":
			return "windows"
		"macOS":
			return "macos"
		"Linux":
			return "linux"
	return OS.get_name().to_lower()


static func arch_id() -> String:
	match platform_id():
		"windows":
			var arch := OS.get_environment("PROCESSOR_ARCHITECTURE").to_lower()
			if arch == "":
				arch = OS.get_environment("PROCESSOR_ARCHITEW6432").to_lower()
			if arch.contains("arm64"):
				return "arm64"
			return "x64"
		"macos", "linux":
			var res := GsShell.execute("uname", PackedStringArray(["-m"]), false)
			var machine := str(res["output"]).strip_edges().to_lower()
			if machine == "arm64" or machine == "aarch64":
				return "arm64"
			return "x64"
	return "x64"


## MCP 包安装目录：放在 Godot 用户数据目录下的插件专属目录，避免污染 Godot 项目目录。
static func install_dir() -> String:
	return OS.get_data_dir().path_join("vino-godot-mcp").path_join("mcp-server")


static func installer_dir() -> String:
	return OS.get_temp_dir().path_join("vino-godot-mcp")


# ---------------------------------------------------------------- Node.js / npm 检测

static func detect() -> Dictionary:
	var node := probe_node()
	var npm := probe_npm(node)
	var node_found := bool(node.get("found", false))
	var npm_found := bool(npm.get("found", false))
	var major := _major_of(str(node.get("version", "")))
	return {
		"ok": node_found and npm_found,
		"platform": platform_id(),
		"arch": arch_id(),
		"node": node,
		"npm": npm,
		"needs_install": not node_found,
		"below_minimum": node_found and major > 0 and major < NODE_MIN_MAJOR,
		"minimum_major": NODE_MIN_MAJOR,
	}


static func probe_node() -> Dictionary:
	var out := {
		"found": false,
		"version": "",
		"path": "",
		"in_path": false,
		"source": "",
		"error": "",
		"note": "",
	}
	var res := GsShell.execute("node", PackedStringArray(["--version"]), true)
	var version := _first_version(str(res["output"]))
	if int(res["exit_code"]) == 0 and version != "":
		out["found"] = true
		out["version"] = version
		out["in_path"] = true
		out["source"] = "PATH"
		out["path"] = _which("node")
		if str(out["path"]) == "":
			out["note"] = "node 可以执行，但 where/which 未能返回绝对路径。"
		return out
	out["error"] = _describe_failure(res, "node")
	# PATH 里没有：再检查常见安装目录，用来区分「没装」和「装了但 PATH 没刷新」。
	for candidate in _common_node_candidates():
		if not FileAccess.file_exists(candidate):
			continue
		var res2 := GsShell.execute(candidate, PackedStringArray(["--version"]), true)
		var version2 := _first_version(str(res2["output"]))
		if int(res2["exit_code"]) == 0 and version2 != "":
			out["found"] = true
			out["version"] = version2
			out["path"] = candidate
			out["in_path"] = false
			out["source"] = "common_path"
			out["error"] = ""
			out["note"] = "Node.js 已安装但不在 Godot 的 PATH 中（常见于安装后未重启 Godot）。"
			return out
	return out


static func probe_npm(node: Dictionary) -> Dictionary:
	var out := {
		"found": false,
		"version": "",
		"path": "",
		"error": "",
		"note": "",
	}
	var res := _run_npm(PackedStringArray(["--version"]))
	var version := _first_version(str(res["output"]))
	if int(res["exit_code"]) == 0 and version != "":
		out["found"] = true
		out["version"] = version
		out["path"] = _which("npm", PackedStringArray([".cmd", ".exe"]))
		return out
	out["error"] = _describe_failure(res, "npm")
	var node_path := str(node.get("path", ""))
	if node_path == "":
		return out
	var node_dir := node_path.get_base_dir()
	for name in ["npm.cmd", "npm.exe", "npm"]:
		var candidate := node_dir.path_join(name)
		if not FileAccess.file_exists(candidate):
			continue
		var res2 := _run_npm(PackedStringArray(["--version"]), candidate)
		var version2 := _first_version(str(res2["output"]))
		if int(res2["exit_code"]) == 0 and version2 != "":
			out["found"] = true
			out["version"] = version2
			out["path"] = candidate
			out["error"] = ""
			out["note"] = "npm 与 node 位于同一目录。"
			return out
		out["error"] = _describe_failure(res2, "npm")
	return out


static func _common_node_candidates() -> PackedStringArray:
	var out := PackedStringArray()
	match platform_id():
		"windows":
			for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]:
				var root := OS.get_environment(key)
				if root == "":
					continue
				var base := root.replace("\\", "/")
				if key == "LOCALAPPDATA":
					out.append(base.path_join("Programs").path_join("nodejs").path_join("node.exe"))
				else:
					out.append(base.path_join("nodejs").path_join("node.exe"))
			var appdata := OS.get_environment("APPDATA")
			if appdata != "":
				out.append(appdata.replace("\\", "/").path_join("npm").path_join("node.exe"))
		"macos":
			out.append("/usr/local/bin/node")
			out.append("/opt/homebrew/bin/node")
			out.append("/usr/bin/node")
		"linux":
			out.append("/usr/bin/node")
			out.append("/usr/bin/nodejs")
			out.append("/usr/local/bin/node")
			out.append("/snap/bin/node")
	return out


# ---------------------------------------------------------------- MCP 包安装

## 安装命令固定为 npm i vino-godot-mcp；因为 OS.execute 没有工作目录参数，
## 用 --prefix 把落点指向插件专用目录（不会写进 Godot 项目目录）。
static func install_npm_args() -> PackedStringArray:
	return PackedStringArray(["i", PACKAGE_NAME, "--prefix", install_dir()])


static func install_mcp_package() -> Dictionary:
	var dir := install_dir()
	var dir_error := GsShell.ensure_dir(dir)
	if dir_error != "":
		return {
			"ok": false,
			"exit_code": -1,
			"output": "",
			"verified": false,
			"version": "",
			"install_dir": dir,
			"package_dir": dir.path_join("node_modules").path_join(PACKAGE_NAME),
			"error": dir_error,
		}
	var res := _run_npm(install_npm_args())
	var verified := read_installed_package()
	var ok := int(res["exit_code"]) == 0 and bool(verified["found"])
	var error := ""
	if int(res["exit_code"]) != 0:
		error = "npm 安装命令失败（退出码 %d）" % int(res["exit_code"])
	elif not bool(verified["found"]):
		error = "npm 退出码为 0，但没有在 %s 找到 %s（不能只凭退出码判定成功）。%s" % [
			dir, PACKAGE_NAME, str(verified.get("error", ""))
		]
	return {
		"ok": ok,
		"exit_code": int(res["exit_code"]),
		"output": str(res["output"]),
		"verified": bool(verified["found"]),
		"version": str(verified.get("version", "")),
		"install_dir": dir,
		"package_dir": dir.path_join("node_modules").path_join(PACKAGE_NAME),
		"error": error,
	}


## 检查已安装的包是否真实存在（读 node_modules/vino-godot-mcp/package.json）。
static func read_installed_package() -> Dictionary:
	var package_dir := install_dir().path_join("node_modules").path_join(PACKAGE_NAME)
	var manifest := package_dir.path_join("package.json")
	if not FileAccess.file_exists(manifest):
		return {"found": false, "version": "", "path": package_dir, "error": ""}
	var f := FileAccess.open(manifest, FileAccess.READ)
	if f == null:
		return {
			"found": false,
			"version": "",
			"path": package_dir,
			"error": "无法读取 %s（%s）" % [manifest, error_string(FileAccess.get_open_error())],
		}
	var text := f.get_as_text()
	f.close()
	var data = JSON.parse_string(text)
	if not data is Dictionary:
		return {"found": false, "version": "", "path": package_dir, "error": "%s 不是合法 JSON" % manifest}
	if str(data.get("name", "")) != PACKAGE_NAME:
		return {
			"found": false,
			"version": "",
			"path": package_dir,
			"error": "%s 中的 name 不是 %s" % [manifest, PACKAGE_NAME],
		}
	return {"found": true, "version": str(data.get("version", "")), "path": package_dir, "error": ""}


# ---------------------------------------------------------------- Node.js 安装包

## 解析官方最新 LTS 安装包（网络操作，必须在后台线程执行）。
## 文件名与 SHA-256 都来自 nodejs.org 官方的 index.json / SHASUMS256.txt，不靠拼字符串猜。
static func resolve_node_install_plan() -> Dictionary:
	var platform := platform_id()
	var arch := arch_id()
	var plan := {
		"ok": false,
		"supported": false,
		"manual_only": false,
		"platform": platform,
		"arch": arch,
		"version": "",
		"filename": "",
		"url": "",
		"sha256": "",
		"kind": "",
		"instructions": "",
		"error": "",
		"source": OFFICIAL_DOWNLOAD_PAGE,
	}
	if platform == "linux":
		plan["manual_only"] = true
		plan["error"] = "Linux 不提供官方图形安装包，需要手动安装"
		plan["instructions"] = "Linux 没有官方的一键图形安装包。请用发行版包管理器安装 Node.js %d 或更新版本：\n\n  Debian/Ubuntu:  sudo apt install nodejs npm\n  Fedora:         sudo dnf install nodejs npm\n  Arch:           sudo pacman -S nodejs npm\n\n或从官方下载页获取二进制包：\n%s" % [NODE_MIN_MAJOR, OFFICIAL_DOWNLOAD_PAGE]
		return plan
	var index := _fetch_json(DIST_INDEX_URL)
	if not bool(index.get("ok", false)):
		plan["error"] = str(index.get("error", "无法读取 %s" % DIST_INDEX_URL))
		plan["instructions"] = "无法访问 Node.js 官方版本索引，请从官方下载页手动下载安装：\n%s" % OFFICIAL_DOWNLOAD_PAGE
		return plan
	var entry := _pick_latest_lts(index.get("data"))
	if entry.is_empty():
		plan["error"] = "未能从 %s 找到 LTS 版本" % DIST_INDEX_URL
		return plan
	var version := str(entry.get("version", ""))
	plan["version"] = version
	var token := _artifact_token(platform, arch)
	var files: Array = entry.get("files", []) if entry.get("files", []) is Array else []
	if token == "" or not files.has(token):
		plan["manual_only"] = true
		plan["error"] = "官方没有为 %s / %s 提供图形安装包" % [platform, arch]
		plan["instructions"] = "Node.js %s 官方没有为 %s / %s 提供图形安装包，请从官方下载页手动安装：\n%s" % [
			version, platform, arch, OFFICIAL_DOWNLOAD_PAGE
		]
		return plan
	var shasums := _fetch_text("%s/%s/SHASUMS256.txt" % [DIST_ROOT, version])
	if not bool(shasums.get("ok", false)):
		plan["error"] = str(shasums.get("error", "无法读取官方 SHASUMS256.txt"))
		plan["instructions"] = "无法读取官方校验文件，请从官方下载页手动下载安装：\n%s" % OFFICIAL_DOWNLOAD_PAGE
		plan["manual_only"] = true
		return plan
	var picked := _pick_installer_line(str(shasums.get("text", "")), platform, arch)
	if picked.is_empty():
		plan["error"] = "官方 SHASUMS256.txt 中找不到 %s 安装包" % platform
		plan["manual_only"] = true
		plan["instructions"] = "未能确认官方安装包文件名，请从官方下载页手动下载安装：\n%s" % OFFICIAL_DOWNLOAD_PAGE
		return plan
	plan["ok"] = true
	plan["supported"] = true
	plan["filename"] = str(picked["filename"])
	plan["sha256"] = str(picked["sha256"])
	plan["kind"] = "msi" if platform == "windows" else "pkg"
	plan["url"] = "%s/%s/%s" % [DIST_ROOT, version, str(picked["filename"])]
	plan["instructions"] = _install_instructions(platform, version)
	return plan


## 下载并校验官方安装包（后台线程执行）。
static func download_node_installer(plan: Dictionary) -> Dictionary:
	var url := str(plan.get("url", ""))
	var filename := str(plan.get("filename", ""))
	if url == "" or filename == "":
		return {"ok": false, "error": "安装计划缺少官方下载地址，已中止。", "output": ""}
	if not url.begins_with(DIST_ROOT + "/"):
		return {"ok": false, "error": "下载地址不是 Node.js 官方 dist 渠道，已中止：%s" % url, "output": ""}
	var dir := installer_dir()
	var dir_error := GsShell.ensure_dir(dir)
	if dir_error != "":
		return {"ok": false, "error": dir_error, "output": ""}
	var target := dir.path_join(filename)
	var download := GsShell.download(url, target)
	if not bool(download.get("ok", false)):
		return {"ok": false, "error": str(download.get("error", "下载失败")), "output": str(download.get("output", ""))}
	var expected := str(plan.get("sha256", "")).to_lower()
	if expected != "":
		var actual := GsShell.sha256_file(target).to_lower()
		if actual != expected:
			DirAccess.remove_absolute(target)
			return {
				"ok": false,
				"error": "SHA-256 校验失败（期望 %s，实际 %s），已删除下载文件。" % [expected, actual],
				"output": "",
			}
	return {
		"ok": true,
		"path": target,
		"bytes": int(download.get("bytes", 0)),
		"sha256_verified": expected != "",
		"error": "",
		"output": "",
	}


static func _install_instructions(platform: String, version: String) -> String:
	if platform == "windows":
		return "即将下载 Node.js %s 官方 LTS 安装包（Windows MSI），下载完成后会调用系统默认方式启动安装向导。\n\n- 安装向导由 Windows 自己弹出，需要你手动确认（可能弹出 UAC 提权提示）。\n- 插件不会静默安装，也不会修改系统环境变量。\n- 安装完成后插件会自动重新检测 node / npm；若仍检测不到，请重启 Godot 让新的 PATH 生效。" % version
	return "即将下载 Node.js %s 官方 LTS 安装包（macOS PKG），下载完成后会启动系统安装器。\n\n- 安装器需要系统提权，请按系统提示完成安装。\n- 插件不会静默安装，也不会修改环境变量。\n- 安装完成后插件会自动重新检测 node / npm；若仍检测不到，请重启 Godot 让新的 PATH 生效。" % version


static func _pick_latest_lts(data) -> Dictionary:
	if not data is Array:
		return {}
	for entry in data:
		if not entry is Dictionary:
			continue
		# LTS 条目的 lts 字段是代号字符串；Current 版本为 false。
		if typeof(entry.get("lts", false)) == TYPE_STRING:
			return entry
	return {}


static func _artifact_token(platform: String, arch: String) -> String:
	match platform:
		"windows":
			return "win-%s-msi" % arch
		"macos":
			return "osx-%s-pkg" % arch
	return ""


static func _pick_installer_line(shasums_text: String, platform: String, arch: String) -> Dictionary:
	var extension := ".msi" if platform == "windows" else ".pkg"
	for raw_line in shasums_text.split("\n"):
		var parts := raw_line.strip_edges().split(" ", false)
		if parts.size() != 2:
			continue
		var filename := parts[1]
		var lower := filename.to_lower()
		if not lower.ends_with(extension):
			continue
		if arch == "arm64":
			if not lower.contains("arm64"):
				continue
		else:
			if lower.contains("arm64"):
				continue
			if platform == "windows" and not lower.contains("x64"):
				continue
		return {"sha256": parts[0].to_lower(), "filename": filename}
	return {}


# ---------------------------------------------------------------- 内部工具

static func _run_npm(extra_args: PackedStringArray, absolute_npm := "") -> Dictionary:
	# Windows：npm 是 .cmd 脚本，必须经 cmd.exe 调用（实测直接 OS.execute("npm") 返回 -1）。
	if platform_id() == "windows":
		var program := absolute_npm if absolute_npm != "" else "npm"
		var args := PackedStringArray(["/c", program])
		args.append_array(extra_args)
		return GsShell.execute("cmd.exe", args, true)
	var posix_program := absolute_npm if absolute_npm != "" else "npm"
	return GsShell.execute(posix_program, extra_args, true)


## Windows 的 where 会同时返回 npm、npm.cmd 等多个条目，按扩展名偏好挑一个。
static func _which(program: String, prefer_extensions := PackedStringArray()) -> String:
	var res: Dictionary
	if platform_id() == "windows":
		res = GsShell.execute("where.exe", PackedStringArray([program]), false)
	else:
		res = GsShell.execute("which", PackedStringArray([program]), false)
	if int(res["exit_code"]) != 0:
		return ""
	var found: Array = []
	for line in str(res["output"]).split("\n"):
		var text := line.strip_edges()
		if text != "":
			found.append(text)
	if found.is_empty():
		return ""
	for extension in prefer_extensions:
		for text in found:
			if str(text).to_lower().ends_with(str(extension)):
				return str(text)
	return str(found[0])


static func _describe_failure(res: Dictionary, what: String) -> String:
	if not bool(res.get("started", true)) or int(res.get("exit_code", 0)) == -1:
		return "Godot 无法启动 %s（可能未安装，或 PATH 尚未刷新）。" % what
	var output := str(res.get("output", "")).strip_edges()
	if output == "":
		return "%s 执行失败：退出码 %d，且没有输出。" % [what, int(res.get("exit_code", 0))]
	return "%s 执行失败：退出码 %d，输出：%s" % [what, int(res.get("exit_code", 0)), GsShell.tail(output, 600)]


static func _first_version(text: String) -> String:
	var re := RegEx.new()
	if re.compile("^\\s*v?(\\d+\\.\\d+(?:\\.\\d+)?)\\s*$") != OK:
		return ""
	for line in text.split("\n"):
		var match_result := re.search(line.strip_edges())
		if match_result != null:
			return match_result.get_string(1)
	return ""


static func _major_of(version: String) -> int:
	if version == "":
		return 0
	var first := version.split(".")[0]
	return int(first) if first.is_valid_int() else 0


static func _fetch_text(url: String) -> Dictionary:
	var dir := installer_dir()
	var dir_error := GsShell.ensure_dir(dir)
	if dir_error != "":
		return {"ok": false, "error": dir_error, "text": ""}
	var temp_path := dir.path_join("fetch-%d.tmp" % Time.get_ticks_usec())
	var download := GsShell.download(url, temp_path)
	if not bool(download.get("ok", false)):
		return {"ok": false, "error": str(download.get("error", "下载失败")), "text": ""}
	var f := FileAccess.open(temp_path, FileAccess.READ)
	if f == null:
		var open_error := error_string(FileAccess.get_open_error())
		DirAccess.remove_absolute(temp_path)
		return {"ok": false, "error": "无法读取下载结果（%s）" % open_error, "text": ""}
	var text := f.get_as_text()
	f.close()
	DirAccess.remove_absolute(temp_path)
	return {"ok": true, "error": "", "text": text}


static func _fetch_json(url: String) -> Dictionary:
	var fetched := _fetch_text(url)
	if not bool(fetched.get("ok", false)):
		return {"ok": false, "error": str(fetched.get("error", "")), "data": null}
	var data = JSON.parse_string(str(fetched.get("text", "")))
	if data == null:
		return {"ok": false, "error": "%s 的内容不是合法 JSON" % url, "data": null}
	return {"ok": true, "error": "", "data": data}
