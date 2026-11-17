@tool
extends RefCounted

## 编辑器事件枢纽：环形缓冲 + 推送队列。
##
## 为什么既要推送又要缓冲：
##   - 推送(unsolicited frame)让 Editor 侧的变化在 MCP 连接活着时立刻到达；
##   - 但 MCP Server 不是时刻连着（stdio 进程可能刚启动、或刚重启），
##     所以事件同时进环形缓冲，由 editor_events(sinceSeq) 补齐，事件不会丢。
##   两者按 seq 去重，Server 侧只保留"没见过的 seq"。
##
## seq 单调递增，只在本次 Editor 会话内有效（不持久化）。

## 缓冲条数：够覆盖一次"AI 没连着的编辑窗口"，又不至于把编辑器内存吃光。
const MAX_EVENTS := 200
## 推送队列上限：没有 peer 时队列直接丢弃，权威数据永远在缓冲里。
const MAX_QUEUE := 400

var _events: Array = []
var _queue: Array = []
var _next_seq := 1
var _dropped := 0


func emit(type: String, data: Dictionary) -> Dictionary:
	var event := {
		"seq": _next_seq,
		"type": type,
		"at": int(Time.get_unix_time_from_system() * 1000.0),
		"data": data,
	}
	_next_seq += 1
	_events.append(event)
	if _events.size() > MAX_EVENTS:
		_events.pop_front()
		_dropped += 1
	if _queue.size() < MAX_QUEUE:
		_queue.append(event)
	return event


## 按 seq 与类型过滤取事件。types 为空 = 不过滤。
func since(seq: int, limit: int, types: Array) -> Dictionary:
	var out := []
	var filter_active := types.size() > 0
	for event in _events:
		if int(event["seq"]) <= seq:
			continue
		if filter_active and not types.has(str(event["type"])):
			continue
		out.append(event)
		if out.size() >= limit:
			break
	return {
		"events": out,
		"nextSeq": _next_seq - 1,
		"buffered": _events.size(),
		"dropped": _dropped,
		"filteredTypes": types,
	}


## 只在有 peer 时调用；拿走的推送事件不保留（缓冲才是权威）。
func take_queue() -> Array:
	var out := _queue
	_queue = []
	return out


func pending_count() -> int:
	return _queue.size()


func state() -> Dictionary:
	return {
		"nextSeq": _next_seq - 1,
		"buffered": _events.size(),
		"maxBuffered": MAX_EVENTS,
		"dropped": _dropped,
		"pendingPush": _queue.size(),
	}


func reset() -> void:
	_events = []
	_queue = []
	_next_seq = 1
	_dropped = 0
