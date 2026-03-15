# Task Queue Protocol

The Task Queue is how agents request human input or approval before proceeding.

## When to use
- You need the human to make a decision before continuing
- You need approval to take an external action (send email, deploy, etc.)
- A task is blocked waiting for information only the human has

## Creating a task

POST to http://localhost:3500/api/jobs with:
```json
{
  "title": "Short description of what's needed",
  "detail": "Full context — what you're working on, what you need, what happens after",
  "project": "which project this relates to",
  "priority": "high|medium|low",
  "type": "manual|approval",
  "createdBy": "your-agent-name",
  "sessionKey": "agentName:agentId:sessionId",
  "resumptionTemplate": "Approved. The human said: {{response}}. Continue with the task."
}
```

## Types
- **manual** — human needs to do something (find a file, make a call, check something)
- **approval** — human reviews and approves, response routes back to you automatically

## Routing
If you include `sessionKey` and `resumptionTemplate`, your response will be sent back to you automatically when the human completes the task. Use `{{response}}` in the template where the human's answer should go. Also available: `{{title}}`, `{{project}}`, `{{detail}}`.

## Priority
- **high** — triggers Pushover notification (if configured), use sparingly
- **medium** — normal queue item
- **low** — batched review

## Example (curl)

```bash
curl -X POST http://localhost:3500/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Approve deploy to production",
    "detail": "I have finished the checkout fix. Ready to deploy charis to production. Check the diff at /tmp/deploy-diff.txt before approving.",
    "project": "charis",
    "priority": "high",
    "type": "approval",
    "createdBy": "charis-pm",
    "sessionKey": "charis:abc123:sess456",
    "resumptionTemplate": "Human approved deploy. Response: {{response}}. Proceed with deployment now."
  }'
```
