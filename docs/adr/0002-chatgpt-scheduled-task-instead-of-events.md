---
status: accepted
date: 2026-11-01
---

# The Context owner polls through a ChatGPT scheduled task; no MCP Events, no OAuth

ChatGPT cannot be woken by the factory without MCP Events, which require an OAuth 2.1
authorization server reachable by ChatGPT (the SF-010 feasibility report and probe). The User
verified that a ChatGPT scheduled task created in the planning conversation can call the connector
on an interval. So the factory exposes `check`, tells the Context owner when to check next
(configurable: longer after the first Iteration, shorter after a Fix section), and the Context owner
creates its own task. Keycloak, MCP Events, webhooks and the OpenClaw transport are therefore
removed. The first pilot must confirm that the task runs with the planning conversation's context;
if it does not, the Task file must carry a review brief written at planning time.

## Considered options

- The User prompting "review" each Iteration: rejected, the User does not want to type anything.
- An API reviewer (Claude or OpenAI API): rejected, the reviewer must be the one who planned.
- MCP Events with a self-hosted OAuth server: rejected for cost and unproven tunnel routing.
