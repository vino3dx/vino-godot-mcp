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

## 可以由结构化 JSON(而不是字面量字符串)直接构造的类型。
## 裸字典({"x":1,"y":2})只有在期望类型属于这里时才会被当成载荷解析,避免把普通字典误当结构体。
const STRUCTURED_TYPES := [
	"vector2", "vector2i", "vector3", "vector3i", "vector4", "vector4i",
	"color", "rect2", "rect2i", "quaternion", "basis", "transform2d", "transform3d", "plane", "aabb",
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
			# 修复:历史上只回传 origin,basis 丢失会让"读回来的变换"与真实值不一致。
			return {"valueType": "Transform3D", "value": {
				"basis": {"x": _vec3(value.basis.x), "y": _vec3(value.basis.y), "z": _vec3(value.basis.z)},
				"origin": _vec3(value.origin),
			}}
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

static func _vec3(v: Vector3) -> Dictionary:
	return {"x": v.x, "y": v.y, "z": v.z}

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
	# 裸结构体字典:{"x":1,"y":2} 配 expected_type=Vector2 —— 期望类型已知且可结构化构造时,按载荷解析。
	if spec is Dictionary and expected_type != TYPE_NIL and type_string(expected_type).to_lower() in STRUCTURED_TYPES:
		return _build_typed(type_string(expected_type), spec)
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
		"quaternion":
			return _build_quaternion(raw)
		"basis":
			return _build_basis(raw)
		"transform3d":
			return _build_transform3d(raw)
		"transform2d":
			return _build_transform2d(raw)
		"plane":
			return _build_plane(raw)
		"aabb":
			return _build_aabb(raw)
		"array":
			if raw is Array:
				return _built(raw)
			return _bad(tname, raw)
		"dictionary":
			if raw is Dictionary:
				return _built(raw)
			return _bad(tname, raw)
		"packedbytearray", "packedint32array", "packedint64array", "packedfloat32array", "packedfloat64array", "packedstringarray", "packedvector2array", "packedvector3array", "packedcolorarray":
			return _build_packed(tname, raw)
	if typeof(raw) == TYPE_STRING:
		var parsed := str_to_var(raw)
		if parsed != null and type_string(typeof(parsed)) == tname:
			return _built(parsed)
	return {"ok": false, "value": null, "valueType": tname, "error": "Unsupported valueType '%s' (supported: bool, int, float, String, StringName, NodePath, Vector2/2i/3/3i/4/4i, Color, Rect2/2i, Quaternion, Basis, Transform2D, Transform3D, Plane, AABB, Array, Dictionary, Packed*Array)" % tname}

static func _built(value) -> Dictionary:
	return {"ok": true, "value": value, "valueType": type_string(typeof(value)), "error": ""}

static func _bad(tname: String, raw) -> Dictionary:
	return {"ok": false, "value": null, "valueType": tname, "error": "valueType '%s' cannot be built from %s" % [tname, type_string(typeof(raw))]}

static func _fail_typed(tname: String, message: String) -> Dictionary:
	return {"ok": false, "value": null, "valueType": tname, "error": message}

## 只接受有限数值:NaN / Infinity 无法在 JSON 里表达,但从字符串或别处混进来时必须拒绝,
## 否则它们会被静默写进属性,变成一个"看起来生效、实际有毒"的变换。
static func _is_num(v) -> bool:
	if typeof(v) == TYPE_INT:
		return true
	if typeof(v) == TYPE_FLOAT:
		return is_finite(v)
	return false

static func _num_error(tname: String, raw, what: String) -> String:
	return "valueType '%s': %s must be a finite number, got %s" % [tname, what, type_string(typeof(raw))]

## 严格取分量:字典必须恰好提供所需键(不许缺省补 0),数组长度必须精确相等(不许截断多余分量)。
static func _components(raw, count: int, tname: String) -> Dictionary:
	var keys := ["x", "y", "z", "w"]
	if typeof(raw) == TYPE_DICTIONARY:
		for i in count:
			if not raw.has(keys[i]):
				return {"ok": false, "error": "valueType '%s': missing component '%s' (expected keys %s, no defaults)" % [tname, keys[i], str(keys.slice(0, count))]}
		var out := []
		for i in count:
			out.append(raw[keys[i]])
		var extra := []
		for k in raw.keys():
			if not (str(k) in keys.slice(0, count)):
				extra.append(str(k))
		if extra.size() > 0:
			return {"ok": false, "error": "valueType '%s': unknown component(s) %s (expected only %s)" % [tname, str(extra), str(keys.slice(0, count))]}
		return {"ok": true, "value": out}
	if typeof(raw) == TYPE_ARRAY:
		if raw.size() != count:
			return {"ok": false, "error": "valueType '%s': expected exactly %d components, got %d" % [tname, count, raw.size()]}
		return {"ok": true, "value": raw.duplicate()}
	return {"ok": false, "error": "valueType '%s': expected a Dictionary with keys %s or an Array of %d numbers, got %s" % [tname, str(keys.slice(0, count)), count, type_string(typeof(raw))]}

## 字符串字面量回退:"Vector2(1, 2)" / "Transform3D(...)" 交给引擎自己解析,但类型必须真的对上。
static func _literal_of(raw: String, tname: String) -> Dictionary:
	var parsed = str_to_var(raw)
	if parsed != null and type_string(typeof(parsed)).to_lower() == tname.to_lower():
		return _built(parsed)
	return _fail_typed(tname, "String literal '%s' is not a valid %s" % [_clip_string(raw), tname])

static func _build_vector(tname: String, raw) -> Dictionary:
	var key := tname.to_lower()
	var count := 2
	if key.begins_with("vector3"):
		count = 3
	elif key.begins_with("vector4"):
		count = 4
	if typeof(raw) == TYPE_STRING:
		return _literal_of(raw, tname)
	var comp := _components(raw, count, tname)
	if not comp["ok"]:
		return _fail_typed(tname, comp["error"])
	var parts: Array = comp["value"]
	for i in parts.size():
		if not _is_num(parts[i]):
			return _fail_typed(tname, _num_error(tname, parts[i], "component %d" % i))
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
	return _fail_typed(tname, "Unsupported vector type '%s'" % tname)

## 把 "x"/"y"/"z" 这类三键字典解析成 Vector3(严格),供 Basis / AABB / Transform3D 复用。
static func _build_vec3_field(tname: String, field: String, raw) -> Dictionary:
	if not (raw is Dictionary):
		return _fail_typed(tname, "valueType '%s': '%s' must be an object with x/y/z, got %s" % [tname, field, type_string(typeof(raw))])
	var comp := _components(raw, 3, tname)
	if not comp["ok"]:
		return _fail_typed(tname, "%s%s" % [field, String(comp["error"]).replace("valueType '%s':" % tname, "")])
	var parts: Array = comp["value"]
	for i in parts.size():
		if not _is_num(parts[i]):
			return _fail_typed(tname, _num_error(tname, parts[i], "%s.%s" % [field, ["x", "y", "z"][i]]))
	return _built(Vector3(parts[0], parts[1], parts[2]))

static func _build_color(raw) -> Dictionary:
	var tname := "Color"
	if typeof(raw) == TYPE_STRING:
		var text: String = raw.strip_edges()
		if text.begins_with("#"):
			var hex := text.substr(1)
			var valid := true
			for ch in hex:
				if not ("0123456789abcdefABCDEF".contains(ch)):
					valid = false
					break
			if not valid:
				return _fail_typed(tname, "Hex color '%s' contains non-hex characters" % _clip_string(text))
			if not (hex.length() in [3, 4, 6, 8]):
				return _fail_typed(tname, "Hex color '%s' must have 3, 4, 6 or 8 digits, got %d" % [_clip_string(text), hex.length()])
			if hex.length() <= 4:
				var expanded := ""
				for ch in hex:
					expanded += ch + ch
				hex = expanded
			if hex.length() == 6:
				hex += "ff"
			return _built(Color.html(hex))
		return _literal_of(raw, tname)
	if typeof(raw) == TYPE_DICTIONARY:
		for k in ["r", "g", "b"]:
			if not raw.has(k):
				return _fail_typed(tname, "Color expects keys r/g/b (a optional), missing '%s'" % k)
		for k in raw.keys():
			if not (str(k) in ["r", "g", "b", "a"]):
				return _fail_typed(tname, "Color has unknown key '%s' (expected r/g/b/a)" % str(k))
		var rgba := [raw["r"], raw["g"], raw["b"], raw.get("a", 1.0)]
		for i in rgba.size():
			if not _is_num(rgba[i]):
				return _fail_typed(tname, _num_error(tname, rgba[i], "component %d" % i))
		return _built(Color(rgba[0], rgba[1], rgba[2], rgba[3]))
	if typeof(raw) == TYPE_ARRAY:
		if not (raw.size() in [3, 4]):
			return _fail_typed(tname, "Color expects exactly 3 or 4 numbers [r,g,b(,a)], got %d" % raw.size())
		for i in raw.size():
			if not _is_num(raw[i]):
				return _fail_typed(tname, _num_error(tname, raw[i], "component %d" % i))
		return _built(Color(raw[0], raw[1], raw[2], raw[3] if raw.size() == 4 else 1.0))
	return _fail_typed(tname, "Color expects '#rrggbb', {r,g,b[,a]} or [r,g,b[,a]], got %s" % type_string(typeof(raw)))

static func _build_rect(tname: String, raw) -> Dictionary:
	if typeof(raw) == TYPE_STRING:
		return _literal_of(raw, tname)
	var parts := []
	if typeof(raw) == TYPE_DICTIONARY:
		var need := ["x", "y"]
		var w_key := "w" if raw.has("w") else "width"
		var h_key := "h" if raw.has("h") else "height"
		if not raw.has(w_key) or not raw.has(h_key):
			need.append("w")
			need.append("h")
			return _fail_typed(tname, "valueType '%s': missing %s (expected x/y/w/h or x/y/width/height)" % [tname, str(need)])
		for k in need:
			if not raw.has(k):
				return _fail_typed(tname, "valueType '%s': missing component '%s'" % [tname, k])
		for k in raw.keys():
			if not (str(k) in ["x", "y", "w", "h", "width", "height"]):
				return _fail_typed(tname, "valueType '%s': unknown component '%s'" % [tname, str(k)])
		parts = [raw["x"], raw["y"], raw[w_key], raw[h_key]]
	elif typeof(raw) == TYPE_ARRAY:
		if raw.size() != 4:
			return _fail_typed(tname, "valueType '%s': expected exactly 4 numbers [x,y,w,h], got %d" % [tname, raw.size()])
		parts = raw.duplicate()
	else:
		return _fail_typed(tname, "valueType '%s': expected an object/array or a literal string, got %s" % [tname, type_string(typeof(raw))])
	for i in parts.size():
		if not _is_num(parts[i]):
			return _fail_typed(tname, _num_error(tname, parts[i], "component %d" % i))
	if tname.to_lower() == "rect2i":
		return _built(Rect2i(int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])))
	return _built(Rect2(Vector2(parts[0], parts[1]), Vector2(parts[2], parts[3])))

