#!/usr/bin/env node
/*
 * Mission Control dispatcher. Deterministic: no AI model runs here, so it costs no AI usage.
 * GitHub Actions runs it every 15 minutes (public repo, so the minutes are free).
 *
 * Each run it:
 *   1. finds the owner's agent repos (repos that carry the `ready` label and not `retired`);
 *   2. frees claims that produced no PR for `staleClaimHours`;
 *   3. sends agent PRs with failing checks or open review findings back to their agent once,
 *      then to Codex (`@codex fix`), then to you (`blocked`);
 *   4. gives every unassigned `plan` / `ready` issue to the best free agent: Opus for planning and
 *      size:L, Sonnet otherwise, least busy first, within each account's 5-hour and weekly caps;
 *      an agent that does not answer within `claimTimeoutMinutes` is treated as out of usage and
 *      its task moves to another agent;
 *   5. wakes only the chosen Claude routine, through its API trigger, with the task in the run text.
 *
 * Guards (what keeps your review queue and your repos safe):
 *   - `needs-spec` and `decision` issues are never dispatched: they wait for you;
 *   - only labels applied by you (or a login in `trusted`) start work, and an issue with a recent
 *     comment from anyone else waits until you look at it, so a stranger cannot steer an agent;
 *   - no new builds in a repo once `maxOpenAgentPRs` agent PRs (open or being written) wait there,
 *     or `maxOpenAgentPRsTotal` across all repos: your review time sets the pace;
 *   - an issue reclaimed `escalateAfterReclaims` times without a PR goes to you as `needs-spec`.
 *
 * State lives in GitHub: labels (`to:<agent>`, `size:*`, `ui`) and one-line "Dispatch:" comments.
 * This repo is public, so the log prints counts and agent names only, never repo names or titles.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MIN = 6e4;
const HOUR = 36e5;
const DAY = 24 * HOUR;
const BLOCKING = ['claimed', 'blocked', 'in-review', 'jules', 'pause', 'needs-spec', 'decision'];
const LANE_LABELS = {
  'size:S': ['c2e0c6', 'Small: docs, config, one-file change'],
  'size:M': ['fef2c0', 'Normal task'],
  'size:L': ['f9d0c4', 'Hard or cross-cutting: goes to an Opus agent'],
  'ui': ['bfdadc', 'Needs a browser to check: goes to Antigravity'],
  'to:codex': ['10a37f', 'Assigned to Codex'],
  'to:antigravity': ['4285f4', 'Assigned to Antigravity (runs on the Mac)'],
  'needs-spec': ['d4c5f9', 'Spec incomplete: answer the questions, then remove this label'],
  'decision': ['e99695', 'Decision brief for the owner: never given to an agent'],
};
/* Accounts whose comments belong to the team (Codex reviews, GitHub's own bots). */
const TEAM_BOTS = /^(chatgpt-codex-connector|github-actions|google-labs-jules|dependabot)(\[bot\])?$/i;
export const DISPATCH_RE = /^Dispatch:\s*([\w.-]+)\s*·\s*([^·\n]*?)\s*·\s*([\w-]+)(?:\s*·\s*sha=([0-9a-f]{7,40}))?/m;

