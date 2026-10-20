# Mission Control — one page for all AI-team projects

A single static web page (`index.html`, no build step, no server) that watches every repo
your Claude / Codex / Antigravity agents work on and tells you what needs **you**.

It talks to GitHub directly from your browser with a fine-grained token. The token is kept only in
that browser (`localStorage`) and is sent only to `api.github.com`. This repo contains no token and
no repo names: the page finds your agent repos by itself (every repo of yours that has the agents'
`ready` label, which each routine creates on its first run).

## What it shows

| Section | What it means |
|---|---|
| **Needs you** | Pull requests ready to merge (with a nudge to read Codex notes), with merge conflicts, or failing longer than the agents' retry window; `blocked` issues with their last comment; issues `claimed` for hours with no PR (a dead agent run, one tap to unclaim); repos where `ready` issues wait but no Claude run has shown up; paused repos; Actions minutes near the limit. |
| **Tiles** | Ready queue, agents working, open PRs, blocked, merged this week, GitHub Actions minutes. |
| **Projects** | One card per repo: label counts (tap to open that filter on GitHub), the next issue an agent will take, every open PR with checks, Codex notes, conflicts and a verdict, CI on the default branch, last commit, last agent activity. **+ Task** opens a `ready` issue (with a size, `ui` or `to:codex` if you like) or a `plan` issue; **Pause agents** opens a `pause` issue (every agent stops), **Resume** closes it. |
| **Team** | Every lane: the Fable administrator, the Claude agents (account, model, job), Codex and Antigravity, with what each is doing now, tasks started in the last 5 hours and 7 days against its caps, per-account load, and the dispatcher's last run. |
| **Agents** | Every agent seen recently (`Claimed by claude-1`, `Agent: claude-2`, Codex, Antigravity) with last-seen time. |
| **Activity** | Comments, PRs, merges, commits and CI runs across all repos, newest first. |

Buttons that change GitHub ask for a second tap and need **Issues: Read and write** on the token.

## Setup

1. **Host it** — this repo is public with GitHub Pages on `main` / root, so the page is at
   `https://<your-user>.github.io/mission-control/`. Opening `index.html` from disk works too.
2. **Token** — github.com → Settings → Developer settings → Personal access tokens →
   *Fine-grained tokens* → Generate new token: longest expiration, *Only select repositories* (the
   repos your agents work on); repository permissions **Issues: Read and write**, **Pull requests: Read**,
   **Checks: Read**, **Actions: Read**, **Contents: Read**; optional account permission **Plan: Read**
   for the Actions-minutes tile.
3. Open the page, paste the token, press **Connect**. On a phone: Share → Add to Home Screen.

## Settings (gear icon)

Repositories (one per line, `repo | short name | note`; new agent repos are added on their own each time the page opens,
a repo you delete from the list stays hidden, and **Find my agent repos** looks right away), auto-refresh
interval, and thresholds: *stalled after* (hours without Claude activity while `ready` issues wait), *stuck
claim after*, *agent retry window* (hours a failing agent PR is left to its agent), included Actions minutes.

## Labels the agents follow

`plan` → the administrator splits it into `ready` issues · `ready` → the dispatcher gives it to an agent ·
`size:S` / `size:M` → Sonnet · `size:L` → Opus · `ui` → Antigravity · `to:codex` → Codex · `to:<agent>` → assigned ·
`claimed` → an agent is on it · `in-review` → PR open · `blocked` → needs you · `pause` → every agent in that repo stops ·
`home:<agent>` on a repo → only that agent works there.

## Dispatcher

`dispatch/` holds a dispatcher that wakes the agents only when they have work. `.github/workflows/dispatch.yml` runs it every 15 minutes. It uses no AI itself, and its Actions minutes are free because this repo is public. It sizes and routes work: a Fable administrator plans and sizes, Opus takes hard tasks, Sonnet takes normal ones, Antigravity gets UI tasks, and Codex takes over PRs an agent couldn't fix. It also keeps every Claude account under its caps. Setup: `dispatch/SETUP.md`. Settings: `dispatch/config.json`.
