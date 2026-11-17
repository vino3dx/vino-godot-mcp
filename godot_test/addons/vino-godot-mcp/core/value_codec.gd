@tool
extends RefCounted

## Bridge 值编解码（唯一实现）。
##
## 编码：Godot Variant → 可 JSON 化的类型描述 {valueType, value, ...}。
##       历史上这些字段由 plugin.gd 直接产出，现已集中到这里，写入回执与读取结果
##       用的是同一套编码，避免"读出来是 Vector2、写进去变成字典"的错位。
## 解码：JSON 描述 / 裸值 → Godot Variant，并与目标属性的期望类型做兼容校验。
##
## 不做的事：不深序列化 Object/Resource（只给引用描述），不猜引擎默认值。

const NodeCollector := preload("../collectors/node_collector.gd")

const MAX_ARRAY_ITEMS := 64
const MAX_NESTING_DEPTH := 3
const MAX_STRING_CHARS := 4096

## 复杂类型名 → 构造方式。键与 encode() 输出的 valueType 保持一致。
const COMPLEX_TYPES := [
	"Vector2", "Vector2i", "Vector3", "Vector3i", "Vector4", "Vector4i",
	"Color", "Rect2", "Rect2i", "Transform2D", "Quaternion",
]

# ---------------------------------------------------------------- encode

static func encode(value, depth := 0) -> Dictionary:
	if value == null:
		return {"valueType": "Nil", "value": null}
	match typeof(value):
		TYPE_BOOL:
			return {"valueType": "bool", "value": value}
		TYPE_INT:
			return {"valueType": "int", "value": value}
		TYPE_FLOAT:
			return {"valueType": "float", "value": value}
		TYPE_STRING:
			return {"valueType": "String", "value": _clip_string(value)}
		TYPE_STRING_NAME:
			return {"valueType": "StringName", "value": _clip_string(str(value))}
		TYPE_NODE_PATH:
			return {"valueType": "NodePath", "value": str(value)}
		TYPE_VECTOR2:
			return {"valueType": "Vector2", "value": _vec2(value)}
		TYPE_VECTOR2I:
			return {"valueType": "Vector2i", "value": {"x": value.x, "y": value.y}}
		TYPE_VECTOR3:
			return {"valueType": "Vector3", "value": {"x": value.x, "y": value.y, "z": value.z}}
		TYPE_VECTOR3I:
			return {"valueType": "Vector3i", "value": {"x": value.x, "y": value.y, "z": value.z}}
		TYPE_VECTOR4:
			return {"valueType": "Vector4", "value": {"x": value.x, "y": value.y, "z": value.z, "w": value.w}}
		TYPE_VECTOR4I:
			return {"valueType": "Vector4i", "value": {"x": value.x, "y": value.y, "z": value.z, "w": value.w}}
		TYPE_RECT2:
			return {"valueType": "Rect2", "value": _rect2(value)}
		TYPE_RECT2I:
			return {"valueType": "Rect2i", "value": {"x": value.position.x, "y": value.position.y, "w": value.size.x, "h": value.size.y}}
		TYPE_COLOR:
			return {"valueType": "Color", "value": {"r": value.r, "g": value.g, "b": value.b, "a": value.a}}
		TYPE_TRANSFORM2D:
			return {"valueType": "Transform2D", "value": {"x": _vec2(value.x), "y": _vec2(value.y), "origin": _vec2(value.origin)}}
		TYPE_TRANSFORM3D:
			return {"valueType": "Transform3D", "value": {"origin": {"x": value.origin.x, "y": value.origin.y, "z": value.origin.z}}}
		TYPE_BASIS:
			return {"valueType": "Basis", "value": {"x": {"x": value.x.x, "y": value.x.y, "z": value.x.z}, "y": {"x": value.y.x, "y": value.y.y, "z": value.y.z}, "z": {"x": value.z.x, "y": value.z.y, "z": value.z.z}}}
		TYPE_QUATERNION:
			return {"valueType": "Quaternion", "value": {"x": value.x, "y": value.y, "z": value.z, "w": value.w}}
		TYPE_PLANE:
			return {"valueType": "Plane", "value": {"x": value.normal.x, "y": value.normal.y, "z": value.normal.z, "d": value.d}}
		TYPE_AABB:
			return {"valueType": "AABB", "value": {"position": {"x": value.position.x, "y": value.position.y, "z": value.position.z}, "size": {"x": value.size.x, "y": value.size.y, "z": value.size.z}}}
		TYPE_OBJECT:
			return _encode_object(value)
		TYPE_CALLABLE:
			return {"valueType": "Callable", "value": {"text": str(value)}, "note": "Callable is not serializable; descriptor only"}
		TYPE_SIGNAL:
			return {"valueType": "Signal", "value": {"text": str(value)}, "note": "Signal is not serializable; descriptor only"}
		TYPE_RID:
			return {"valueType": "RID", "value": {"text": str(value)}, "note": "RID is session-local; not a stable identifier"}
		TYPE_ARRAY:
			return _encode_array(value, depth)
		TYPE_DICTIONARY:
			return _encode_dictionary(value, depth)
	var vtype := typeof(value)
	# Packed* 数组编号连续(4.6.3 实测 29..37),用区间判断比逐个 match 分支稳。
	if vtype >= TYPE_PACKED_BYTE_ARRAY and vtype <= TYPE_PACKED_COLOR_ARRAY:
		return _encode_packed(value, depth)
	return {"valueType": type_string(vtype), "value": null, "note": "Unsupported value type; only the type name is reported"}

