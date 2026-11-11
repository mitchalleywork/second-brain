# Work Second Brain

A local, Markdown-based knowledge wiki maintained with an AI coding agent.
Inspired by [Andrej Karpathy's LLM Wiki idea](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
and built from the guides in the neighboring `setup-work-second-brain` repository.

## Structure

```text
work-second-brain\
  raw\
    sources\       Original documents and captured Markdown
    assets\        Images and attachments
  wiki\
    sources\       Source summaries and provenance
    entities\      People, teams, organizations, and projects
    concepts\      Reusable ideas and terminology
    questions\     Answers explicitly saved from queries
    synthesis\     Analyses across multiple sources
    index.md       Content catalog
    log.md         Append-only activity history
  AGENTS.md        Wiki schema and agent operating instructions
  README.md        This guide
```

`raw\` is the immutable source layer. `wiki\` is the curated knowledge layer.
The `.gitkeep` files only preserve empty folders in Git; they are not sources.
Uploading a source does not automatically ingest it into the wiki.

## Local web UI

Requires Node.js 20 or later. No packages, API keys, or external services are
needed. In PowerShell:

```powershell
Set-Location 'C:\Users\U295398\Desktop\Development\GitHub\work-second-brain'
npm start
```

Open `http://127.0.0.1:4177`. Keep that terminal running; press Ctrl+C to stop.
If the port is occupied, set `$env:PORT = '4178'` before running `npm start`
and use that port in the URL.

The UI provides:

- Multiple-document upload through the file picker or drag-and-drop.
- A searchable source library, wiki reader, index, and activity log.
- Rendered Markdown with navigable wiki links, plus plain-text previews.
- Original-file downloads and a copy-path action for agent ingestion prompts.
- Refresh to pick up wiki changes made by your coding agent.

Uploads are limited to 20 MB each. Supported formats: `.md`, `.markdown`,
`.txt`, `.log`, `.pdf`, `.docx`, `.xlsx`, `.pptx`, `.rtf`, `.csv`, `.json`,
`.html`, `.htm`, `.xml`, `.yaml`, and `.yml`. Files go to `raw\sources\`
under their original filenames. Duplicate names are rejected, not overwritten;
rename a new version before uploading it.

Markdown and text-based files have previews and content search covering the
first 1 MB per file. PDF, Office, and RTF files are downloadable and searchable
by filename only; no text extraction or AI ingestion is performed. Uploaded
HTML is shown as plain text, never executed. The lightweight Markdown reader
supports headings, paragraphs, lists, quotes, code, emphasis, and links, not
every Markdown extension or Obsidian feature.

The server listens only on `127.0.0.1`, blocks cross-origin document/API requests, and uses
a workspace token for uploads. It is intended for a single trusted local
user, not shared hosting or multi-user access control. Do not expose its port
through a public proxy or tunnel. No document text is sent to external services.

Run the focused checks with `npm test`; they use temporary workspaces and do
not modify your documents.

## Start automatically at Windows sign-in

Run this once in a normal Windows PowerShell window:

```powershell
Set-Location 'C:\Users\U295398\Desktop\Development\GitHub\work-second-brain'
.\scripts\Install-Autostart.ps1
```

The `Work Second Brain` scheduled task runs only as your signed-in user, with
limited privileges and no stored password. About 15 seconds after sign-in it
starts Node.js in the background, waits for the correct workspace to become
ready, then opens `http://127.0.0.1:4177` in your default browser. It does not run
before sign-in or on every screen unlock.

The task has no execution time limit, ignores duplicate starts, and retries a
failed launcher up to three times at one-minute intervals. The launcher monitors
a server it starts and ties it to a Windows job so stopping the task also stops
that server. An already-running, matching server is reused without taking
ownership of it; unrelated listeners are never stopped.

To start the task manually:

```powershell
Start-ScheduledTask -TaskName 'Work Second Brain'
```

To disable automatic startup without deleting documents:

```powershell
Disable-ScheduledTask -TaskName 'Work Second Brain'
```

Disabling does not stop a running dashboard. To stop the scheduled task and its
server, use `Stop-ScheduledTask -TaskName 'Work Second Brain'`. To remove the
startup registration, use:

```powershell
Unregister-ScheduledTask -TaskName 'Work Second Brain' -Confirm:$false
```

Logs are in `.runtime\startup.log`, `.runtime\server.log`, and
`.runtime\server-error.log` and are excluded from Git. The server logs cover the
most recently launched server; the startup log is append-only.

Windows must permit per-user scheduled tasks and local PowerShell scripts.
The launcher compiles the bundled `scripts\StartupJob.cs` helper with PowerShell's
built-in `Add-Type`; no separate compiler installation or downloaded package is
needed. Environments that block `Add-Type` require administrator approval.
The installer does not elevate privileges, change execution policy, or bypass
company restrictions. If policy blocks it, ask your VDI administrator to approve
the task and scripts. The project folder and Node.js installation must survive
VDI restarts; if the folder moves, reinstall the task from the new location
after removing the old registration.

## First use

1. Start the UI, and open this folder in Copilot, Codex, or another agent that
   reads `AGENTS.md`.
2. Upload an approved source through the UI or save it in `raw\sources\`,
   for example `2026-11-11-project-notes.md`.
3. Ask the agent:

   ```text
   Please ingest raw\sources\2026-11-11-project-notes.md into the wiki.
   ```

4. Review the source summary, relevant entity and concept pages, index, and log.
5. Explicitly request a Git commit when you want to checkpoint the changes.

An ingest never edits the original source. Corrections belong in a new source
or in the wiki with clear provenance.

## Query and maintain

Ask questions against the wiki, such as:

```text
What open questions remain across the sources already ingested?
```

Queries do not change files unless you ask to save the answer:

```text
Answer this using the wiki, then file the answer in wiki\questions\.
```

Periodically request a maintenance pass:

```text
Please lint the wiki for stale claims, contradictions, orphan pages, missing
cross-links, broken links, weak provenance, and missing index entries.
```

## Capture tool

The setup guide references the separate
[capture-notes-utility](https://github.oshkoshglobal.com/U289975/capture-notes-utility?tab=readme-ov-file#capture-notes-utility).
It is not bundled or installed by this project.

If you install it through an approved process, configure its output directory as:

```text
C:\Users\U295398\Desktop\Development\GitHub\work-second-brain\raw\sources
```

Keep attachments in `raw\assets\`. Capturing a document does not ingest it:
ask the agent to ingest each source after reviewing it.

## Optional Obsidian browsing

Open this project's root folder as an Obsidian vault. Configure attachments to
use `raw\assets\`. Wiki pages use Obsidian-style links and can be explored in
graph view. No plugin is required.

## Privacy and Git

Use only company-approved tools, storage, and model access for work material.
Never add credentials or secrets. Before sharing this repository, review both
the raw sources and wiki for sensitive information and access requirements.

This project uses a local Git repository. No initial commit or remote connection
is created automatically. Commit only when explicitly requested, and push only
when explicitly requested to an approved private remote. A local repository is
not a remote backup.

Global agent settings have not been changed. To opt in to using this wiki from
other projects, you can separately add this protocol to your global agent
instructions:

```text
At the start of each new session, ask whether I want to reference my second
brain at C:\Users\U295398\Desktop\Development\GitHub\work-second-brain.
Do not read, search, or summarize it unless I explicitly say yes.
If I say yes, read AGENTS.md and wiki\index.md first, then only relevant pages.
Treat raw\ as immutable. Update wiki\ only when I ask.
Commit or push only when I explicitly request that Git action.
```
