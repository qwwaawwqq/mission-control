# Dispatcher setup (once, about 30 minutes)

The dispatcher (`dispatch/dispatcher.mjs`, run by `.github/workflows/dispatch.yml` every 15 minutes) decides who works on what and wakes a Claude routine only when that routine has a task. It uses no AI itself, and because this repo is public its Actions minutes are free. Until the secrets below exist it does nothing.

## 1. One routine per Claude account

On each account, go to claude.ai/code (connect GitHub if asked), then claude.ai/code/routines → **New routine**:

| Account | Name | Repositories | Model | Prompt |
|---|---|---|---|---|
| 2 | `AI team · admin` | every agent repo, fenced ones included | Fable (Opus if Fable isn't offered) | `admin-prompt.md` |
| 1 | `AI team · claude-1` | only the fenced repo(s), e.g. the trading app | Opus | `agent-prompt.md` |
| 2 | `AI team · claude-2` | every other agent repo | Opus | `agent-prompt.md` |
| 3 | `AI team · claude-3` | every other agent repo | Sonnet | `agent-prompt.md` |
| 4 | `AI team · claude-4` | every other agent repo | Sonnet | `agent-prompt.md` |

- **Prompt:** the text of that row's prompt file with `AGENT_NAME` replaced by the row's name (for example `claude-3`) and `OWNER` by your GitHub user. The administrator never writes code, so it may see the fenced repos.
- **Environment:** Default. **Connectors:** remove all.
- **Trigger:** no schedule. Add trigger → **API** → **Generate token**. Copy the URL and the token (the token is shown once).

Keep fenced repos (the ones whose `.claude/settings.json` blocks human-only files) in a routine of their own, so their blocks always apply.

## 2. Secrets in this repo

GitHub → this repo → Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Value |
|---|---|
| `ROUTINE_ADMIN`, `ROUTINE_CLAUDE_1` … `ROUTINE_CLAUDE_4` | the routine's URL on the first line, its token on the second |
| `DISPATCH_GH_TOKEN` | a fine-grained token named `dispatcher`, with only the agent repos selected; repository permissions **Issues: Read and write**, **Pull requests: Read and write**, **Actions: Read**, **Contents: Read** |

A routine without its secret is shown as "off" and simply gets no work.

## 3. Home labels

A repo with the label `home:claude-1` is served only by claude-1, which is how fenced repos stay with their own routine. Other agent repos have no `home:` label and go to claude-2/3/4.

## 4. Switch over

Turn off any old hourly routines, then Actions → **dispatch** → **Run workflow** once. The log prints counts only, for example `{"repos":4,"fired":2,...}`, plus each agent's load.

## How tasks are routed

| What | Goes to |
|---|---|
| new `ready` issue without a size | the administrator (Fable) sizes it first, at most one pass every 3 hours; after 60 minutes it is built anyway as `size:M` |
| `plan` issue | the administrator (Fable) splits it into sized `ready` issues; if it is busy, an Opus agent |
| `size:L` | an Opus agent (claude-1 in its home repo, otherwise claude-2) |
| `size:S` / `size:M` | the least busy Sonnet agent (claude-3 or claude-4); claude-1 in its home repo |
| `ui` or `to:antigravity` | Antigravity on your Mac: queued, nobody is woken |
| `to:codex` | queued for Codex: start it from chatgpt.com/codex |
| agent PR with failing CI or review findings | its own agent once, then `@codex fix`, then you (`blocked`) |

Safeguards against draining usage:
- Each agent has a 5-hour and a 7-day cap on tasks and gets at most one new task per hour; each account also has a 5-hour cap across all its routines (all in `config.json`).
- An agent that does not claim its task within 45 minutes is treated as out of usage for 5 hours, and the task moves on.
- A claim with no PR after 3 hours is freed.
- An open issue labelled `pause` stops everything in that repo.

## Antigravity (optional)

In Antigravity on the Mac, add a scheduled task (hourly, while the app runs):

> In my GitHub repos, find the oldest open issue labelled `to:antigravity` without `claimed`. Add `claimed`, comment `Claimed by antigravity`, follow the repo's AGENTS.md, work on a new branch, run the tests, and open a pull request whose body starts with `Agent: antigravity` and `Closes #N`. Never push to the default branch. One issue per run.

Antigravity is not bound by `.claude/settings.json`, so don't give it `ui` issues in fenced repos.
