# Agent Messaging Protocol

Agents communicate asynchronously by writing JSON files to each other's inbox directories.

## Format

Write to: `~/claude-agents/{target-agent}/inbox/{from}_{timestamp}.json`

```json
{
  "from": "your-agent-name",
  "to": "target-agent-name",
  "subject": "Brief subject line",
  "body": "Full message body",
  "priority": "normal",
  "created_at": "2026-01-01T00:00:00Z"
}
```

## Priority levels
- `urgent` — read immediately at session start
- `normal` — read during regular check-ins
- `low` — batch-read periodically

## Rules
- Target agent reads inbox at session start and periodically during long tasks
- After reading, move the file to `inbox/processed/` or delete it
- Never write to your own inbox — use memory files for self-notes
