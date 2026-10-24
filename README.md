# Mission Control — one page for all AI-team projects

A single static web page (`index.html`, no build step, no server) that watches every repo
your Claude / Codex / Antigravity agents work on and tells you what needs **you**.

It talks to GitHub directly from your browser with a fine-grained token. The token is kept only in
that browser (`localStorage`) and is sent only to `api.github.com`. This repo contains no token and
no repo names: the page finds your agent repos by itself (every repo of yours that has the agents'
`ready` label, which each routine creates on its first run).

## What it shows

The page is built around one question — *what do I need to do?* — so it opens on an inbox, not on a census of normal work.

| Section | What it means |
|---|---|
| **Status line** (top, always visible) | One sentence: how many items need you (and how many are urgent), the next owner deadline with a live countdown, and whether any agent is failing to start. The tab title and icon carry the same count and colour. |
| **Needs you** | One ranked list. Every row says what happened, what to do next, and by when: deadlines that are open now, `blocked` issues, pull requests waiting for you (ready to merge, conflicts, checks failing past the agents' retry window), dead claims (one tap to unclaim), **agents that were woken but never started, with the likely cause** (routine missing the repo vs. out of usage), a dispatcher that runs late or failed, CI failing on a default branch, idle agents with nothing queued, items outside the labels, and Actions minutes. **Snooze** hides a row for a day (kept in this browser). |
| **Deadlines** | Owner-only windows and due dates written into issues (see below), with countdowns, for the next 7 days. |
| **Projects** | One compact row per repo: health dot and a one-line state (moving, stalled, blocked, idle…), ready / PR / blocked / merged-this-week counts and CI. Tap a row for the details: label counts, the next issue an agent will take, every open PR with checks, Codex notes and a verdict, CI, last commit, **+ Task** and **Pause agents**. A "This week" line sums it all up. Claude scheduled tasks that aren't repos (e.g. email triage) get a row too, with their schedule and a countdown to the next run (see below). |
| **Agents** | Every lane (the Fable administrator, the Claude agents, Codex, Antigravity) with its state and the reason for it — working, idle with nothing to do, at its cap (and when a slot frees up), or *not starting* with the fix — plus tasks against the 5-hour and 7-day caps and per-account load. |
| **Outside the labels** | Open issues without a workflow label (no agent will ever pick them up, e.g. after a reclaim) and this repo's own open pull requests. |
| **System & cost** | The dispatcher's real cadence (runs in the last 24 hours and the typical gap, not just the last run), Actions minutes with a month-end projection and the repos using the most, and the API budget. Opens by itself when something is wrong. |
| **Activity** | Collapsed by default; opens on *Problems only* (failed CI, no-shows, reclaims, hand-offs to you or Codex), with All and per-repo filters. |
| **Project form ↗** (top bar) | Opens the project management form: a private claude.ai page with every project, including papers and folders that aren't GitHub repos, with status, last activity and next step. Only people the owner shares it with can open it; this repo holds just the link. |

## Deadlines for owner-only work

Write the deadline into the issue's description and the page does the rest (countdown, inbox ranking, Deadlines list):

```
Window: Sat 06:00-13:00 America/New_York weekly until 2026-11-15 | Weekly owner steps
Window: Sun 00:05 UTC - Mon 04:05 UTC weekly until 2026-11-15 | Sunday lock
Due: 2026-11-06 18:00 Asia/Taipei | Send the monthly report
```

Times are read in the zone you write (`ET`, `UTC`/`Z` and `TPE` work too), so daylight-saving changes are handled. A window that is open now goes to the top of the inbox.

Buttons that change GitHub ask for a second tap and need **Issues: Read and write** on the token.

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
interval, the **repos attached to each routine** (optional, e.g. `claude-1: fenced-repo, other-fenced-repo`; with it the page can say for certain that an agent is not starting because its routine lacks a repo), and thresholds: *stalled after* (hours without Claude activity while `ready` issues wait), *stuck
claim after*, *agent retry window* (hours a failing agent PR is left to its agent), included Actions minutes.

## Labels the agents follow

`plan` → the administrator splits it into `ready` issues · `ready` → the dispatcher gives it to an agent ·
`size:S` / `size:M` → Sonnet · `size:L` → Opus · `ui` → Antigravity · `to:codex` → Codex · `to:<agent>` → assigned ·
`claimed` → an agent is on it · `in-review` → PR open · `blocked` → needs you · `pause` → every agent in that repo stops ·
`home:<agent>` on a repo → only that agent works there · `retired` on a repo → Mission Control hides it on every device and the dispatcher skips it (delete the label to bring it back).

## Scheduled tasks that aren't repos

Claude scheduled tasks such as email triage (信件分流) are listed in `dispatch/config.json` under `scheduledTasks`
and show as rows under **Projects**: name, what it does, schedule, a countdown to the next run and links. Each entry:
`{ "name", "alias", "what", "times": ["06:55", "11:55"], "tz": "Asia/Taipei", "days": ["sat"] (optional, default every day), "links": [{ "text", "url" }] }`.
The page only knows the schedule; each task reports its results through its own push notification.

## Dispatcher

`dispatch/` holds a dispatcher that wakes the agents only when they have work. `.github/workflows/dispatch.yml` runs it every 15 minutes. It uses no AI itself, and its Actions minutes are free because this repo is public. It sizes and routes work: a Fable administrator plans and sizes, Opus takes hard tasks, Sonnet takes normal ones, Antigravity gets UI tasks, and Codex takes over PRs an agent couldn't fix. It also keeps every Claude account under its caps. Setup: `dispatch/SETUP.md`. Settings: `dispatch/config.json`.