static func _encode_object(value) -> Dictionary:
	if not is_instance_valid(value):
		return {"valueType": "Object", "value": {"invalid": true}, "note": "Object reference is no longer valid in this editor session"}
	var info := {"className": value.get_class(), "instanceId": NodeCollector.instance_id(value)}
	if value is Node:
		info["kind"] = "Node"
		info["nodePath"] = str(value.get_path()) if value.is_inside_tree() else ""
		info["sceneFilePath"] = value.scene_file_path
	elif value is Resource:
		info["kind"] = "Resource"
		info["resourcePath"] = value.resource_path
		info["resourceName"] = str(value.resource_name)
	else:
		info["kind"] = "Object"
	return {"valueType": "Object", "value": info, "note": "Object/Resource reference descriptor only (no deep serialization)"}

static func _encode_array(value: Array, depth: int) -> Dictionary:
	if depth >= MAX_NESTING_DEPTH:
		return {"valueType": "Array", "value": null, "note": "Nesting depth limit reached; contents omitted"}
	var out := []
	var limit := mini(value.size(), MAX_ARRAY_ITEMS)
	for i in limit:
		var item := encode(value[i], depth + 1)
		out.append(item["value"])
	return {"valueType": "Array", "value": out, "truncated": value.size() > limit, "length": value.size()}

static func _encode_dictionary(value: Dictionary, depth: int) -> Dictionary:
	if depth >= MAX_NESTING_DEPTH:
		return {"valueType": "Dictionary", "value": null, "note": "Nesting depth limit reached; contents omitted"}
	var out := {}
	var limit := mini(value.size(), MAX_ARRAY_ITEMS)
	var i := 0
	for k in value.keys():
		if i >= limit:
			break
		var item := encode(value[k], depth + 1)
		out[str(k)] = item["value"]
		i += 1
	return {"valueType": "Dictionary", "value": out, "truncated": value.size() > limit, "length": value.size(), "note": "Dictionary keys are stringified"}

static func _encode_packed(value, depth: int) -> Dictionary:
	var limit := mini(value.size(), MAX_ARRAY_ITEMS)
	var out := []
	for i in limit:
		var item := encode(value[i], depth + 1)
		out.append(item["value"])
	return {"valueType": type_string(typeof(value)), "value": out, "truncated": value.size() > limit, "length": value.size()}

static func _clip_string(text: String) -> String:
	if text.length() <= MAX_STRING_CHARS:
		return text
	return text.substr(0, MAX_STRING_CHARS) + "…(truncated)"

static func _vec2(v: Vector2) -> Dictionary:
	return {"x": v.x, "y": v.y}

static func _rect2(v: Rect2) -> Dictionary:
	return {"x": v.position.x, "y": v.position.y, "w": v.size.x, "h": v.size.y}

# ---------------------------------------------------------------- decode

