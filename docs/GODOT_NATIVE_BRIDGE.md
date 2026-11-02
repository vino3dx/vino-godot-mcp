# Godot Native Object Bridge

## Purpose

**Vino Godot MCP** (`vino-godot-mcp`) is a Godot semantic-operation MCP for AI agents. Its primary job is to inspect, create, modify, organize, and validate Godot objects: scenes, nodes, signals, groups, resources, and project settings.

The current TypeScript implementation is a safe offline/file channel. It must not claim to be an authoritative object channel: a `.tscn` or `.tres` parser cannot fully reproduce Godot's runtime types, defaults, editor state, resource validation, or serialization behavior.

## Two channels

### Native channel (authoritative)

The future Godot-side bridge owns operations that require Godot semantics:

- `ClassDB`, `Object`, `Node`, and `SceneTree` inspection
- node creation, parenting, ownership, and property assignment
- signal and group operations
- `ResourceLoader` / `ResourceSaver`
- `PackedScene`, `SubResource`, and `ExtResource` resolution
- `ProjectSettings` operations that require engine interpretation
- post-write validation using Godot itself

### File channel (supporting)

The existing TypeScript services remain responsible for:

- project and asset discovery
- lossless text parsing and diff generation
- safe file writes and optimistic hashes
- static GDScript and shader analysis
- offline inspection when the editor/engine is unavailable
- audit, backup, and recovery information

File-channel results must identify themselves as static/offline when they are not engine-validated.

## Proposed bridge contract

The first bridge should be request/response based and versioned. The MCP process must not depend on editor internals directly.

```text
request:  { id, protocolVersion, projectRoot, operation, target, arguments }
response: { id, ok, protocolVersion, data?, diagnostics?, error? }
```

Required properties:

- explicit request IDs and one response per request
- capability discovery before semantic writes
- structured Godot error information
- object identity that is stable for one bridge session, not guessed from memory addresses
- dry-run/plan support where the editor API permits it
- post-operation read-back for writes
- no protocol/debug output mixed into MCP stdio

The transport is intentionally undecided until an EditorPlugin prototype is tested. Candidate transports are a localhost loopback channel or a project-local IPC mechanism; neither is accepted as implemented yet.

## Capability layers

1. `inspect`: class, property, signal, group, scene, and resource metadata.
2. `read`: authoritative object snapshots.
3. `plan`: validated intended changes without saving.
4. `apply`: bounded mutations with read-back.
5. `validate`: scene/resource/reference checks after mutation.

The first vertical slice should be read-only: connect to a Godot project, discover capabilities, inspect a loaded scene tree, and inspect one Resource. Writes should follow only after identity, lifecycle, and error behavior are proven.

## Runtime boundary

Runtime launch, logs, screenshots, and process lifetime management are supporting capabilities for validation and debugging. They are not the product center and must not be allowed to dictate the object model.

## Current truth

- Scene/resource tools currently operate through TypeScript parsers and safe file writes.
- `scene_get_node_info` uses an engine-generated ClassDB dump, which is metadata only; it is not an object bridge.
- No EditorPlugin or native object RPC endpoint is currently part of the repository.
- Windows process-tree management remains separate infrastructure and is intentionally not a prerequisite for this bridge.