static func _build_quaternion(raw) -> Dictionary:
	var tname := "Quaternion"
	if typeof(raw) == TYPE_STRING:
		return _literal_of(raw, tname)
	var comp := _components(raw, 4, tname)
	if not comp["ok"]:
		return _fail_typed(tname, comp["error"])
	var parts: Array = comp["value"]
	for i in parts.size():
		if not _is_num(parts[i]):
			return _fail_typed(tname, _num_error(tname, parts[i], "component %d" % i))
	return _built(Quaternion(parts[0], parts[1], parts[2], parts[3]))

static func _build_basis(raw) -> Dictionary:
	var tname := "Basis"
	if typeof(raw) == TYPE_STRING:
		return _literal_of(raw, tname)
	if not (raw is Dictionary):
		return _fail_typed(tname, "Basis expects {x:{x,y,z}, y:{...}, z:{...}}, got %s" % type_string(typeof(raw)))
	var vecs := []
	for k in raw.keys():
		if not (str(k) in ["x", "y", "z"]):
			return _fail_typed(tname, "Basis has unknown axis '%s' (expected x/y/z)" % str(k))
	for axis in ["x", "y", "z"]:
		if not raw.has(axis):
			return _fail_typed(tname, "Basis missing axis '%s'" % axis)
		var v := _build_vec3_field(tname, axis, raw[axis])
		if not v["ok"]:
			return v
		vecs.append(v["value"])
	return _built(Basis(vecs[0], vecs[1], vecs[2]))