## spec 可以是：
##   {valueType|type, value}  显式类型描述（与 encode 输出同构，可直接回灌）
##   裸标量/数组/字典           由期望类型决定如何解释
##   "Vector2(1, 2)"         Godot 字面量字符串（只在期望类型已知时解析）
##
## 返回 {"ok": bool, "value": Variant, "valueType": String, "error": String}
static func decode(spec, expected_type := TYPE_NIL) -> Dictionary:
	var built := _build(spec, expected_type)
	if not built["ok"]:
		return built
	var value = built["value"]
	if expected_type == TYPE_NIL:
		return {"ok": true, "value": value, "valueType": type_string(typeof(value)), "error": ""}
	var converted := _convert(value, expected_type)
	if not converted["ok"]:
		return {"ok": false, "value": null, "valueType": type_string(expected_type), "error": converted["error"]}
	return {"ok": true, "value": converted["value"], "valueType": type_string(typeof(converted["value"])), "error": ""}

static func _build(spec, expected_type: int) -> Dictionary:
	if spec is Dictionary and (spec.has("valueType") or spec.has("type") or (spec.has("value") and spec.size() <= 3)):
		var tname := str(spec.get("valueType", spec.get("type", "")))
		if tname == "":
			if expected_type == TYPE_NIL:
				return {"ok": false, "value": null, "valueType": "", "error": "valueType is required when the target property type is unknown"}
			tname = type_string(expected_type)
		return _build_typed(tname, spec.get("value"))
	if spec is String and expected_type != TYPE_NIL and not (expected_type in [TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH]):
		var parsed = str_to_var(spec)
		if parsed != null and typeof(parsed) == expected_type:
			return {"ok": true, "value": parsed, "valueType": type_string(typeof(parsed)), "error": ""}
		return {"ok": false, "value": null, "valueType": type_string(expected_type), "error": "String literal '%s' is not a valid %s" % [spec, type_string(expected_type)]}
	return {"ok": true, "value": spec, "valueType": type_string(typeof(spec)), "error": ""}

static func _build_typed(tname: String, raw) -> Dictionary:
	var key := tname.to_lower()
	match key:
		"bool", "boolean":
			if typeof(raw) == TYPE_BOOL:
				return _built(raw)
			return _bad(tname, raw)
		"int", "integer":
			if typeof(raw) == TYPE_INT:
				return _built(raw)
			if typeof(raw) == TYPE_FLOAT:
				return _built(int(raw))
			return _bad(tname, raw)
		"float", "number":
			if typeof(raw) == TYPE_FLOAT or typeof(raw) == TYPE_INT:
				return _built(float(raw))
			return _bad(tname, raw)
		"string":
			if typeof(raw) == TYPE_STRING or typeof(raw) == TYPE_STRING_NAME:
				return _built(str(raw))
			return _bad(tname, raw)
		"stringname":
			if typeof(raw) == TYPE_STRING or typeof(raw) == TYPE_STRING_NAME:
				return _built(StringName(str(raw)))
			return _bad(tname, raw)
		"nodepath":
			if typeof(raw) == TYPE_STRING or typeof(raw) == TYPE_STRING_NAME or typeof(raw) == TYPE_NODE_PATH:
				return _built(NodePath(str(raw)))
			return _bad(tname, raw)
		"vector2", "vector2i", "vector3", "vector3i", "vector4", "vector4i":
			return _build_vector(tname, raw)
		"color":
			return _build_color(raw)
		"rect2", "rect2i":
			return _build_rect(tname, raw)
		"array":
			if raw is Array:
				return _built(raw)
			return _bad(tname, raw)
		"dictionary":
			if raw is Dictionary:
				return _built(raw)
			return _bad(tname, raw)
		"packedstringarray":
			if raw is Array:
				return _built(PackedStringArray(raw))
			return _bad(tname, raw)
	if typeof(raw) == TYPE_STRING:
		var parsed = str_to_var(raw)
		if parsed != null and type_string(typeof(parsed)) == tname:
			return _built(parsed)
	return {"ok": false, "value": null, "valueType": tname, "error": "Unsupported valueType '%s' (supported: bool, int, float, String, StringName, NodePath, Vector2/2i/3/3i/4/4i, Color, Rect2/2i, Array, Dictionary, PackedStringArray)" % tname}

static func _built(value) -> Dictionary:
	return {"ok": true, "value": value, "valueType": type_string(typeof(value)), "error": ""}

