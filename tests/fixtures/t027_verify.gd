extends SceneTree

# T027 真实引擎验证脚本(4.6.3):重挂父节点后 .tscn 里的 [connection] 是否仍被引擎建立。
#
# 由 tests/sceneReparentSignal.real.test.ts 拷进临时工程,以
#   --headless --path <tmp> --script res://t027_verify.gd -- --scene res://scenes/main.tscn
# 运行。断言行统一用 `T027RESULT ` 前缀打到 stdout,由 TS 侧解析。
#
# 关键事实:引擎在 PackedScene.instantiate() 期间就建立 [connection];
# 若 from/to 指向的节点路径不存在,引擎会**静默丢弃**该连接(不报错),所以这里能在入树前读到它,
# 正好用来证明 D2 的路径同步真的生效。

var _scene_path := "res://scenes/main.tscn"

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var i := 0
	while i < args.size():
		if args[i] == "--scene" and i + 1 < args.size():
			i += 1
			_scene_path = args[i]
		i += 1

	var packed: PackedScene = load(_scene_path)
	if packed == null:
		push_error("T027_SCENE_LOAD_FAILED: " + _scene_path)
		quit(3)
		return

	var root: Node = packed.instantiate()
	_print_connections(root, root)
	# 读完就释放:否则退出时引擎会打 RID/ObjectDB 泄漏告警,掩盖真正的加载错误
	root.free()
	print("T027RESULT ok")
	quit(0)

# 场景根为 ".",其余相对场景根(与 SceneService 的 nodePath 约定一致)。
func _rel(node: Node, scene_root: Node) -> String:
	if node == scene_root:
		return "."
	return String(scene_root.get_path_to(node))

func _print_connections(node: Node, scene_root: Node) -> void:
	for sig in node.get_signal_list():
		var sig_name := String(sig["name"])
		for conn in node.get_signal_connection_list(sig_name):
			var cb: Callable = conn["callable"]
			var target: Object = cb.get_object()
			var target_path := "?"
			if target is Node:
				target_path = _rel(target, scene_root)
			print("T027RESULT conn|" + _rel(node, scene_root) + "|" + sig_name + "|" + target_path + "|" + String(cb.get_method()))
	for child in node.get_children():
		_print_connections(child, scene_root)
