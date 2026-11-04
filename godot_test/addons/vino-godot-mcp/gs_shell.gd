@tool
extends Node

## 后台任务执行器（编辑器插件用）。
##
## 设计约束：
## - 主线程只做 UI；外部命令、下载、文件校验全部放到 Thread 里执行。
## - 工作线程只把结果写进 Mutex 保护的队列，由 _process 在主线程取走后再发信号，
##   因此工作线程永远不触碰 UI / EditorInterface。
## - OS.execute 没有超时参数，这里的"超时"只做可观测上报（elapsed），不强杀进程。

signal job_finished(token: String, result: Dictionary)

const MAX_OUTPUT_CHARS := 20000
const TAIL_CHARS := 4000

var _mutex := Mutex.new()
var _finished: Array = []
var _threads: Dictionary = {}
var _started_ms: Dictionary = {}
var _progress: Dictionary = {}
var _closing := false


func start_job(token: String, job: Callable) -> bool:
	if _closing:
		return false
	if not job.is_valid():
		push_error("Vino Godot MCP: 后台任务 '%s' 的 Callable 无效" % token)
		return false
	if _threads.has(token):
		push_warning("Vino Godot MCP: 后台任务 '%s' 仍在运行，忽略重复请求" % token)
		return false
	var thread := Thread.new()
	var err := thread.start(Callable(self, "_run_job").bind(token, job))
	if err != OK:
		push_error("Vino Godot MCP: 无法启动后台线程（%s）" % error_string(err))
		return false
	_threads[token] = thread
	_started_ms[token] = Time.get_ticks_msec()
	set_progress(token, "")
	return true


func is_running(token: String) -> bool:
	return _threads.has(token)


func elapsed_seconds(token: String) -> float:
	if not _started_ms.has(token):
		return 0.0
	return float(Time.get_ticks_msec() - int(_started_ms[token])) / 1000.0


## 供工作线程上报进度文本（加锁，主线程用 get_progress 读）。
func set_progress(token: String, text: String) -> void:
	_mutex.lock()
	_progress[token] = text
	_mutex.unlock()


func get_progress(token: String) -> String:
	_mutex.lock()
	var text: String = str(_progress.get(token, ""))
	_mutex.unlock()
	return text


func shutdown() -> void:
	if _closing:
		return
	_closing = true
	for key in _threads.keys():
		var thread: Thread = _threads[key]
		if thread != null and thread.is_alive():
			push_warning("Vino Godot MCP: 插件退出时仍在等待后台任务 '%s' 结束" % str(key))
			thread.wait_to_finish()
	_threads.clear()


func _run_job(token: String, job: Callable) -> void:
	var result = job.call()
	if not result is Dictionary:
		result = {"ok": false, "error": "后台任务 '%s' 没有返回有效结果" % token, "data": null}
	_mutex.lock()
	_finished.append({"token": token, "result": result})
	_mutex.unlock()


func _process(_delta: float) -> void:
	var pending: Array = []
	_mutex.lock()
	if not _finished.is_empty():
		pending = _finished
		_finished = []
	_mutex.unlock()
	for item in pending:
		var token := str(item["token"])
		_join(token)
		_mutex.lock()
		_progress.erase(token)
		_started_ms.erase(token)
		_mutex.unlock()
		job_finished.emit(token, item["result"])


func _join(token: String) -> void:
	var thread: Thread = _threads.get(token)
	if thread == null:
		return
	thread.wait_to_finish()
	_threads.erase(token)


# ---------------------------------------------------------------- 线程内可用的静态工具

## 执行一次外部命令并收集输出。
## 参数以 PackedStringArray 传递，绝不拼接 shell 字符串。
## 返回 started=false 表示 Godot 根本无法创建子进程（命令不存在 / 不可执行）。
static func execute(program: String, args: PackedStringArray, read_stderr := true) -> Dictionary:
	var output: Array = []
	var exit_code := OS.execute(program, args, output, read_stderr)
	var text := ""
	for entry in output:
		text += str(entry)
	return {
		"started": exit_code != -1,
		"exit_code": exit_code,
		"output": clip(text),
	}


static func clip(text: String, limit := MAX_OUTPUT_CHARS) -> String:
	if text.length() <= limit:
		return text
	return text.substr(0, limit) + "\n…(输出已截断，共 %d 字符)" % text.length()


static func tail(text: String, limit := TAIL_CHARS) -> String:
	if text.length() <= limit:
		return text
	return "…(仅显示最后 %d 字符)\n" % limit + text.substr(text.length() - limit)


## curl 只在固定官方 URL、固定输出路径下使用；找不到就明确报错，不退回 shell 拼接。
static func curl_path() -> String:
	if OS.get_name() == "Windows":
		var root := OS.get_environment("SystemRoot")
		if root != "":
			var candidate := root.replace("\\", "/").path_join("System32").path_join("curl.exe")
			if FileAccess.file_exists(candidate):
				return candidate
		if FileAccess.file_exists("C:/Windows/System32/curl.exe"):
			return "C:/Windows/System32/curl.exe"
		return ""
	var posix_candidates := ["/usr/bin/curl", "/bin/curl", "/usr/local/bin/curl", "/opt/homebrew/bin/curl"]
	for candidate in posix_candidates:
		if FileAccess.file_exists(candidate):
			return candidate
	return ""


static func download(url: String, target_path: String) -> Dictionary:
	var curl := curl_path()
	if curl == "":
		return {
			"ok": false,
			"code": "curl_missing",
			"error": "系统中找不到 curl，无法自动下载。请使用官方下载页手动安装。",
			"output": "",
		}
	var dir_err := ensure_dir(target_path.get_base_dir())
	if dir_err != "":
		return {"ok": false, "code": "mkdir_failed", "error": dir_err, "output": ""}
	if FileAccess.file_exists(target_path):
		DirAccess.remove_absolute(target_path)
	var result := execute(curl, PackedStringArray([
		"-fsSL",
		"--retry", "2",
		"--connect-timeout", "20",
		"-o", target_path,
		url,
	]))
	if int(result["exit_code"]) != 0:
		return {
			"ok": false,
			"code": "download_failed",
			"error": "下载失败：curl 退出码 %d（%s）" % [int(result["exit_code"]), url],
			"output": str(result["output"]),
		}
	if not FileAccess.file_exists(target_path):
		return {"ok": false, "code": "download_missing", "error": "curl 报告成功，但目标文件不存在：%s" % target_path, "output": ""}
	var size := file_size(target_path)
	if size <= 0:
		return {"ok": false, "code": "download_empty", "error": "下载到的文件为空：%s" % target_path, "output": ""}
	return {"ok": true, "code": "", "error": "", "path": target_path, "bytes": size, "output": str(result["output"])}


static func ensure_dir(path: String) -> String:
	if path == "":
		return "路径为空"
	if DirAccess.dir_exists_absolute(path):
		return ""
	var err := DirAccess.make_dir_recursive_absolute(path)
	if err != OK and err != ERR_ALREADY_EXISTS:
		return "无法创建目录 %s（%s）" % [path, error_string(err)]
	return ""


static func file_size(path: String) -> int:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return -1
	var size := f.get_length()
	f.close()
	return size


static func sha256_file(path: String) -> String:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return ""
	var ctx := HashingContext.new()
	if ctx.start(HashingContext.HASH_SHA256) != OK:
		f.close()
		return ""
	while true:
		var chunk := f.get_buffer(65536)
		if chunk.is_empty():
			break
		ctx.update(chunk)
	f.close()
	return ctx.finish().hex_encode()