static func _build_transform3d(raw) -> Dictionary:
	var tname := "Transform3D"
	if typeof(raw) == TYPE_STRING:
		return _literal_of(raw, tname)
	if not (raw is Dictionary):
		return _fail_typed(tname, "Transform3D expects {basis:{x,y,z}, origin:{x,y,z}}, got %s" % type_string(typeof(raw)))
	for k in raw.keys():
		if not (str(k) in ["basis", "origin"]):
			return _fail_typed(tname, "Transform3D has unknown key '%s' (expected basis/origin)" % str(k))
	if not raw.has("origin"):
		return _fail_typed(tname, "Transform3D missing 'origin'")
	var basis_dict = raw.get("basis")
	if basis_dict == null:
		return _fail_typed(tname, "Transform3D missing 'basis' (identity is not assumed)")
	var basis := _build_basis(basis_dict)
	if not basis["ok"]:
		return basis
	var origin := _build_vec3_field(tname, "origin", raw["origin"])
	if not origin["ok"]:
		return origin
	return _built(Transform3D(basis["value"], origin["value"]))

static func _build_transform2d(raw) -> Dictionary:
	var tname := "Transform2D"
	if typeof(raw) == TYPE_STRING:
		return _literal_of(raw, tname)
	if not (raw is Dictionary):
		return _fail_typed(tname, "Transform2D expects {x:{x,y}, y:{x,y}, origin:{x,y}}, got %s" % type_string(typeof(raw)))
	for k in raw.keys():
		if not (str(k) in ["x", "y", "origin"]):
			return _fail_typed(tname, "Transform2D has unknown key '%s' (expected x/y/origin)" % str(k))
	var parts := []
	for axis in ["x", "y", "origin"]:
		if not raw.has(axis):
			return _fail_typed(tname, "Transform2D missing '%s'" % axis)
		var comp := _components(raw[axis], 2, tname)
		if not comp["ok"]:
			return _fail_typed(tname, "%s: %s" % [axis, comp["error"]])
		for v in comp["value"]:
			if not _is_num(v):
				return _fail_typed(tname, _num_error(tname, v, axis))
		parts.append(comp["value"])
	return _built(Transform2D(Vector2(parts[0][0], parts[0][1]), Vector2(parts[1][0], parts[1][1]), Vector2(parts[2][0], parts[2][1])))

