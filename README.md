# Mission Control — one page for all AI-team projects

A single static web page (`index.html`, no build step, no server) that watches every repo
your Claude / Codex / Antigravity agents work on and tells you what needs **you**.

It talks to GitHub directly from your browser with a fine-grained token. The token is kept only in
that browser (`localStorage`) and is sent only to `api.github.com`. This repo contains no token and
no repo names: the page finds your agent repos by itself (every repo of yours that has the agents'
`ready` label, which each routine creates on its first run).

## What it shows

The page is built around one question — *what do I need to do?* — so it opens on **Today**, not on a census of normal work. Seven views sit in the top bar (a bottom tab bar on a phone); the badges on them carry the counts, and the tab title and icon carry the same colour.

| View | What it shows |
|---|---|
| **Today** | One sentence saying how many things need you and the most urgent one, then four tiles: needs you, the next deadline (live countdown), agents stuck or idle, pull requests merged in 7 days. Below, **Needs you** groups every item into *Now*, *Today* and *This week*, with filters (urgent, deadlines, decisions & blocked, pull requests, portfolio, agents & system). Each item says what happened, what to do next and by when, with one main button: deadlines open now, **decision briefs** (one tap approves the recommendation), specs an agent could not build from (`needs-spec`), `blocked` issues, pull requests waiting for you, builds held back because too many agent PRs wait for review, portfolio rows due for a check, the weekly review, dead claims (unclaim), **agents woken but never started, with the likely cause** (routine missing the repo vs. out of usage), a late or failing dispatcher, CI failing on a default branch, idle agents, items outside the labels and Actions minutes. **Snooze** hides an item for a day (kept in this browser) and the toast offers **Undo**. On the side: **Deadlines** for the next 7 days and **Automations**, the Claude scheduled tasks in order of their next run. |
| **Goals** | One card per agent repo: its goal, a bar of milestones done, the checklist with the next milestone in bold, a countdown if the goal has a `Due:` line, and what is happening now (merged this week, ready, in progress, open PRs). The goal is an open issue labelled `goal` in that repo: the title is the goal (`Goal: …`) and its task list (`- [ ] …`) the milestones, so it stays private to the repo and you tick milestones on GitHub. No workflow label, so no agent picks it up, and it is left out of *Outside the labels*. A repo without one shows **Set goal**, which writes that issue with the page's token. |
| **Portfolio** | Every project, not only code: one row per paper, app, course, quant stream and admin duty, read from `portfolio.json` in a private repo of yours. Each row has a state (Active, Waiting, Parked, Done, Killed), a stage, the next action, who you are waiting on and since when, the next check date, deadlines, and a resume note. Filters: **Today** (check due or a deadline within 7 days), Active, Waiting (grouped by who has it), Parked, **Board** (by stage) and All. **Checked** moves a row's next check a week out (5 days for a wait) in one tap; **Edit** changes everything else. The header counts Active against your limit (3 by default; ongoing areas don't count), and on Sundays a **weekly review** card walks through the 25-minute checklist. |
| **Projects** | One card per repo: health, a one-line state, a bar of ready / working / open-PR / blocked work, the latest agent activity, **Details** (label counts, the next issue, every open PR with checks, Codex notes and a verdict, CI, last commit), **+ Task** (task modules, below) and **Pause agents** (two taps). Automations get cards too. Below: **Outside the labels** (issues no agent will pick up, and this repo's own open pull requests) and the repos hidden by the `retired` label. |
| **Agents** | One card per lane (the Fable administrator, the Claude agents, Codex, Antigravity), problems first: its state and the reason — working, idle with nothing to do, at its cap (and when a slot frees up), or *not starting* with the fix — plus how many tasks are left under the 5-hour and 7-day caps and per account. **Not connected** marks a routine whose token is missing from the dispatcher's secrets (the header counts the connected ones): each dispatcher run publishes every routine's on/off and load as an `agents` annotation, which the page reads, since secrets can't be read from a browser. The caps are the dispatcher's own; each Claude plan's real usage isn't visible to GitHub. |
| **System** | The dispatcher's real cadence (runs in 24 hours against the expected number, and the typical gap), Actions minutes with a month-end projection and the repos using the most, the API budget, and **Activity** (problems only by default, with All and per-repo filters). |
| **Meta-control** | How the automation runs: every Claude scheduled task listed in `dispatch/config.json`, in order of its next run, with what it does, its links and a countdown; buttons to Agents, System and Goals; and **Open the full dashboard**, the Meta-control dashboard on claude.ai, which adds what a browser page can't read (mail triage, alert emails, your calendar and each task's last result). |

## New task: pick a module

