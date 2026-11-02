# Project Direction

**Vino Godot MCP** (`vino-godot-mcp`) is an AI-agent Godot development system, not primarily a process launcher or a collection of file CRUD tools.

The product loop is:

```text
Inspect -> Understand -> Plan -> Apply -> Save -> Run -> Verify -> Report
```

The File Layer remains valuable for offline project scanning, lossless diffs, scripts, shaders, configs, and assets. The Native Layer is responsible for authoritative Editor/Runtime object state. Runtime is supporting verification infrastructure.

All Native features must be tested independently against Godot Standard and Godot .NET. Language-specific C# analysis is separate from the shared Bridge and is not a prerequisite for Bridge compatibility.

Historical notes that describe the project only as a text-file MCP are superseded by this direction, but their implementation details remain valid as File Layer documentation.
