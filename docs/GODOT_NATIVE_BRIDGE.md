# Godot Native Object Bridge

## Purpose

**Vino Godot MCP** (`vino-godot-mcp`) is a Godot semantic-operation MCP for AI agents. Its primary job is to inspect, create, modify, organize, and validate Godot objects: scenes, nodes, signals, groups, resources, and project settings.

The TypeScript side remains a safe offline/file channel. It must not claim to be an authoritative object channel: a `.tscn` or `.tres` parser cannot fully reproduce Godot's runtime types, defaults, editor state, resource validation, or serialization behavior. The editor-side addon fills exactly that gap for the scene that is currently open, including unsaved edits.

## Two channels

### Native channel (authoritative for live editor state)

The EditorPlugin in `godot_test/addons/vino-godot-mcp/` owns everything that requires Godot semantics inside the running editor:

- `ClassDB`, `Object`, `Node`, and `SceneTree` inspection of the edited scene
- node creation, parenting, ownership, and property assignment
- editor selection and Inspector focus
- `EditorUndoRedoManager` integration, so every agent write is a native undo step
- structured Error/Warning capture through `OS.add_logger`
- event push for scene lifecycle, in-memory tree changes, selection, history, and logs

### File channel (supporting)

The TypeScript services remain responsible for:

- project and asset discovery
- lossless text parsing and diff generation
- safe file writes and optimistic hashes
- static GDScript and shader analysis
- offline inspection when the editor/engine is unavailable
- **saving** the `.tscn` / `.tres` / `.gd`: the bridge never writes project files
- audit, backup, and recovery information

File-channel results identify themselves as static/offline when they are not engine-validated.

## Bridge contract (implemented)

Transport: the EditorPlugin listens on a localhost loopback TCP port and publishes `.vino-godot-mcp/bridge.json` (`host`, `port`, `token`, `sessionId`, `projectId`, `pid`, `projectPath`, `protocolVersion`). The MCP server reads that descriptor, verifies the project identity, and speaks length-prefixed JSON frames:

```text
request:  { protocolVersion, requestId, token, method, params }
response: { protocolVersion, requestId, success, data | error }
event:    { protocolVersion, sessionId, event: { seq, type, at, data } }
```

Frame header is a 4-byte **little-endian** length followed by UTF-8 JSON (`PackedByteArray.encode_u32` is little-endian in Godot 4.6.3 — verified on the real engine).

Required properties, all satisfied:

- explicit request IDs and one response per request
- capability discovery before semantic writes (`project_capabilities.nativeCapabilities`, `bridgeMethods`)
- structured Godot error information (stable codes, not free-form strings)
- object identity that is stable for one bridge session, not guessed from memory addresses
- post-operation read-back for writes (every write returns typed `before`/`after`)
- undo integration instead of irreversible mutation
- no protocol/debug output mixed into MCP stdio

## Write channel and undo

Writes are committed through `EditorUndoRedoManager`:

| Bridge method | Undo action |
|---|---|
| `editor_set_node_property` | `add_do_property` / `add_undo_property` |
| `editor_add_node` | do: `add_child` + `set_owner`; undo: `remove_child` |
| `editor_remove_node` | do: `remove_child`; undo: `add_child` + `move_child(index)` |
| `editor_select_node` | none — Godot does not record selection in the undo history |
| `editor_undo` / `editor_redo` | run on the scene's own history |

`create_action(..., mark_unsaved = true)` makes the editor mark the scene as modified, which is why an agent edit behaves like a manual one (dirty marker, save prompt) while never writing the file. The edited scene root cannot be removed. Object/Resource properties are refused rather than deep-serialized.

Godot 4.6's `EditorInterface` exposes `mark_scene_as_unsaved()` but **no scene-dirty query**, so `isDirty` is still reported as `null` with an explicit reason; "was this saved?" is answered by `scene_saved` events, not by guessing.

## Event push

Events are numbered with a monotonic `seq` inside the editor session and always land in a bounded ring buffer first, then are pushed while a peer is connected. That keeps them lossless across MCP restarts: `editor_get_events` merges pushed frames with the ring buffer by `seq`, so no event is lost and none is duplicated.

| Type | Data |
|---|---|
| `scene_changed` / `scene_closed` / `scene_saved` | scene path, root name/class, open scenes, history |
| `scene_tree_changed` | in-memory tree snapshot (paths, types, depths) + node count + fingerprint |
| `selection_changed` | selected paths plus `focus` (path, type, Inspector property values) |
| `history_changed` | `canUndo`, `canRedo`, `historyCount`, `currentAction` |
| `log` | `level` (`error`/`warning`), message, and function/file/line/code for engine errors |

`scene_tree_changed` is driven by a 0.4 s fingerprint poll plus `history_changed`, because the editor exposes no public "scene content changed" signal. Plain `print` output is deliberately **not** streamed: only Error and Warning lines go through `OS.add_logger`, rate limited per second.

## Capability layers

1. `inspect`: class, property, signal, group, scene, and resource metadata.
2. `read`: authoritative object snapshots of the edited scene.
3. `plan`: validated intended changes without saving (partially covered by file-channel `dryRun`; the bridge has no plan mode).
4. `apply`: bounded mutations with read-back and native undo.
5. `validate`: scene/resource/reference checks after mutation (still file/engine channel; not a bridge method).

## Runtime boundary

Runtime launch, logs, screenshots, and process lifetime management are supporting capabilities for validation and debugging. They are not the product center and must not be allowed to dictate the object model. The editor's `log` events describe the editor process only; they are not a substitute for `runtime_read_session_logs` on a launched game.

## Current truth

- Scene/resource **writes to disk** operate through TypeScript parsers and safe file writes.
- `scene_get_node_info` uses an engine-generated ClassDB dump, which is metadata only; it is not an object bridge.
- The EditorPlugin is part of the repository (`godot_test/addons/vino-godot-mcp/`) and exposes reads (`editor_get_scene`, `editor_get_tree`, `editor_get_node`, `editor_get_layout`, `editor_get_events`, `project_capabilities`), UndoRedo-backed writes (`editor_set_property`, `editor_add_node`, `editor_remove_node`, `editor_select_node`, `editor_undo`, `editor_redo`) and an event stream.
- The bridge never saves scenes and never writes project files; `EditorUndoRedoManager` is the owner of every undo step it creates.
- Windows process-tree management remains separate infrastructure and is intentionally not a prerequisite for this bridge.