static func _build_plane(raw) -> Dictionary:
	var tname := "Plane"
	if typeof(raw) == TYPE_STRING:
		return _literal_of(raw, tname)
	if not (raw is Dictionary):
		return _fail_typed(tname, "Plane expects {x,y,z,d} (normal + distance), got %s" % type_string(typeof(raw)))
	for k in raw.keys():
		if not (str(k) in ["x", "y", "z", "d"]):
			return _fail_typed(tname, "Plane has unknown key '%s' (expected x/y/z/d)" % str(k))
	for k in ["x", "y", "z", "d"]:
		if not raw.has(k):
			return _fail_typed(tname, "Plane missing '%s'" % k)
		if not _is_num(raw[k]):
			return _fail_typed(tname, _num_error(tname, raw[k], k))
	return _built(Plane(raw["x"], raw["y"], raw["z"], raw["d"]))

static func _build_aabb(raw) -> Dictionary:
	var tname := "AABB"
	if typeof(raw) == TYPE_STRING:
		return _literal_of(raw, tname)
	if not (raw is Dictionary):
		return _fail_typed(tname, "AABB expects {position:{x,y,z}, size:{x,y,z}}, got %s" % type_string(typeof(raw)))
	for k in raw.keys():
		if not (str(k) in ["position", "size"]):
			return _fail_typed(tname, "AABB has unknown key '%s' (expected position/size)" % str(k))
	for k in ["position", "size"]:
		if not raw.has(k):
			return _fail_typed(tname, "AABB missing '%s'" % k)
	var pos := _build_vec3_field(tname, "position", raw["position"])
	if not pos["ok"]:
		return pos
	var size := _build_vec3_field(tname, "size", raw["size"])
	if not size["ok"]:
		return size
	return _built(AABB(pos["value"], size["value"]))