static func _bad(tname: String, raw) -> Dictionary:
	return {"ok": false, "value": null, "valueType": tname, "error": "valueType '%s' cannot be built from %s" % [tname, type_string(typeof(raw))]}

static func _components(raw, count: int) -> Array:
	if raw is Dictionary:
		var keys := ["x", "y", "z", "w"]
		var out := []
		for i in count:
			out.append(raw.get(keys[i], 0))
		return out
	if raw is Array and raw.size() >= count:
		return raw.slice(0, count)
	return []

static func _build_vector(tname: String, raw) -> Dictionary:
	var key := tname.to_lower()
	var count := 2
	if key.begins_with("vector3"):
		count = 3
	elif key.begins_with("vector4"):
		count = 4
	var parts := _components(raw, count)
	if parts.size() != count:
		return _bad(tname, raw)
	for part in parts:
		if typeof(part) != TYPE_INT and typeof(part) != TYPE_FLOAT:
			return _bad(tname, raw)
	match key:
		"vector2":
			return _built(Vector2(parts[0], parts[1]))
		"vector2i":
			return _built(Vector2i(int(parts[0]), int(parts[1])))
		"vector3":
			return _built(Vector3(parts[0], parts[1], parts[2]))
		"vector3i":
			return _built(Vector3i(int(parts[0]), int(parts[1]), int(parts[2])))
		"vector4":
			return _built(Vector4(parts[0], parts[1], parts[2], parts[3]))
		"vector4i":
			return _built(Vector4i(int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])))
	return _bad(tname, raw)

static func _build_color(raw) -> Dictionary:
	if raw is Dictionary:
		return _built(Color(
			float(raw.get("r", 0.0)),
			float(raw.get("g", 0.0)),
			float(raw.get("b", 0.0)),
			float(raw.get("a", 1.0)),
		))
	if raw is Array and raw.size() >= 3:
		return _built(Color(float(raw[0]), float(raw[1]), float(raw[2]), float(raw[3]) if raw.size() > 3 else 1.0))
	if raw is String:
		var parsed = str_to_var(raw)
		if parsed is Color:
			return _built(parsed)
	return _bad("Color", raw)

static func _build_rect(tname: String, raw) -> Dictionary:
	var parts := []
	if raw is Dictionary:
		parts = [raw.get("x", 0), raw.get("y", 0), raw.get("w", raw.get("width", 0)), raw.get("h", raw.get("height", 0))]
	elif raw is Array and raw.size() >= 4:
		parts = raw.slice(0, 4)
	if parts.size() != 4:
		return _bad(tname, raw)
	for part in parts:
		if typeof(part) != TYPE_INT and typeof(part) != TYPE_FLOAT:
			return _bad(tname, raw)
	if tname.to_lower() == "rect2i":
		return _built(Rect2i(int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])))
	return _built(Rect2(Vector2(parts[0], parts[1]), Vector2(parts[2], parts[3])))

static func _convert(value, expected_type: int) -> Dictionary:
	var actual := typeof(value)
	if actual == expected_type:
		return {"ok": true, "value": value}
	match expected_type:
		TYPE_FLOAT:
			if actual == TYPE_INT:
				return {"ok": true, "value": float(value)}
		TYPE_INT:
			if actual == TYPE_FLOAT and is_equal_approx(value, round(value)):
				return {"ok": true, "value": int(value)}
		TYPE_STRING:
			if actual == TYPE_STRING_NAME:
				return {"ok": true, "value": str(value)}
		TYPE_STRING_NAME:
			if actual == TYPE_STRING:
				return {"ok": true, "value": StringName(value)}
		TYPE_NODE_PATH:
			if actual == TYPE_STRING or actual == TYPE_STRING_NAME:
				return {"ok": true, "value": NodePath(str(value))}
		TYPE_OBJECT:
			return {"ok": false, "error": "Object/Resource properties cannot be written through the bridge (no deep object serialization); change the resource file instead"}
		TYPE_ARRAY:
			if actual == TYPE_ARRAY:
				return {"ok": true, "value": value}
	# 类型不匹配时明确拒绝，而不是让引擎静默吞掉这次 set()。
	return {"ok": false, "error": "Property expects %s but the provided value is %s" % [type_string(expected_type), type_string(actual)]}
