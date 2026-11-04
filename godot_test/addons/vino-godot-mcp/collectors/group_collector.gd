@tool
extends RefCounted

## 分组采集（只读）。
##
## 重要：Godot 编辑器会给画布相关的节点自动挂内部组（形如 "_root_canvas123"），
## 这些不是用户在场景里加的分组。UI 会把这些名字以下划线开头的内部组过滤掉并单独计数；
## Bridge 既有输出保持原样（不做过滤），以免改变 MCP Server 已经拿到的数据。

const NodeCollector := preload("node_collector.gd")

const INTERNAL_PREFIX := "_"


static func collect(root: Node, pairs: Array) -> Dictionary:
	var members := {}
	var internal := {}
	var member_links := 0
	var nodes_with_groups := 0
	for pair in pairs:
		var node: Node = pair["node"]
		var node_path := NodeCollector.rel_path(root, node)
		var has_real_group := false
		for group in node.get_groups():
			var group_name := str(group)
			if group_name.begins_with(INTERNAL_PREFIX):
				if not internal.has(group_name):
					internal[group_name] = []
				internal[group_name].append(node_path)
				continue
			if not members.has(group_name):
				members[group_name] = []
			members[group_name].append(node_path)
			member_links += 1
			has_real_group = true
		if has_real_group:
			nodes_with_groups += 1

	var group_names: Array = members.keys()
	group_names.sort()
	var groups: Array = []
	for group_name in group_names:
		var group_members: Array = members[group_name]
		group_members.sort()
		groups.append({
			"name": group_name,
			"members": group_members,
			"count": group_members.size(),
		})
	var internal_names: Array = internal.keys()
	internal_names.sort()
	return {
		"groups": groups,
		"groupCount": groups.size(),
		"memberLinks": member_links,
		"nodesWithGroups": nodes_with_groups,
		"internalGroups": internal_names,
		"internalGroupCount": internal_names.size(),
	}
