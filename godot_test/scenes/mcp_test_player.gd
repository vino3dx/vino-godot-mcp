class_name MCPTestPlayer
extends CharacterBody2D

## T13-C1 测试用脚本:用来验证 Editor Bridge 能读到真实脚本绑定(scriptPath)
## 与脚本里的 class_name(className),而不是只读磁盘文本。

signal test_signal(value: int)

const MAX_HEALTH := 100

enum State { IDLE, RUN, JUMP }

@export var move_speed: float = 120.0
@export var player_label: String = "MCPTestPlayer"

var state: State = State.IDLE
var health: int = MAX_HEALTH


func _physics_process(_delta: float) -> void:
	if Input.is_action_pressed("ui_right"):
		state = State.RUN
	else:
		state = State.IDLE
