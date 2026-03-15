# Nightwatch Protocol

For extended autonomous builds — multi-hour tasks that run without supervision.

## When to use
- Task requires 5+ sequential steps
- User has explicitly said "keep going until done"
- Expected duration > 1 hour

## Rules
1. Write a plan before starting — share it with the user
2. Checkpoint every major step — update memory
3. The bridge runs via launchd — no nohup needed. For long agent tasks, write progress to today's memory note so work survives a session reset.
4. Test before claiming done — verify the artifact
5. If blocked, stop and message the user — don't guess

## Checkpoint format
At each checkpoint, append to today's memory file:
```
## Nightwatch Checkpoint — HH:MM
- Completed: [what just finished]
- Current: [what's running now]
- Next: [what's after this]
- Blockers: [anything stuck]
```