**New task** (top bar) and **+ Task** (on a project card) open a list of task modules for the chosen project:
its own modules first, then ones that fit any project (fix a bug, small change, new feature, make it faster,
add tests, write docs, fix review findings, visual polish, big goal) and **Something else** for free text.
Pick one, answer its two or three questions, choose S / M / L, and the preview shows the issue it will create:
problem, acceptance criteria, files, out of scope and **how to check**: numbered steps that each name a command or a
page and the result that counts as done (the project's real test command, from its menu), with `ready` and the size
label set, so the dispatcher builds it on its next run without a sizing pass.

A project's own modules live in `.github/task-menu.json` in that repo (format: `dispatch/TASK_MENU.md`).
Its `checks` block records the project's test command, what a pass looks like and how to open the app. For a
project without a menu, **Ask an agent to write them** opens a `ready` task for it (or for every project at once);
for a menu without `checks`, **Ask an agent to add them**. You merge the agent's pull request as usual.

## Deadlines for owner-only work

Write the deadline into the issue's description and the page does the rest (countdown, inbox ranking, Deadlines list):

```
Window: Sat 06:00-13:00 America/New_York weekly until 2026-11-15 | Weekly owner steps
Window: Sun 00:05 UTC - Mon 04:05 UTC weekly until 2026-11-15 | Sunday lock
Due: 2026-11-06 18:00 Asia/Taipei | Send the monthly report
Decide by: 2026-11-02 18:00 Asia/Taipei
```

Times are read in the zone you write (`ET`, `UTC`/`Z` and `TPE` work too), so daylight-saving changes are handled. A window that is open now goes to the top of the inbox.

Portfolio rows take the same lines (without the `Due:` word) in their Deadlines box; put `x ` in front of one once it is done, or tap **Done** on it in Today.

Buttons that change GitHub ask for a second tap and need **Issues: Read and write** on the token.

## Portfolio

The portfolio is one file, `portfolio.json`, in a **private** repo of yours (default name `portfolio`; change it under Settings). The page reads and writes it through the GitHub API, so nothing about your projects is stored in this public repo or served from GitHub Pages, and every save is a commit: the file's history is the record of when each project changed stage.

Give the page a second fine-grained token for it — repository access *only* the portfolio repo, permission **Contents: Read and write** — under Settings → Portfolio token, so the main token never needs write access to code. Each row looks like this:

```json
{ "id": "example-review", "title": "…", "type": "paper", "state": "waiting", "stage": "submitted",
  "next": "…", "waitingOn": "Journal", "since": "2026-10-01", "check": "2026-11-01",
  "due": ["2026-11-06 18:00 Asia/Taipei | Revision due"], "journal": "…", "lastSearch": "2026-09-05",
  "note": "where to restart", "where": "folder or Drive path", "link": "https://…", "area": false }
```

Types and their stages: paper (idea → protocol → registered → search → screening → extraction → analysis → writing → co-author review → submitted → revision → accepted → proofs → published), app, course, quant, admin. `area: true` marks an ongoing responsibility (course, admin, quant, supervising an agent-built app) that does not count toward the Active limit (`wipLimit`, default 3).

## Setup

1. **Host it** — this repo is public with GitHub Pages on `main` / root, so the page is at
   `https://<your-user>.github.io/mission-control/`. Opening `index.html` from disk works too.
2. **Token** — github.com → Settings → Developer settings → Personal access tokens →
   *Fine-grained tokens* → Generate new token: longest expiration, *Only select repositories* (the
   repos your agents work on); repository permissions **Issues: Read and write**, **Pull requests: Read**,
   **Checks: Read**, **Actions: Read**, **Contents: Read**; optional account permission **Plan: Read**
   for the Actions-minutes tile.
3. Open the page, paste the token, press **Connect**. On a phone: Share → Add to Home Screen; on a computer, the install icon in the address bar. It opens like an app (icon and name come from `manifest.webmanifest`).

## Settings (gear icon)

Repositories (one per line, `repo | short name | note`; new agent repos are added on their own each time the page opens,
a repo you delete from the list stays hidden, and **Find my agent repos** looks right away), auto-refresh
interval, the **portfolio repo** and its token, the **repos attached to each routine** (optional, e.g. `claude-1: fenced-repo, other-fenced-repo`; with it the page can say for certain that an agent is not starting because its routine lacks a repo), and thresholds: *stalled after* (hours without Claude activity while `ready` issues wait), *stuck
claim after*, *agent retry window* (hours a failing agent PR is left to its agent), included Actions minutes.

## Labels the agents follow

`plan` → the administrator splits it into `ready` issues · `ready` → the dispatcher gives it to an agent ·
`size:S` / `size:M` → Sonnet · `size:L` → Opus · `ui` → Antigravity · `to:codex` → Codex · `to:<agent>` → assigned ·
`claimed` → an agent is on it · `in-review` → PR open · `blocked` → needs you · `needs-spec` → the spec is missing something; never dispatched until you remove it · `decision` → a decision brief for you; never dispatched · `pause` → every agent in that repo stops ·
`home:<agent>` on a repo → only that agent works there · `retired` on a repo → Mission Control hides it on every device and the dispatcher skips it (delete the label to bring it back).

## Scheduled tasks that aren't repos

Claude scheduled tasks such as email triage (信件分流) are listed in `dispatch/config.json` under `scheduledTasks`
and show as rows under **Projects**: name, what it does, schedule, a countdown to the next run and links. Each entry:
`{ "name", "alias", "what", "times": ["06:55", "11:55"], "tz": "Asia/Taipei", "days": ["sat"] (optional, default every day), "links": [{ "text", "url" }] }`.
The page only knows the schedule; each task reports its results through its own push notification.

## Dispatcher

`dispatch/` holds a dispatcher that wakes the agents only when they have work. `.github/workflows/dispatch.yml` runs it every 15 minutes. It uses no AI itself, and its Actions minutes are free because this repo is public. It sizes and routes work: a Fable administrator plans and sizes, Opus takes hard tasks, Sonnet takes normal ones, Antigravity gets UI tasks, and Codex takes over PRs an agent couldn't fix. It also keeps every Claude account under its caps, and it guards your time and your repos: no new builds while `maxOpenAgentPRs` agent PRs (3) wait in a repo or `maxOpenAgentPRsTotal` (8) across repos; only labels you apply start work, and an issue with a recent comment from anyone else waits for you; an issue claimed twice without a PR comes back to you as `needs-spec`. Setup: `dispatch/SETUP.md`. Settings: `dispatch/config.json`.
