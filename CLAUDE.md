# CLAUDE.md

Guidance for Claude Code when working in this repository.

@CORE-PROCESS.md

## Standing exceptions for this repo

- **Execution mode:** commit locally per task during plan execution (each task ends with its own local commit, per `superpowers:writing-plans`) — work stays unpushed until Sonnet's review pass and the user's explicit go-ahead.
- **Build/test commands:** `bun install`; `bun test`; `bun run typecheck`.
- **Co-author line(s):** planning/review and execution are different models here — the per-task commits made during execution get two lines: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` for the planning/review pass, plus a second `Co-Authored-By:` line for whichever external model actually executed the task, using that model's own name and noreply address. Confirm the executing model with the human before writing the second line — never guess it.

## Overview

TypeScript core library for a stateful, schema-agnostic natural-language agent over shard-db. See `docs/plans/2026-07-06-shard-db-agent-design.md` for the full design spec and `docs/plans/2026-07-09-core-library-implementation.md` for the current implementation plan. Zero shard-db runtime dependency — see Global Constraints in that plan.