## Packed 数值数组:元素必须是有限数值;向量/颜色类 Packed 数组不支持(需要逐元素对象,容易误解),
## 明确拒绝而不是悄悄转成 0。
static func _build_packed(tname: String, raw) -> Dictionary:
	var key := tname.to_lower()
	if typeof(raw) == TYPE_STRING:
		return _literal_of(raw, tname)
	if not (raw is Array):
		return _fail_typed(tname, "valueType '%s' expects an Array, got %s" % [tname, type_string(typeof(raw))])
	if key == "packedstringarray":
		for i in raw.size():
			if not (typeof(raw[i]) == TYPE_STRING or typeof(raw[i]) == TYPE_STRING_NAME):
				return _fail_typed(tname, "PackedStringArray element %d must be a string, got %s" % [i, type_string(typeof(raw[i]))])
		return _built(PackedStringArray(raw))
	if key in ["packedvector2array", "packedvector3array", "packedcolorarray"]:
		return _fail_typed(tname, "%s is not accepted through the bridge; pass an Array of encoded objects instead" % tname)
	for i in raw.size():
		if not _is_num(raw[i]):
			return _fail_typed(tname, _num_error(tname, raw[i], "element %d" % i))
	match key:
		"packedbytearray":
			for v in raw:
				if v < 0 or v > 255:
					return _fail_typed(tname, "PackedByteArray element %s is out of range 0..255" % str(v))
			return _built(PackedByteArray(raw))
		"packedint32array":
			return _built(PackedInt32Array(raw))
		"packedint64array":
			return _built(PackedInt64Array(raw))
		"packedfloat32array":
			return _built(PackedFloat32Array(raw))
		"packedfloat64array":
			return _built(PackedFloat64Array(raw))
	return _fail_typed(tname, "Unsupported packed array type '%s'" % tname)

static func _convert(value, expected_type: int) -> Dictionary:
	var actual := typeof(value)
	if actual == expected_type:
		return {"ok": true, "value": value}
	# 目标属性是 Packed* 数组、调用方给了普通 Array:走同一套 _build_packed 校验后再转。
	if expected_type >= TYPE_PACKED_BYTE_ARRAY and expected_type <= TYPE_PACKED_COLOR_ARRAY and actual == TYPE_ARRAY:
		var packed := _build_packed(type_string(expected_type), value)
		if packed["ok"]:
			return {"ok": true, "value": packed["value"]}
		return {"ok": false, "error": packed["error"]}
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
