#!/usr/bin/env node
/*
 * Mission Control dispatcher. Deterministic: no AI model runs here, so it costs no AI usage.
 * GitHub Actions runs it every 15 minutes (public repo, so the minutes are free).
 *
 * Each run it:
 *   1. finds the owner's agent repos (repos that carry the `ready` label);
 *   2. frees claims that produced no PR for `staleClaimHours`;
 *   3. sends agent PRs with failing checks or open review findings back to their agent once,
 *      then to Codex (`@codex fix`), then to you (`blocked`);
 *   4. gives every unassigned `plan` / `ready` issue to the best free agent: Opus for planning and
 *      size:L, Sonnet otherwise, least busy first, within each account's 5-hour and weekly caps;
 *      an agent that does not answer within `claimTimeoutMinutes` is treated as out of usage and
 *      its task moves to another agent;
 *   5. wakes only the chosen Claude routine, through its API trigger, with the task in the run text.
 *
 * State lives in GitHub: labels (`to:<agent>`, `size:*`, `ui`) and one-line "Dispatch:" comments.
 * This repo is public, so the log prints counts and agent names only, never repo names or titles.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MIN = 6e4;
const HOUR = 36e5;
const DAY = 24 * HOUR;
const BLOCKING = ['claimed', 'blocked', 'in-review', 'jules', 'pause'];
const LANE_LABELS = {
  'size:S': ['c2e0c6', 'Small: docs, config, one-file change'],
  'size:M': ['fef2c0', 'Normal task'],
  'size:L': ['f9d0c4', 'Hard or cross-cutting: goes to an Opus agent'],
  'ui': ['bfdadc', 'Needs a browser to check: goes to Antigravity'],
  'to:codex': ['10a37f', 'Assigned to Codex'],
  'to:antigravity': ['4285f4', 'Assigned to Antigravity (runs on the Mac)'],
};
export const DISPATCH_RE = /^Dispatch:\s*([\w.-]+)\s*·\s*([^·\n]*?)\s*·\s*([\w-]+)(?:\s*·\s*sha=([0-9a-f]{7,40}))?/m;

const labelsOf = (i) => (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
const has = (i, l) => labelsOf(i).includes(l);
const ts = (iso) => (iso ? Date.parse(iso) : 0);
const numOf = (url) => { const m = /\/(\d+)$/.exec(url || ''); return m ? Number(m[1]) : null; };
const agentOfBody = (b) => { const m = /^\s*Agent:\s*([\w.-]+)/im.exec(b || ''); return m ? m[1].toLowerCase() : null; };
const isCodex = (login) => /codex/i.test(login || '');
const mentions = (body, n) => new RegExp(`(^|[^\\w])#${n}(?!\\d)`).test(body || '');

export async function run({ config, env = {}, now = Date.now(), fetchImpl = fetch, verbose = false } = {}) {
  const cfg = config;
  const API = 'https://api.github.com';
  const TOKEN = env.DISPATCH_GH_TOKEN || '';
  const DRY = env.DRY_RUN === '1' || !TOKEN;
  const NOW = now;
  const detail = [];
  const stats = { repos: 0, fired: 0, plans: 0, fixes: 0, codex: 0, human: 0, reclaimed: 0, reassigned: 0, antigravity: 0, waiting: 0, noAgent: 0, errors: 0 };

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
  function fireTarget(a) {
    const raw = env[a.secret] || '';
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
      return res.ok ? { ok: true } : { ok: false, why: `http-${res.status}` };
    } catch (e) {
      return { ok: false, why: 'network' };
    }
  }

  /* ---------- discovery ---------- */
  const owner = cfg.owner || (TOKEN ? (await gh('/user')).login : '');
  if (!owner) return { stats, detail, note: 'no token: add the DISPATCH_GH_TOKEN secret' };
  const all = await ghAll('/user/repos?affiliation=owner&sort=pushed', 2);
  const cands = all.filter((r) => r && !r.archived && r.owner && r.owner.login.toLowerCase() === owner.toLowerCase());
  const repos = [];
  for (const r of cands) {
    try { await gh(`/repos/${owner}/${r.name}/labels/ready`); repos.push(r.name); } catch { /* not an agent repo */ }
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
          changes: (reviews || []).some((r) => r.state === 'CHANGES_REQUESTED' && ts(r.submitted_at) > headAt),
          codexP1: (rcomments || []).some((c) => isCodex(c.user && c.user.login) && ts(c.created_at) > headAt && /\bP[01]\b/.test(c.body || '')),
          failedNames: failed.map((w) => w.name),
        });
      } catch (e) { stats.errors++; }
    }
    return { repo, base, home, issues, openPRs, prs, byNum, dispatches, codexLimitAt, labelNames, paused: issues.some((i) => has(i, 'pause')) };
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
    await comment(d, n, `Dispatch: ${a.name} · ${a.model} · ${mode}${sha ? ` · sha=${sha.slice(0, 7)}` : ''}\n\n${lines[0]}`);
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
    if (untriaged.length && NOW - lastTriage >= cfg.triageEveryHours * HOUR && available(admin) && canFire()) {
      const list = untriaged.slice(0, 25);
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
        await comment(d, i.number, `Dispatch: ${who} · — · reclaimed\n\nNo pull request ${cfg.staleClaimHours}h after the claim, so this issue is free again.`);
        i.labels = (i.labels || []).filter((l) => { const nm = typeof l === 'string' ? l : l.name; return nm !== 'claimed' && !(nm.startsWith('to:') && byName[nm.slice(3)]); });
        d.byNum.set(i.number, [...(d.byNum.get(i.number) || []), { created_at: new Date(NOW).toISOString(), body: `Dispatch: ${who} · — · reclaimed` }]);
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
            await comment(d, i.number, `Dispatch: ${last.who} · ${byName[last.who].model} · no-show\n\n${last.who} did not start within ${cfg.claimTimeoutMinutes} minutes (probably out of usage); moving on.`);
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
          if (kind === 'plan') stats.plans++; else stats.fired++;
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
