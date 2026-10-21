---
name: opencode-bridge
description: Talk to the user's local opencode v2 sessions through the OpenCode Bridge MCP server. Use when the user asks what their OpenCode agent is working on, wants to read an existing OpenCode session, wants to send instructions to their agent and get a reply, wants a status/progress update, wants to review what the agent implemented, or wants to keep a back-and-forth going with the same OpenCode session.
---

# OpenCode Bridge

Access the opencode v2 sessions running on this machine. The user's agent is a
real, long-running session with its own history - prefer attaching to it over
creating anything new.

## Workflow

1. **Find the session.** `opencode_list_sessions` returns the bridge's sessions
   and the real opencode sessions on disk, newest first, with their `directory`.
   If the user names a project, match on the title or `directory`.
2. **Attach.** `opencode_attach_session` with the `opencodeSessionId`. It does
   not create a session; it binds to the existing one and returns a
   `bridgeSessionId` used by every other tool. Attaching to a session outside
   the configured roots is refused by design - report that instead of retrying
   with another path.
3. **Read.** `opencode_get_messages` returns the transcript oldest-first.
   `opencode_get_session_status` gives running/idle state, the last outcome and
   any pending permission requests.
4. **Send.** `opencode_send_message` returns as soon as opencode accepts the
   prompt. Use `wait: true` (with `timeoutMs`) when you need the answer in the
   same turn, or `opencode_wait_for_completion` afterwards.
5. **Poll without duplicates.** Keep the `accepted.id` from the send and pass it
   as `sinceMessageId` on the next `opencode_get_messages`; you then only get
   messages newer than that one.
6. **Review.** `opencode_get_diff` before claiming any code work is finished.
   `opencode_vcs_status`, `opencode_read_file` and `opencode_find_files` read the
   project.

## Rules

- **Never** approve a permission request on the user's behalf.
  `opencode_list_permissions` shows what opencode is waiting on;
  `opencode_respond_permission` requires an explicit human decision
  (`once`, `always` or `reject`). Surface the request and let the user choose.
- Never create a new opencode session when an existing one matches the user's
  request; use `opencode_attach_session`.
- Keep the same attached session for the whole conversation so context
  accumulates. Re-attaching to a different session loses the thread.
- A session's directory is where opencode was launched, not the repo being
  edited. Sessions the user started from their home directory will only be
  listed when home is inside the allowed roots.
- Report completion honestly: if `completion.completed` is false or
  `timedOut` is true, say the agent has not finished yet instead of guessing.