const labelsOf = (i) => (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
const has = (i, l) => labelsOf(i).includes(l);
const ts = (iso) => (iso ? Date.parse(iso) : 0);
const numOf = (url) => { const m = /\/(\d+)$/.exec(url || ''); return m ? Number(m[1]) : null; };
const agentOfBody = (b) => { const m = /^\s*Agent:\s*([\w.-]+)/im.exec(b || ''); return m ? m[1].toLowerCase() : null; };
const isCodex = (login) => /codex/i.test(login || '');
const mentions = (body, n) => new RegExp(`(^|[^\\w])#${n}(?!\\d)`).test(body || '');
/* The routine trigger's reply may name the session it started; if it does, the Dispatch comment links it. */
export function sessionUrlOf(reply) {
  const found = [];
  const walk = (v, depth) => {
    if (v == null || depth > 3) return;
    if (typeof v === 'string') { if (/^https:\/\/claude\.ai\/code\/[\w./?=&-]+$/.test(v)) found.push(v); return; }
    if (typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(reply, 0);
  return found[0] || '';
}

export async function run({ config, env = {}, now = Date.now(), fetchImpl = fetch, verbose = false } = {}) {
  const cfg = config;
  const API = 'https://api.github.com';
  const TOKEN = env.DISPATCH_GH_TOKEN || '';
  const DRY = env.DRY_RUN === '1' || !TOKEN;
  const NOW = now;
  const detail = [];
  const stats = { repos: 0, fired: 0, plans: 0, fixes: 0, codex: 0, human: 0, reclaimed: 0, reassigned: 0, antigravity: 0, waiting: 0, noAgent: 0, prCapped: 0, untrusted: 0, escalated: 0, errors: 0 };

  async function gh(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mission-control-dispatcher' };
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetchImpl(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 204) return null;
    const txt = await res.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = null; }
    if (!res.ok) { const e = new Error(`GitHub ${res.status}`); e.status = res.status; throw e; }
    return data;
  }
  async function ghAll(path, maxPages = 3) {
    const out = [];
    for (let p = 1; p <= maxPages; p++) {
      const page = await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${p}`);
      if (!Array.isArray(page)) break;
      out.push(...page);
      if (page.length < 100) break;
    }
    return out;
  }
  async function act(desc, path, opts) {
    if (verbose) detail.push(`${DRY ? '[dry] ' : ''}${desc}`);
    if (DRY) return null;
    return gh(path, opts);
  }

  /* ---------- agents ---------- */
  /* The routine's secret holds its token (and may hold its URL too); the URL can also come from the
     Actions variable <SECRET>_URL, so a freshly generated token can be pasted on its own. */
  function fireTarget(a) {
    const raw = `${env[a.secret] || ''}\n${env[`${a.secret}_URL`] || ''}`;
    const url = (raw.match(/https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]+\/fire/) || [])[0];
    const token = (raw.match(/sk-ant-[A-Za-z0-9_-]+/) || [])[0];
    return url && token ? { url, token } : null;
  }
  const agents = cfg.agents.map((a) => ({ ...a, target: fireTarget(a), load5h: 0, load7d: 0, recent: 0, lastAt: 0, cooling: false }));
  const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
  const acctLoad = {};
  const acctCap = (a) => ((cfg.accounts || {})[String(a.account)] || {}).cap5h ?? Infinity;
  const available = (a) => !!a.target && !a.cooling && a.load5h < a.cap5h && a.load7d < a.cap7d && a.recent < (a.perHour ?? 1)
    && (acctLoad[a.account] || 0) < acctCap(a);
  const admin = agents.find((a) => a.pool === 'admin') || null;
  async function fire(a, text) {
    if (!a.target) return { ok: false, why: 'not-connected' };
    if (verbose) detail.push(`${DRY ? '[dry] ' : ''}wake ${a.name}: ${text.split('\n')[0]}`);
    if (DRY) return { ok: true };
    try {
      const res = await fetchImpl(a.target.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${a.target.token}`, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return { ok: false, why: `http-${res.status}` };
      let session = '';
      try { session = sessionUrlOf(await res.json()); } catch { /* no JSON body */ }
      return { ok: true, session };
    } catch (e) {
      return { ok: false, why: 'network' };
    }
  }

  /* ---------- discovery ---------- */
  const owner = cfg.owner || (TOKEN ? (await gh('/user')).login : '');
  if (!owner) return { stats, detail, note: 'no token: add the DISPATCH_GH_TOKEN secret' };

  /* ---------- who may start work ---------- */
  /* Agents act on GitHub as the owner, so "the owner applied the label" covers your own tasks and the
     administrator's. A label from anyone else (a collaborator, an app) or a recent comment from a
     stranger holds the issue until you look at it. */
  const trustedSet = new Set([owner, ...(Array.isArray(cfg.trusted) ? cfg.trusted : [])].map((s) => String(s).toLowerCase()));
  const trustedLogin = (login) => !!login && trustedSet.has(String(login).toLowerCase());
  const teamLogin = (login) => trustedLogin(login) || TEAM_BOTS.test(login || '');
  const labelCheck = new Map();
  async function startedByOwner(d, i) {
    const key = `${d.repo}#${i.number}`;
    if (labelCheck.has(key)) return labelCheck.get(key);
    let ok = false;
    try {
      const evs = await ghAll(`${d.base}/issues/${i.number}/events`, 3);
      const hits = evs.filter((e) => e.event === 'labeled' && e.label && ['ready', 'plan'].includes(e.label.name) && labelsOf(i).includes(e.label.name));
      const last = hits.sort((x, y) => ts(y.created_at) - ts(x.created_at))[0];
      ok = !!last && trustedLogin(last.actor && last.actor.login);
    } catch (e) { stats.errors++; ok = false; /* fail closed: try again next run */ }
    labelCheck.set(key, ok);
    return ok;
  }
  const strangerSpoke = (d, n) => (d.byNum.get(n) || []).some((c) => c.user && !teamLogin(c.user.login));
  async function mayStart(d, i) {
    if (strangerSpoke(d, i.number) || !(await startedByOwner(d, i))) { stats.untrusted++; return false; }
    return true;
  }
  const all = await ghAll('/user/repos?affiliation=owner&sort=pushed', 2);
  const cands = all.filter((r) => r && !r.archived && r.owner && r.owner.login.toLowerCase() === owner.toLowerCase());
  const repos = [];
  for (const r of cands) {
    try { await gh(`/repos/${owner}/${r.name}/labels/ready`); } catch { continue; /* not an agent repo */ }
    /* A repo that carries the `retired` label is left alone (Mission Control hides it too). */
    try { await gh(`/repos/${owner}/${r.name}/labels/retired`); continue; } catch { /* not retired */ }
    repos.push(r.name);
  }
  stats.repos = repos.length;

  /* ---------- gather ---------- */
  async function gather(repo) {
    const base = `/repos/${owner}/${repo}`;
    const [labels, items, comments] = await Promise.all([
      ghAll(`${base}/labels`, 2),
      ghAll(`${base}/issues?state=open`, 3),
      ghAll(`${base}/issues/comments?since=${new Date(NOW - 7 * DAY).toISOString()}`, 5),
    ]);
    const labelNames = labels.map((l) => l.name);
    const home = labelNames.filter((n) => n.startsWith('home:')).map((n) => n.slice(5).toLowerCase());
    const issues = items.filter((i) => !i.pull_request);
    const openPRs = items.filter((i) => i.pull_request);
    const byNum = new Map();
    const dispatches = [];
    let codexLimitAt = 0;
    for (const c of comments) {
      const n = numOf(c.issue_url);
      if (n == null) continue;
      if (!byNum.has(n)) byNum.set(n, []);
      byNum.get(n).push(c);
      const m = DISPATCH_RE.exec(c.body || '');
      if (m) dispatches.push({ who: m[1].toLowerCase(), model: m[2], mode: m[3].toLowerCase(), sha: m[4] || '', at: ts(c.created_at), num: n });
      if (isCodex(c.user && c.user.login) && /usage limit/i.test(c.body || '')) codexLimitAt = Math.max(codexLimitAt, ts(c.created_at));
    }
    const prs = [];
    for (const p of openPRs) {
      const agent = agentOfBody(p.body);
      if (!agent) continue;
      try {
        const pr = await gh(`${base}/pulls/${p.number}`);
        if (pr.draft) continue;
        const sha = pr.head.sha;
        const [runs, reviews, rcomments, commit] = await Promise.all([
          gh(`${base}/actions/runs?head_sha=${sha}&per_page=50`).catch(() => null),
          gh(`${base}/pulls/${p.number}/reviews?per_page=100`).catch(() => []),
          gh(`${base}/pulls/${p.number}/comments?per_page=100`).catch(() => []),
          gh(`${base}/commits/${sha}`).catch(() => null),
        ]);
        const headAt = commit && commit.commit ? ts(commit.commit.committer.date) : ts(pr.updated_at);
        const latest = new Map();
        for (const w of (runs && runs.workflow_runs) || []) {
          const prev = latest.get(w.name);
          if (!prev || ts(w.created_at) > ts(prev.created_at)) latest.set(w.name, w);
        }
        const wr = [...latest.values()];
        const pending = wr.some((w) => w.status !== 'completed');
        const failed = wr.filter((w) => w.status === 'completed' && ['failure', 'timed_out', 'startup_failure'].includes(w.conclusion));
        prs.push({
          number: p.number, agent, sha, headAt, pending,
          failing: failed.length > 0,
          failedAt: Math.max(0, ...failed.map((w) => ts(w.updated_at))),
          /* only your own change requests count: on a public repo anyone can post a review */
          changes: (reviews || []).some((r) => r.state === 'CHANGES_REQUESTED' && ts(r.submitted_at) > headAt && trustedLogin(r.user && r.user.login)),
          codexP1: (rcomments || []).some((c) => isCodex(c.user && c.user.login) && ts(c.created_at) > headAt && /\bP[01]\b/.test(c.body || '')),
          failedNames: failed.map((w) => w.name),
        });
      } catch (e) { stats.errors++; }
    }
    /* PRs from agents that wait for your review, plus claimed issues whose PR is being written */
    const agentPRs = openPRs.filter((p) => agentOfBody(p.body)).length;
    const writing = issues.filter((i) => has(i, 'claimed') && !has(i, 'in-review') && !has(i, 'blocked')).length;
    return { repo, base, home, issues, openPRs, prs, byNum, dispatches, codexLimitAt, labelNames, agentPRs, writing, firedBuilds: 0, paused: issues.some((i) => has(i, 'pause')) };
  }
  const data = [];
  for (const repo of repos) {
    try { data.push(await gather(repo)); } catch (e) { stats.errors++; }
  }

  /* ---------- loads, no-shows ---------- */
  const seenTriage = new Set();
  for (const d of data) {
    for (const x of d.dispatches) {
      const a = byName[x.who];
      if (!a || !['build', 'plan', 'fix-pr', 'triage'].includes(x.mode)) continue;
      if (x.mode === 'triage') {           /* one triage pass is recorded on every issue it covers */
        const key = `${x.who}:${Math.floor(x.at / MIN)}`;
        if (seenTriage.has(key)) continue;
        seenTriage.add(key);
      }
      const age = NOW - x.at;
      if (age <= 7 * DAY) a.load7d++;
      if (age <= 5 * HOUR) { a.load5h++; acctLoad[a.account] = (acctLoad[a.account] || 0) + 1; }
      if (age <= HOUR) a.recent++;
      a.lastAt = Math.max(a.lastAt, x.at);
    }
  }
  /* Did agent `x.who` answer dispatch `x`? A claim / planning comment or a newer commit counts. */
  function answered(d, x) {
    const after = (d.byNum.get(x.num) || []).filter((c) => ts(c.created_at) > x.at);
    const re = new RegExp(`\\b(Claimed|Planning) by ${x.who}\\b`, 'i');
    if (after.some((c) => re.test(c.body || ''))) return true;
    if (after.some((c) => { const m = DISPATCH_RE.exec(c.body || ''); return m && m[3] === 'reclaimed'; })) return true;
    if (x.mode === 'fix-pr') {
      const pr = d.prs.find((p) => p.number === x.num);
      if (!pr || !pr.sha.startsWith(x.sha)) return true;
      return after.some((c) => !DISPATCH_RE.test(c.body || '') && !isCodex(c.user && c.user.login));
    }
    const issue = d.issues.find((i) => i.number === x.num);
    return !issue || has(issue, 'claimed') || has(issue, 'in-review') || has(issue, 'blocked');
  }
  for (const d of data) {
    for (const x of d.dispatches) {
      const a = byName[x.who];
      if (!a || !['build', 'plan', 'fix-pr'].includes(x.mode)) continue;
      const age = NOW - x.at;
      if (age >= cfg.claimTimeoutMinutes * MIN && age <= cfg.coolingHours * HOUR && !answered(d, x)) a.cooling = true;
    }
  }
  const codexCooling = data.some((d) => d.codexLimitAt && NOW - d.codexLimitAt < (cfg.codex.cooldownHours || 24) * HOUR);

  /* ---------- actions ---------- */
  let fires = 0;
  const canFire = () => fires < cfg.maxFiresPerRun;
  /* Your review time is the bottleneck: count agent PRs waiting for you, and PRs being written. */
  const capRepo = cfg.maxOpenAgentPRs ?? 3;
  const capAll = cfg.maxOpenAgentPRsTotal ?? 8;
  const inFlight = () => data.reduce((s, d) => s + d.agentPRs + d.writing + d.firedBuilds, 0);
  async function comment(d, n, body) { await act(`comment ${d.repo}#${n}: ${body.split('\n')[0]}`, `${d.base}/issues/${n}/comments`, { method: 'POST', body: { body } }); }
  async function addLabel(d, n, label) { await act(`label ${d.repo}#${n} +${label}`, `${d.base}/issues/${n}/labels`, { method: 'POST', body: { labels: [label] } }); }
  async function removeLabel(d, n, label) {
    try { await act(`label ${d.repo}#${n} -${label}`, `${d.base}/issues/${n}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) throw e; }
  }
  function pick(d, kind, size, exclude) {
    const pool = d.home.length ? agents.filter((a) => d.home.includes(a.name)) : agents.filter((a) => a.pool === 'general');
    const wantOpus = kind === 'plan' || size === 'L';
    const tier = (a) => (/opus/i.test(a.model) === wantOpus ? 0 : 1);
    const ok = pool.filter((a) => !exclude.has(a.name) && available(a));
    ok.sort((x, y) => tier(x) - tier(y) || x.load5h / x.cap5h - y.load5h / y.cap5h || x.lastAt - y.lastAt);
    return ok[0] || null;
  }
  async function wake(d, a, mode, n, lines, sha) {
    const text = [`Dispatch: ${mode} ${owner}/${d.repo}#${n}`, `You are ${a.name} (${a.model}).`, ...lines,
      `Follow your routine instructions for mode "${mode}". Do only this task, then stop.`].join('\n');
    const res = await fire(a, text);
    if (!res.ok) { a.cooling = true; stats.errors++; return false; }
    fires++; a.load5h++; a.load7d++; a.recent++; a.lastAt = NOW; acctLoad[a.account] = (acctLoad[a.account] || 0) + 1;
    await comment(d, n, `Dispatch: ${a.name} · ${a.model} · ${mode}${sha ? ` · sha=${sha.slice(0, 7)}` : ''}\n\n${lines[0]}${res.session ? `\nSession: ${res.session}` : ''}`);
    return true;
  }

  /* ---------- administrator triage: size new issues before they are built ---------- */
  const SORTED = ['size:S', 'size:M', 'size:L', 'ui', 'to:codex', 'to:antigravity'];
  const held = new Set();
  stats.triage = 0;
  if (admin && admin.target) {
    const untriaged = [];
    for (const d of data) {
      if (d.paused) continue;
      for (const i of d.issues) {
        if (!has(i, 'ready') || BLOCKING.some((l) => has(i, l)) || SORTED.some((l) => has(i, l))) continue;
        const sent = d.dispatches.filter((x) => x.num === i.number && x.who === admin.name && x.mode === 'triage').map((x) => x.at);
        const sentAt = sent.length ? Math.max(...sent) : 0;
        if (sentAt && NOW - sentAt < cfg.triageWaitMinutes * MIN) held.add(`${d.repo}#${i.number}`);
        else if (!sentAt) untriaged.push({ d, i });
      }
    }
    const lastTriage = Math.max(0, ...data.flatMap((d) => d.dispatches.filter((x) => x.who === admin.name && x.mode === 'triage').map((x) => x.at)));
    const list = [];
    if (untriaged.length && NOW - lastTriage >= cfg.triageEveryHours * HOUR && available(admin) && canFire()) {
      for (const u of untriaged) { if (list.length >= 25) break; if (await mayStart(u.d, u.i)) list.push(u); }
    }
    if (list.length) {
      const text = [`Dispatch: triage ${owner}`, `You are ${admin.name} (${admin.model}).`, 'Size and sort these new issues:',
        ...list.map(({ d, i }) => `- ${owner}/${d.repo}#${i.number}`), 'Follow your routine instructions for mode "triage". Then stop.'].join('\n');
      const res = await fire(admin, text);
      if (res.ok) {
        fires++; admin.load5h++; admin.load7d++; admin.recent++; admin.lastAt = NOW; acctLoad[admin.account] = (acctLoad[admin.account] || 0) + 1;
        for (const { d, i } of list) {
          await comment(d, i.number, `Dispatch: ${admin.name} · ${admin.model} · triage\n\nSent to the administrator for sizing; it is built within ${cfg.triageWaitMinutes} minutes either way.`);
          held.add(`${d.repo}#${i.number}`);
        }
        stats.triage = list.length;
      } else { admin.cooling = true; stats.errors++; }
    }
  }

  for (const d of data) {
    if (d.paused) continue;
    try {
      /* labels the dispatcher uses */
      if (!DRY) {
        const want = { ...LANE_LABELS };
        for (const a of agents) want[`to:${a.name}`] = ['ededed', `Assigned to ${a.name} (${a.model})`];
        for (const [name, [color, description]] of Object.entries(want)) {
          if (!d.labelNames.includes(name)) await gh(`${d.base}/labels`, { method: 'POST', body: { name, color, description } }).catch(() => null);
        }
      }

      /* 1) stale claims */
      for (const i of d.issues) {
        if (!has(i, 'claimed') || has(i, 'in-review') || has(i, 'blocked')) continue;
        if (d.openPRs.some((p) => mentions(p.body, i.number))) continue;
        const cs = (d.byNum.get(i.number) || []).filter((c) => !DISPATCH_RE.test(c.body || ''));
        const lastAt = cs.length ? Math.max(...cs.map((c) => ts(c.created_at))) : ts(i.updated_at);
        if (NOW - lastAt < cfg.staleClaimHours * HOUR) continue;
        const claim = [...cs].reverse().map((c) => /Claimed by ([\w.-]+)/i.exec(c.body || '')).find(Boolean);
        const who = claim ? claim[1].toLowerCase() : 'unknown';
        await removeLabel(d, i.number, 'claimed');
        for (const l of labelsOf(i).filter((x) => x.startsWith('to:') && byName[x.slice(3)])) await removeLabel(d, i.number, l);
        /* Claimed again and again with nothing to show: the spec is probably missing something. */
        const lastYou = Math.max(0, ...d.dispatches.filter((x) => x.num === i.number && x.who === 'human').map((x) => x.at));
        const before = d.dispatches.filter((x) => x.num === i.number && x.mode === 'reclaimed' && x.at > lastYou).length;
        const escalate = before + 1 >= (cfg.escalateAfterReclaims ?? 2);
        if (escalate) {
          await addLabel(d, i.number, 'needs-spec');
          await comment(d, i.number, `Dispatch: human · — · needs-you\n\nClaimed ${before + 1} times with no pull request (last by ${who}), so it is probably missing something: acceptance criteria, the files involved, or how to check the result. Add what is missing, then remove needs-spec.`);
          stats.escalated++;
        } else {
          await comment(d, i.number, `Dispatch: ${who} · — · reclaimed\n\nNo pull request ${cfg.staleClaimHours}h after the claim, so this issue is free again.`);
        }
        i.labels = (i.labels || []).filter((l) => { const nm = typeof l === 'string' ? l : l.name; return nm !== 'claimed' && !(nm.startsWith('to:') && byName[nm.slice(3)]); });
        if (escalate) i.labels.push({ name: 'needs-spec' });
        d.byNum.set(i.number, [...(d.byNum.get(i.number) || []), { created_at: new Date(NOW).toISOString(), body: `Dispatch: ${who} · — · reclaimed` }]);
        d.writing = Math.max(0, d.writing - 1);
        stats.reclaimed++;
      }

      /* 2) agent PRs that need a fix: owner agent once, then Codex, then you */
      for (const p of d.prs) {
        if (p.pending || !(p.failing || p.changes || p.codexP1)) continue;
        const forSha = d.dispatches.filter((x) => x.num === p.number && x.sha && p.sha.startsWith(x.sha));
        if (forSha.some((x) => x.who === 'human')) continue;
        const ownerD = forSha.find((x) => x.who === p.agent && x.mode === 'fix-pr');
        const codexD = forSha.find((x) => x.who === 'codex');
        const reasons = [p.failing && `failing checks: ${p.failedNames.join(', ')}`, p.codexP1 && 'Codex review findings (P0/P1) newer than your last commit', p.changes && 'changes requested'].filter(Boolean);
        const owner = byName[p.agent];
        if (!ownerD && !codexD) {
          if (owner && available(owner) && canFire()) {
            if (await wake(d, owner, 'fix-pr', p.number, [`Fix your PR: ${reasons.join('; ')}.`], p.sha)) stats.fixes++;
            continue;
          }
          if (NOW - (p.failedAt || p.headAt) < cfg.fixEscalateMinutes * MIN) { stats.waiting++; continue; }
        } else if (ownerD && !codexD && NOW - ownerD.at < cfg.fixEscalateMinutes * MIN) { stats.waiting++; continue; }
        if (!codexD && cfg.codex.enabled && !codexCooling) {
          await comment(d, p.number, `@codex fix this PR: ${reasons.join('; ')}. Keep to the issue's scope and the repo's AGENTS.md.\n\nDispatch: codex · ${cfg.codex.model || 'GPT'} · fix-pr · sha=${p.sha.slice(0, 7)}`);
          stats.codex++;
          continue;
        }
        if (codexD && NOW - codexD.at < cfg.fixEscalateMinutes * MIN) { stats.waiting++; continue; }
        await addLabel(d, p.number, 'blocked');
        await comment(d, p.number, `Dispatch: human · — · needs-you · sha=${p.sha.slice(0, 7)}\n\nThe agent${cfg.codex.enabled ? ' and Codex' : ''} could not fix this (${reasons.join('; ')}). Over to you.`);
        stats.human++;
      }

      /* 3) unassigned plan / ready issues */
      const queue = d.issues
        .filter((i) => (has(i, 'plan') || has(i, 'ready')) && !BLOCKING.some((l) => has(i, l)))
        .sort((x, y) => Number(has(y, 'plan')) - Number(has(x, 'plan')) || ts(x.created_at) - ts(y.created_at));
      for (const i of queue) {
        if (held.has(`${d.repo}#${i.number}`)) { stats.waiting++; continue; }
        const kind = has(i, 'plan') ? 'plan' : 'build';
        if (kind === 'build' && (d.agentPRs + d.writing + d.firedBuilds >= capRepo || inFlight() >= capAll)) { stats.prCapped++; continue; }
        if (!(await mayStart(d, i))) continue;
        const size = (['size:S', 'size:M', 'size:L'].find((l) => has(i, l)) || (kind === 'plan' ? 'size:L' : 'size:M')).slice(5);
        const mine = d.dispatches.filter((x) => x.num === i.number).sort((x, y) => y.at - x.at);
        const last = mine[0];
        if (has(i, 'to:codex')) {
          if (!last || last.who !== 'codex') await comment(d, i.number, `Dispatch: codex · ${cfg.codex.model || 'GPT'} · queued\n\nStart it from chatgpt.com/codex (Codex cannot be woken from GitHub issues).`);
          continue;
        }
        if (cfg.antigravity.enabled && (has(i, 'to:antigravity') || (has(i, 'ui') && !d.home.length))) {
          if (!has(i, 'to:antigravity')) await addLabel(d, i.number, 'to:antigravity');
          if (!last || last.who !== 'antigravity') await comment(d, i.number, `Dispatch: antigravity · ${cfg.antigravity.model || 'Gemini'} · queued\n\nVisual work: picked up by Antigravity on the Mac.`);
          stats.antigravity++;
          continue;
        }
        const exclude = new Set();
        if (last && byName[last.who] && last.mode === 'reclaimed') exclude.add(last.who);
        if (last && byName[last.who] && ['build', 'plan'].includes(last.mode)) {
          if (NOW - last.at < cfg.claimTimeoutMinutes * MIN) { stats.waiting++; continue; }
          if (!answered(d, last)) {
            exclude.add(last.who);
            byName[last.who].cooling = true;
            await removeLabel(d, i.number, `to:${last.who}`);
            await comment(d, i.number, `Dispatch: ${last.who} · ${byName[last.who].model} · no-show\n\n${last.who} did not start within ${cfg.claimTimeoutMinutes} minutes, so the task moves on. Usual causes: its routine does not have ${d.repo} attached (claude.ai/code/routines → the routine → Edit → Repositories), or its account is out of usage.`);
            stats.reassigned++;
          }
        }
        if (!canFire()) break;
        let a = null;
        if (kind === 'plan' && admin && !exclude.has(admin.name) && available(admin)) a = admin;  /* the administrator plans */
        if (!a) a = pick(d, kind, size, exclude);
        if (!a) { stats.noAgent++; continue; }
        for (const l of labelsOf(i).filter((x) => x.startsWith('to:') && byName[x.slice(3)] && x !== `to:${a.name}`)) await removeLabel(d, i.number, l);
        if (!has(i, `to:${a.name}`)) await addLabel(d, i.number, `to:${a.name}`);
        const why = kind === 'plan' ? 'plan issue: split it into small ready issues' : `size ${size}`;
        if (await wake(d, a, kind, i.number, [`Task: ${why}; you were the best free ${a.model} agent.`])) {
          if (kind === 'plan') stats.plans++; else { stats.fired++; d.firedBuilds++; }
        }
      }
    } catch (e) {
      stats.errors++;
      if (verbose) detail.push(`error in ${d.repo}: ${e.message}`);
    }
  }

  const loads = agents.map((a) => `${a.name} ${a.model} ${a.target ? 'on' : 'off'} ${a.load5h}/${a.cap5h} (5h) ${a.load7d}/${a.cap7d} (7d)${a.cooling ? ' cooling' : ''}`);
  return { stats, loads, detail, dry: DRY };
}

/* ---------- CLI ---------- */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
  run({ config, env: process.env, verbose: process.env.VERBOSE === '1' })
    .then((r) => {
      console.log(JSON.stringify({ dry: r.dry, ...r.stats }));
      for (const l of r.loads || []) console.log(l);
      if (r.note) console.log(r.note);
      for (const l of r.detail || []) console.log(l);
    })
    .catch((e) => { console.error(`dispatcher failed: ${e.message}`); process.exit(1); });
}
