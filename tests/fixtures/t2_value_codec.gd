extends SceneTree

## T2 验收探针:直接对 addon 里的 value_codec.gd 做黑盒断言。
## 由 tests/valueCodec.real.test.ts 拷进临时工程的 res://probe.gd 后运行,
## 输出 T2PASS|name / T2FAIL|name 与 T2SUMMARY|fails=N,测试侧按 fail 数判定。

const Codec := preload("res://addons/vino-godot-mcp/core/value_codec.gd")

var fails := 0

func check(name: String, got: bool) -> void:
	if got:
		print("T2PASS|" + name)
	else:
		fails += 1
		print("T2FAIL|" + name)

func _init() -> void:
	# Vector2 三种输入形式
	var v1 := Codec.decode({"valueType": "Vector2", "value": "Vector2(100, 200)"}, TYPE_VECTOR2)
	check("vector2_string", v1["ok"] and v1["value"] == Vector2(100, 200))
	var v2 := Codec.decode({"valueType": "Vector2", "value": {"x": 100, "y": 200}}, TYPE_VECTOR2)
	check("vector2_dict", v2["ok"] and v2["value"] == Vector2(100, 200))
	var v3 := Codec.decode({"valueType": "Vector2", "value": [100, 200]}, TYPE_VECTOR2)
	check("vector2_array", v3["ok"] and v3["value"] == Vector2(100, 200))

	# 分量数量必须精确
	var short := Codec.decode({"valueType": "Vector3", "value": [1, 2]}, TYPE_VECTOR3)
	check("vector3_short_rejected", not short["ok"])
	var extra := Codec.decode({"valueType": "Vector2", "value": [1, 2, 3]}, TYPE_VECTOR2)
	check("vector2_extra_rejected", not extra["ok"])
	var missing := Codec.decode({"valueType": "Vector3", "value": {"x": 1, "y": 2}}, TYPE_VECTOR3)
	check("vector3_missing_rejected", not missing["ok"])
	var nanv := Codec.decode({"valueType": "Vector2", "value": {"x": NAN, "y": 1}}, TYPE_VECTOR2)
	check("vector2_nan_rejected", not nanv["ok"])
	var infv := Codec.decode({"valueType": "Vector2", "value": [INF, 1]}, TYPE_VECTOR2)
	check("vector2_inf_rejected", not infv["ok"])

	# Color
	var c1 := Codec.decode({"valueType": "Color", "value": "#ff0000"}, TYPE_COLOR)
	check("color_hex6", c1["ok"] and is_equal_approx(c1["value"].r, 1.0) and is_equal_approx(c1["value"].a, 1.0))
	var c2 := Codec.decode({"valueType": "Color", "value": "#f00"}, TYPE_COLOR)
	check("color_hex3", c2["ok"] and is_equal_approx(c2["value"].r, 1.0))
	var c3 := Codec.decode({"valueType": "Color", "value": {"r": 1, "g": 0, "b": 0, "a": 1}}, TYPE_COLOR)
	check("color_dict", c3["ok"] and c3["value"] == Color(1, 0, 0, 1))
	var c4 := Codec.decode({"valueType": "Color", "value": [1, 0, 0, 1]}, TYPE_COLOR)
	check("color_array", c4["ok"] and c4["value"] == Color(1, 0, 0, 1))
	var cbad := Codec.decode({"valueType": "Color", "value": "#gg0000"}, TYPE_COLOR)
	check("color_bad_hex_rejected", not cbad["ok"])
	var cshort := Codec.decode({"valueType": "Color", "value": [1, 0]}, TYPE_COLOR)
	check("color_short_array_rejected", not cshort["ok"])

	# Transform3D:结构化 JSON,basis 与 origin 都必填
	var t3 := Codec.decode({"valueType": "Transform3D", "value": {"basis": {"x": {"x": 1, "y": 0, "z": 0}, "y": {"x": 0, "y": 1, "z": 0}, "z": {"x": 0, "y": 0, "z": 1}}, "origin": {"x": 1, "y": 2, "z": 3}}}, TYPE_TRANSFORM3D)
	check("transform3d_structured", t3["ok"] and t3["value"].origin == Vector3(1, 2, 3))
	var t3bad := Codec.decode({"valueType": "Transform3D", "value": {"origin": {"x": 1, "y": 2, "z": 3}}}, TYPE_TRANSFORM3D)
	check("transform3d_missing_basis_rejected", not t3bad["ok"])
	var t3enc := Codec.encode(Transform3D(Basis.IDENTITY, Vector3(4, 5, 6)))
	check("transform3d_encode_keeps_basis", t3enc["value"].has("basis"))

	# Quaternion / Basis / Plane / AABB
	var q := Codec.decode({"valueType": "Quaternion", "value": {"x": 0, "y": 0, "z": 0, "w": 1}}, TYPE_QUATERNION)
	check("quaternion", q["ok"] and q["value"] == Quaternion(0, 0, 0, 1))
	var b := Codec.decode({"valueType": "Basis", "value": {"x": {"x": 1, "y": 0, "z": 0}, "y": {"x": 0, "y": 1, "z": 0}, "z": {"x": 0, "y": 0, "z": 1}}}, TYPE_BASIS)
	check("basis", b["ok"] and b["value"] == Basis.IDENTITY)
	var pl := Codec.decode({"valueType": "Plane", "value": {"x": 0, "y": 1, "z": 0, "d": 2}}, TYPE_PLANE)
	check("plane", pl["ok"] and pl["value"] == Plane(0, 1, 0, 2))
	var ab := Codec.decode({"valueType": "AABB", "value": {"position": {"x": 0, "y": 0, "z": 0}, "size": {"x": 1, "y": 1, "z": 1}}}, TYPE_AABB)
	check("aabb", ab["ok"] and ab["value"].size == Vector3(1, 1, 1))

	# Packed 数组
	var pi := Codec.decode({"valueType": "PackedInt32Array", "value": [1, 2, 3]}, TYPE_PACKED_INT32_ARRAY)
	check("packed_int32", pi["ok"] and pi["value"] == PackedInt32Array([1, 2, 3]))
	var pb := Codec.decode({"valueType": "PackedByteArray", "value": [1, 300]}, TYPE_PACKED_BYTE_ARRAY)
	check("packed_byte_range_rejected", not pb["ok"])
	var ps := Codec.decode({"valueType": "PackedStringArray", "value": ["a", "b"]}, TYPE_PACKED_STRING_ARRAY)
	check("packed_string", ps["ok"] and ps["value"] == PackedStringArray(["a", "b"]))

	# 兼容:未给 valueType 时,裸字典按期望类型解释
	var bare := Codec.decode({"x": 7, "y": 8}, TYPE_VECTOR2)
	check("bare_dict_by_expected_type", bare["ok"] and bare["value"] == Vector2(7, 8))

	# encode→decode 回灌:写入回执里的类型描述必须能原样写回去
	var round_trip := Codec.encode(Vector3(1.5, -2.25, 3))
	var back := Codec.decode(round_trip, TYPE_VECTOR3)
	check("round_trip_vector3", back["ok"] and back["value"] == Vector3(1.5, -2.25, 3))

	print("T2SUMMARY|fails=" + str(fails))
	quit()
