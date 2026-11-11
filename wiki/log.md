# Log

Append-only chronological record of ingests, filed queries, lint passes, schema
changes, and maintenance.

## [2026-11-11] schema | Initialize LLM wiki

- Created the raw source and asset folders and the five wiki content folders.
- Created `AGENTS.md`, `README.md`, `wiki\index.md`, and `wiki\log.md`.
- Added `.gitkeep` placeholders so empty folders can be tracked in Git.
- No real sources have been added or ingested.

## [2026-11-11] schema | Add local document library UI

- Added a loopback-only browser UI for document uploads, search, downloads,
  Markdown/wiki browsing, and viewing this activity log.
- Kept original sources immutable and wiki edits agent-driven; uploads do not
  trigger ingestion or contact an AI service.
- Updated `README.md` and `AGENTS.md` with launch instructions, supported formats,
  privacy boundaries, and disposable-workspace checks.
- No real sources were added or ingested as part of this application change.

## [2026-11-11] schema | Add optional Windows sign-in startup

- Added a per-user scheduled-task installer and a local dashboard launcher with
  readiness checking, browser opening, and Git-ignored runtime logs.
- Added a workspace-specific health endpoint without document content.
- Documented startup, disabling/removing the task, and VDI policy requirements.
- No source documents were added, ingested, or modified.
- The launcher uses a Windows job to stop its own server when the task stops,
  without affecting reused servers or unrelated processes.
