# Feature: CLI Context Orchestrator

## Objective
Allow IssueTriage users and automation to run curated workspace command-line utilities from the panel or command palette, capture their output, and feed the results directly into downstream LLM requests.

## User Value
- Automates repetitive context gathering steps before invoking AI assistance.
- Supports bespoke scripts that encode team-specific heuristics without baking them into the extension codebase.
- Improves assessment fidelity by ensuring prompts include the freshest repository insights.

## Toolchain Workflow
1. **Tool Registration**
   - Extension ships a curated catalog of first-party tools registered in code; users can enable/disable them per workspace.
   - Users may declare additional CLI utilities (name, entry command, description, expected output format) via settings or manifest.
   - Optional input schema defines parameters exposed in the panel UI.
2. **Execution & Observation**
   - Panel surfaces actions to run registered tools in the current workspace context.
   - Extension executes commands in a controlled environment, capturing stdout/stderr, exit codes, duration, and file artifacts.
3. **Result Normalization**
   - Output is parsed into structured envelopes (JSON, text, file paths) stored in workspace state with metadata and TTL.
   - Errors are summarized with remediation hints for user review.
4. **Prompt Integration**
   - Assessment and automation flows can request the latest tool outputs by logical name.
   - Prompt composer merges tool results into LLM context packets with size-aware truncation.

## Functional Requirements
- Provide settings namespace `issuetriage.cliTools` for tool registration, including command, working directory override, timeout, and output type.
- Offer UI affordances in the IssueTriage panel to run tools, review last results, and re-run on demand.
- Enable command palette entry `IssueTriage: Run Context Tool` with quick pick of registered utilities.
- Capture telemetry for executions (success, failure, duration) while respecting opt-out preferences.
- Expose API for other extension components to subscribe to tool result updates.

## Technical Notes
- Leverage Node.js `child_process.spawn` with shell disabled by default to mitigate injection risks; allow opt-in shell execution with warnings.
- Enforce maximum runtime and output size limits; terminate processes exceeding thresholds.
- Sanitize environment variables passed into tools and document how to propagate required secrets securely.
- Store recent outputs in `StateService` (workspace scope) and persist file artifacts under a managed temp directory.
- Define JSON schema for tool descriptors to support validation and future marketplace sharing.

## Dependencies
- Existing `SettingsService` and `StateService` for configuration and persistence.
- Telemetry infrastructure for usage tracking.
- Assessment engine prompt composer to consume tool outputs.

## Open Questions
- Do we need sandboxing or policy enforcement for shared workspaces? (Investigate enterprise requirements.)
- Should tool execution be logged for audit trails beyond telemetry? (Coordinate with compliance stakeholders.)
- How do we surface long-running tool progress within the panel? (Progress UI design TBD.)

## MVP Acceptance Criteria
- Users can register at least one CLI tool via settings and run it from the panel.
- Command output is captured, normalized, and displayed in the panel with rerun support.
- Assessment flow can include the most recent tool output in an LLM request payload.
- Failures provide actionable error messages without crashing the extension host.

## Post-MVP Enhancements
- Marketplace or workspace-level sharing of tool manifests.
- Sequential tool pipelines (run A then B, auto-inject outputs).
- Remote execution adapters (e.g., trigger tools through MCP servers or cloud functions).
