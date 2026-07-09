# shard-db-agent

A stateful, schema-agnostic natural-language agent for [shard-db](https://github.com/sayyiditow/shard-db). Give it English text plus a `describe-object` schema; it holds conversation state across turns and produces read queries to run, an answer, or a proposed write for the host app to confirm and execute — never writing to shard-db itself.

Design status: **design complete, not yet implemented.** See [`docs/plans/2026-07-06-shard-db-agent-design.md`](docs/plans/2026-07-06-shard-db-agent-design.md) for the full spec (architecture, decisions, error handling, testing).
