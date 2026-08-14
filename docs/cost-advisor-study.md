# Cost Advisor — Design Study

**A session-monitoring suggestion engine for Claude Pipeline Manager.**
Status: design study (no code yet). Date: 2026-08-13.

This document answers one question in depth: *what is the best approach for a feature
that watches live Claude Code sessions and makes actual, actionable money/quota-saving
suggestions?* It is grounded in (a) what the app already measures, (b) Claude Code's real
telemetry surface, (c) proven cost-advisor design from cloud FinOps and observability, and
(d) the current, verified catalog of LLM cost-optimization techniques.

---

## 0. TL;DR — the recommendation

Build a **pure analysis module** (`src/main/usage/advisor.ts`) that consumes the per-session
telemetry the app *already* ingests and emits a small list of typed `CostSuggestion` objects,
surfaced as a passive 💡 panel next to the usage meter with one-click actions. Ship **two
detectors first** — they are where the real burn is and both are fully telemetry-detectable:

1. **Cache health** — low `cacheRead : cacheCreation` ratio (or caching effectively off). Anthropic's
   own single biggest lever; up to ~90% cheaper on long prompts.
2. **Un-cleared long sessions (context bloat)** — input-per-turn climbing over a multi-hour session.
   Attacks the quadratic re-send cost; the fix (`/clear`) is free.

Then add **model right-sizing** (Opus→Sonnet/Haiku, *suggest* never auto-apply) and **verbose-output**
detection. Follow four hard design rules from FinOps/SRE practice: **two axes (savings AND
risk, never blended); minimum-evidence gate before firing; actionable-or-silent; dismissal is a
learning signal.**

**Framing for Chad specifically:** this machine is on a **subscription** (no `ANTHROPIC_API_KEY`),
so "money" = **limit headroom** (session / weekly / Opus caps), not dollars. The `costUsd` figure
the app shows is *notional* on subscription. The advisor should speak in "you'll hit your weekly
Opus limit ~Thursday at this rate," not "$4.20" — and flip to real-dollar language only when
`apiKeyBilling` is true.

---

## 1. The billing reality (this decides the vocabulary)

| | Subscription (Max/Pro) — **Chad today** | API key (`ANTHROPIC_API_KEY` set) |
|---|---|---|
| Per-token billing | No | Yes (real $) |
| What "saving" means | **Limit headroom** — not burning session/weekly/Opus caps | **Dollars** |
| `costUsd` in the app | Notional (consumption proxy) | Real charge |
| Right unit for suggestions | "≈X% of your weekly Opus budget," time-to-limit | "≈$X saved" |

The app already distinguishes these: `Diagnostics.apiKeyBilling = !!process.env.ANTHROPIC_API_KEY`
(`index.ts:461`). The advisor should read that flag and switch its savings vocabulary accordingly.
Everything below is expressed as **percent of consumption** (works for both) plus a **dollar/limit
overlay** chosen by billing mode.

**Anthropic's own usage benchmark** (useful as the "is this session expensive?" baseline):
~**$13 per developer per active day**, **$150–250/month**, and **under $30/day for 90% of users**.
(Source: Claude Code costs docs.)

---

## 2. What the app can observe (telemetry surface)

### 2.1 What's already flowing
`UsageTracker` runs a local OTLP/JSON receiver and, per session (keyed by `session.id === termId`),
accumulates the delta counters Claude Code exports every 10s (`OTEL_METRIC_EXPORT_INTERVAL=10000`):

- `claude_code.token.usage`, `type ∈ {input, output, cacheRead, cacheCreation}` — **exactly the four
  fields the advisor needs.** (Confirmed metric/attribute names.)
- `claude_code.cost.usage` (USD) — Claude Code's *own* cost figure; the app prefers it and falls
  back to `estimateCost()` only when absent.
- `model` attribute per data point.

So the app is **already monitoring every session** with the same telemetry Anthropic's own `/usage`
"behavior flags" feature uses. What's missing is only the *analysis layer*.

### 2.2 The one gap: no history
`UsageTracker` keeps only the **latest cumulative** value per session (`SessionUsage`), then discards
each delta. Every high-value detector below needs **rate-of-change** (input-per-turn climbing, cache
churn over time, burn rate, model changing mid-session). Fix is small and local:

> On each `emit()`, push a `{t: Date.now(), input, output, cacheRead, cacheCreation, cost, model}`
> sample into a bounded per-session ring buffer (e.g. last 120 samples ≈ 20 min at 10s cadence).
> `Date.now()` is available in the Electron main process. This is the only new state the advisor needs
> for v1.

### 2.3 Optional upgrade: ingest OTEL *events* (logs), not just metrics
Metrics are session-cumulative. Claude Code also emits **structured events** (`claude_code.api_request`
/ `assistant_response`) carrying **per-turn** `input_tokens`, `output_tokens`, `cache_read_tokens`,
`cache_creation_tokens`, `cost_usd`, `duration_ms`, `model`, correlated by `prompt.id`. These give
true per-turn granularity (exact model per turn, real per-turn cache ratio, real burn rate) instead of
inferring it from 10s metric deltas.

To get them: add `OTEL_LOGS_EXPORTER=otlp` to `UsageTracker.envFor()` and handle `POST /v1/logs` on the
same receiver. Events are **opt-in and redaction-safe by default** — prompt/response *text* stays
redacted unless you set `OTEL_LOG_USER_PROMPTS=1` (don't; you don't need content). Recommended as a
**phase-2** enhancement, not required for v1.

### 2.4 Attribution (if you ingest events / newer metric attributes)
Some builds attribute token usage by `query_source` (main / subagent / auxiliary) and by
`mcp_server.name` / `skill.name` / `agent.name`. If present, this unlocks "MCP server X is eating N% of
your tokens" and "subagent fan-out is Y% of spend." Treat as bonus signals — detect their presence, don't
assume them.

### 2.5 The hard limit: usage-limit detection is NOT in telemetry
There is **no metric or event** that signals approaching or hitting a session/weekly/Opus limit — limits
are enforced server-side and surface only as an error string in stdout. The app already does the only
possible thing here: scrape stdout (`usage/limitDetect.ts`). The advisor should **reuse** that signal for
its limit-headroom projections, not try to invent a telemetry one.

### 2.6 Honest blind spots (state these; don't pretend to cover them)
- **Redundant file re-reads** — a large real waste (~42% of tokens in one cross-tool study) but
  **content-required**: distinguishing a re-read from legitimate new context needs tool-call arguments
  (`OTEL_LOG_TOOL_DETAILS`), not token counts. Flag as a known gap.
- **Why the cache broke** — you can detect *that* the prefix is thrashing; the specific offending byte
  (a timestamp, a reordered tool) is content-required.
- **Whether a task *needed* Opus** — token counts can't judge task difficulty. This is exactly why model
  right-sizing must **suggest**, never auto-downgrade (§4.3).
- **Whether accumulated context is still relevant** — telemetry sees size, not relevance.

---

## 3. Anatomy of a good suggestion (the model to copy)

Every mature cost advisor (AWS Compute Optimizer, Azure Advisor, GCP Recommender, Datadog) models a
recommendation as a **typed record with five fields**, not a sentence. Mirror it:

```ts
interface CostSuggestion {
  id: string                     // stable identity key: `${termId}:${kind}` — for dedup + dismissal
  kind: 'cache_health' | 'context_bloat' | 'model_rightsize' | 'verbose_output' | ...
  termId: string
  severity: 'high' | 'medium' | 'low'      // ranking bucket (never a blended score)
  finding: string                // typed, one-line: "Cache is effectively off this session"
  savings: {                     // ALWAYS a range + disclosed basis, never false precision
    lowPct: number; highPct: number
    absolute?: { lowUsd: number; highUsd: number } | { limitPct: number }  // billing-mode overlay
    basis: string                // "current per-token list rates × last-20-turn token mix"
  }
  confidence: 'low' | 'med' | 'high'       // SEPARATE axis from savings (see §3.1)
  evidence: string[]             // the numbers behind it — powers "why am I seeing this?"
  action?: {                     // advisory → one-click; omit if advisory-only
    label: string                // "Switch this terminal to Sonnet", "Send /clear"
    kind: 'relaunch_model' | 'inject_clear' | 'new_clean_terminal' | 'open_setting'
    payload?: unknown
    reversible: boolean
  }
}
```

### 3.1 Two axes, never one blend
The most important structural rule from the research: **savings and risk/confidence are independent
axes and must be shown separately.** Compute Optimizer computes a "performance risk" score apart from
the dollar delta; Datadog shows Risk × Level-of-Effort as two labels. A "switch Opus→Sonnet" suggestion
has *high savings* but *non-trivial risk* (the task might have needed Opus); a "send /clear" suggestion
has *high savings* and *near-zero risk*. Collapsing these into one "optimization score" is how advisors
lose trust. Show both.

### 3.2 Rank by savings, bucket by severity
Rank suggestions by estimated savings, but **bucket** into High/Med/Low so a $0.40 nit never sits
visually equal to a $40 win (Azure's impact tiers). When your estimate is uncertain, show a **range**
("Medium–High") rather than false precision (Azure does this deliberately).

### 3.3 Minimum-evidence gate (don't fire on one turn)
Cloud rightsizing tools refuse to recommend without an observation window (Compute Optimizer withholds a
finding below **30 hours** of data; Cost Explorer uses **14 days**). The session analog is **turns/samples,
not days**: require **N qualifying turns** (e.g. ≥6) before emitting model-rightsize or verbose-output.
One easy prompt ≠ evidence. Low evidence → widen the confidence band or don't fire (Kubernetes VPA's
"confidence multiplier" — short history self-suppresses).

### 3.4 Rightsize on the *peak*, not the mean
The universal rightsizing mechanic: **clip peaks at a percentile → add a headroom buffer → pick the
smallest option that still fits.** "Average CPU 8% but p99 spike to 90% → cannot downsize" maps directly:
judge model-rightsizing on the **hardest recent turns (p95 of task difficulty)**, not the average turn.
If even the p95 turn looks trivial by token profile, downgrade is safe; keep a headroom buffer so you
don't recommend right at the cheaper model's ceiling.

---

## 4. The detector catalog (ranked by real savings)

Each detector: signal → threshold → expected savings → feasibility → action. Ranked by real-world impact.

### 4.1 Cache health — **highest confidence, telemetry-native** ⭐ ship first
- **Signal:** the `cacheRead : cacheCreation` ratio over recent samples. Anthropic states the rule
  verbatim: *"A high read-to-creation ratio means caching is working well. If creation stays high turn
  after turn, something is changing in your prefix."*
- **Fire when:** (a) both cache fields ≈ 0 across the session → caching effectively **off** (the single
  highest-value nudge); or (b) `cacheCreation` stays high turn-after-turn while `cacheRead` doesn't grow
  → prefix thrashing; or (c) a fresh full cache-write after a long idle gap → TTL expiry.
- **Savings:** cache reads bill at **0.1× input** (a 90% discount). In long sessions cache reads come to
  dominate cost — by ~50K tokens, cache reads can be ~87% of total. Getting caching working is the biggest
  clean win.
- **Feasibility:** fully telemetry-detectable (you have both fields). You can detect *that* it's broken;
  *why* is content-required — so the suggestion is "your cache isn't being reused; long idle gaps or a
  changing prompt prefix are the usual causes," not a byte-level diagnosis.
- **Cache mechanics (verified):** write 1.25× (5-min TTL) or 2× (1-hour TTL); read 0.1×. Break-even: 2
  requests (5-min) / 3 requests (1-hour). **Claude Code auto-requests the 1-hour TTL on a subscription,
  5-min on API key** — so on Chad's machine cache-writes cost 2×, and idle gaps beyond an hour (not 5 min)
  are what expire it. Min cacheable prefix is model-specific (Opus 4.x/Haiku 4.5 = 4096 tokens; Fable 5 /
  Sonnet 4.6 = 2048). **Note:** `pricing.ts` uses `CACHE_WRITE_MULT = 1.25` (the 5-min value); for a
  subscription session that's an under-estimate — consider 2× when `!apiKeyBilling`.
- **Action:** advisory + explainer (pace prompts within the TTL, keep the prompt prefix stable). Precedent:
  Claude Code's own `/usage` flags "cache misses" at ≥10% of usage.

### 4.2 Un-cleared long session / context bloat — **telemetry-native** ⭐ ship first
- **Signal:** input-tokens-per-turn (or `input + cacheRead` per turn) climbing monotonically across a
  session whose wall-clock spans hours, with no reset.
- **Why it matters most structurally:** the model is stateless, so the **full conversation is re-sent as
  input every turn** — cumulative input cost follows a **triangular N(N+1)/2 curve**, growing *faster than
  linearly*. A documented example: a 20-step loop accumulates ~210,000 input tokens (not 20K); a naive
  10-step file-reading agent cost 43× a single-pass baseline. Anthropic names *"long sessions that were
  never cleared"* as a top cause of surprise spend, and **`/clear` costs nothing.**
- **Fire when:** context (`input + cacheRead + cacheCreation`) crosses a threshold (~100–150k) AND
  per-turn input is materially above the session's opening turns (e.g. ≥3×) AND wall-clock > ~1h.
- **Feasibility:** telemetry-native (tokens + timestamps from the ring buffer). Blind spot: can't tell if
  the accumulated context is *still relevant* — so phrase it conditionally ("if your next task is
  unrelated…").
- **Action (one-click, near-zero risk):** inject `/clear\r` into the terminal (the app already does
  bracketed-paste prompt injection), or spawn a fresh clean terminal. Mid-task, suggest `/compact`
  instead. Precedent: `/usage` flags "long context" at ≥10% of usage.

### 4.3 Model right-sizing (Opus → Sonnet → Haiku) — **biggest multiplier, but SUGGEST only**
- **Signal:** `model` is `claude-opus-*` on a session whose token/turn profile looks simple (short prompts,
  low output, no sign the harder turns needed Opus), sustained over ≥N qualifying turns.
- **Savings (verified current rates, per MTok in/out):** Opus $5/$25 · Sonnet 4.6 $3/$15 · Haiku 4.5 $1/$5
  · Fable 5 $10/$50. So **Opus is 5× Haiku and ~1.7× Sonnet** on both sides. Anthropic explicitly names
  *"Opus left as the default model"* as a top cause of surprise spend. Compute the counterfactual by
  re-pricing the same token counts at the cheaper model (`estimateCost()` already does the arithmetic — and
  `pricing.ts` is **confirmed correct/current**, including `claude-mythos-5`).
- **The hard caveat — never auto-downgrade coding:** telemetry cannot tell whether the task *needed* Opus.
  LiteLLM's own benchmark showed **SWE-bench Lite dropping 85%→75%** on a cheaper model; the "almost right"
  trap (code that compiles but is subtly wrong) surfaces days later. Router studies collapse to <10%
  accuracy on *hard* queries — exactly where hard coding tasks live. **So: surface the potential saving and
  a one-click "restart on Sonnet," but frame it as a prompt to the user, and gate it on §3.3 (evidence) +
  §3.4 (judge the p95 hardest turn, not the mean).**
- **Feasibility:** telemetry-detectable to *flag the opportunity*; content-required to *route safely*.
  High savings axis, **non-trivial risk axis** — the textbook case for §3.1's two-axis display.
- **Action:** `relaunch_model` — the app can respawn a terminal with a different `--model` (mirrors
  `PtyManager.relaunchResume`, swapping the model arg). Mark reversible (affects the next turns only).
  Note switching model mid-conversation invalidates that session's prompt cache (caches are per-model), so
  the action is best offered *at the start* of a session or terminal, the cheapest moment to act.

### 4.4 Verbose output — telemetry-native (partial)
- **Signal:** abnormally high output-token share, or high mean output-per-turn.
- **Savings:** output is the expensive side (5× input across the lineup). Studies: a "be concise" CoT
  instruction cut length ~49% at near-flat accuracy; token-budget prompting cut output ~67% with <3%
  accuracy loss.
- **Caveat:** can't verify from telemetry whether verbosity was warranted; over-compressing reasoning on
  cheaper tiers hurts accuracy. So: detect the *pattern*, recommend the *setting* (concise-output / effort
  tuning), don't force it.
- **Feasibility:** telemetry-detectable (you have output tokens). Action: advisory + link to effort/output
  settings.

### 4.5 Parallel-Opus / fleet burn (subscription-specific) — telemetry + limit-scrape
- **Signal:** N terminals simultaneously on `claude-opus-*` with high combined burn rate, cross-referenced
  with the limit-reset info `limitDetect.ts` already scrapes.
- **Value (subscription):** project **time-to-limit** ("3 terminals on Opus; at this rate you'll hit your
  weekly Opus cap ~Thursday"). This is the most *Chad-relevant* detector — it's about his real constraint
  (limits), not notional dollars.
- **Feasibility:** burn rate from the ring buffer; reset time from stdout scrape. Grouped, fleet-level
  suggestion (one card, not one per terminal — see §5.3).

### 4.6 Known blind spots to *log, not detect* (no silent truncation)
Redundant file re-reads (§2.6), cache-break root cause, task-difficulty for routing. If the advisor bounds
its own coverage, **say so** in the UI ("Not checked: repeated file reads — needs tool-content telemetry")
rather than implying full coverage.

---

## 5. Suggestion-engine behavior (the part that decides if it gets ignored)

Alert/recommendation fatigue is the dominant failure mode; every domain that studied it converges on the
same doctrine.

### 5.1 Actionable-or-silent (the single most-repeated rule)
Google SRE: *"Every page should be actionable"*; the kill-test — *"if people just say 'I looked, nothing
was wrong,' remove the rule."* incident.io: *"if an alert fires and the on-call cannot take a specific
action, the alert should not exist."* **For the advisor:** if a suggestion has no one-click/obvious action
*and* no material savings, **don't surface it as a nudge** — log it to the passive panel only. Ewaschuk's
quantitative bar: a suggestion type dismissed >~50% of the time is **broken** — auto-retire or retune it.

### 5.2 Default passive; interrupt rarely and at the cheapest-to-act moment
NN/g / Apple HIG: route by urgency — passive items get a **badge/panel**, only high-value + right-moment
items earn an inline interrupt. Interruptions carry a real cost (more stress, time pressure — CHI 2008).
**For the advisor:** the 💡 panel next to the usage meter is home base; the *only* justified in-context
interrupt is a big win at the cheapest moment (e.g. an inline card as a new terminal spins up on Opus,
*before* cost accrues). Never a modal for a routine suggestion. Never a fading toast as the only path to a
needed action.

### 5.3 Dedup, group, hysteresis
- **Stable identity key** per suggestion (`${termId}:${kind}`) so a recurring condition updates one card
  instead of spawning N (Opsgenie de-dupes on an alias).
- **Group fleet-wide conditions** — if 12 terminals are all over-modeled, show **one** grouped card, not 12.
- **Hysteresis / recovery thresholds** so a session hovering at the boundary doesn't flap on/off (Datadog
  recovery thresholds, Nagios flap detection). Fire at threshold T, clear only below T−margin.
- **Bounded renotify** — a dismissed/snoozed suggestion gets at most *one* later reminder, never per-tick.

### 5.4 Dismissal is a first-class learning signal
GitLab's pattern: show again ~6 weeks later; if dismissed twice, never again — persisted per-user. Separate
**dismiss** (not now) from **deny** (never), keep "never" recoverable (Dependabot's dismiss-until-patch vs
dismiss-indefinitely). Feed per-`kind` dismiss rates back into §5.1's auto-retire. This is what keeps the
advisor from becoming nagware.

### 5.5 Credible savings display
- **Ranges, not point estimates** — a point prediction for an uncertain outcome reads as *less* credible.
  Show a central band; be conservative (prefer under-claiming).
- **Disclose the basis** — "based on current per-token list rates × your last-20-turn token mix" (Compute
  Optimizer exposes an explicit before/after-discount mode).
- **Dedupe overlapping wins** so the headline total is honest — don't let "switch model" and "shrink
  context" both claim the same tokens (Cost Optimization Hub deduplicates overlapping recommendations).

### 5.6 Trust in one-click remediation
Preview → apply → reversible → explainable (VS "Preview Changes," Dependabot's PR-as-proposal). For the
advisor: "Apply" states exactly what changes (which model, `/clear` vs new terminal), is reversible
(affects only the next turns), and has a **"why am I seeing this?"** expander showing the `evidence[]`
(the token history behind the call). Mirror Compute Optimizer's simulated-utilization graph: let the user
see the numbers before trusting the call.

---

## 6. Anti-patterns to avoid (from mature tools' failures)

| Anti-pattern | Evidence | Mitigation baked into the design |
|---|---|---|
| One blended "score" | Compute Optimizer/Datadog keep savings and risk separate | §3.1 two axes |
| Averages hide peaks → break the workload | "avg 8%, p99 90% can't downsize" | §3.4 judge the p95 hardest turn |
| Fires on too little data | Compute Optimizer's 30-hour guard | §3.3 minimum-evidence gate |
| Non-actionable noise | SRE actionable-or-silent; FinOps "tickets weren't actionable" | §5.1 |
| Auto-remediation on stale/uncertain data | AWS Oct-2025 postmortem; ASG feedback-loop outage | Human-in-the-loop by default; model-downgrade is *suggest-only* |
| Inflated/false savings | GCP estimates exclude discounts; List vs Effective price confusion | §5.5 actual rates, ranges, dedupe |
| Flapping / over-triggering | Azure autoscale flapping from thin margins | §5.3 hysteresis + recovery margin |
| Nagware | GitLab/Dependabot dismissal design; >50% dismiss = broken | §5.4 dismissal memory + auto-retire |
| Silent coverage caps | FinOps "treat recommendations as recommendations" | §4.6 log blind spots, don't hide them |

---

## 7. Architecture & implementation plan (mapped to this codebase)

The app already has the right shape for this: pure, unit-tested modules
(`usage/limitDetect.ts`, `tasks/merge.ts`, `ProjectManager`) verified by esbuild runtime tests.
The advisor follows the same pattern.

### 7.1 Modules
- **`src/main/usage/history.ts`** (new) — bounded per-session ring buffer of timestamped samples.
  Fed from `UsageTracker.emit()`. (~40 lines.)
- **`src/main/usage/advisor.ts`** (new, **pure**) — `analyze(snapshot, history, opts) → CostSuggestion[]`.
  No I/O, no `Date` inside (pass `now` in) so it's deterministically testable, matching `limitDetect.ts`.
  Houses the detectors (§4) and the evidence/confidence/severity logic (§3).
- **`src/main/usage/suggestionStore.ts`** (new) — holds live suggestions, applies dedup/hysteresis/
  dismissal state (§5.3–5.4), persists dismissals per-user (reuse the `<userData>` JSON pattern from
  `ProjectManager`). Emits `suggestions:changed`.
- **Wiring** — `UsageTracker.onUsage` → push to history → run `advisor.analyze` → reconcile into
  `suggestionStore`. Reuse `apiKeyBilling` + `limitDetect` reset info for the billing/limit overlays.
- **`pricing.ts`** — reused as-is for counterfactuals; add a `cacheWriteMultFor(billing)` helper (1.25×
  API / 2× subscription) so cache-cost math matches Claude Code's actual TTL choice.

### 7.2 Renderer
- **`stores/suggestionStore.ts`** + **`components/CostAdvisor.tsx`** — a 💡 panel in the usage strip
  (mirror `ResumeBar.tsx` / `MemoryCheck.tsx`). Each card: finding · savings range · severity chip ·
  confidence chip · "why?" expander (`evidence[]`) · action button + dismiss/snooze.
- **Actions via IPC** — `advisor:apply` → for `inject_clear` reuse the existing bracketed-paste inject;
  for `relaunch_model` reuse the relaunch path with a model override; for `new_clean_terminal` reuse
  `term:create`.

### 7.3 Verification (match the repo's habit)
Pure `advisor.ts` + `history.ts` + merge/dedup logic → esbuild runtime test (`scripts/test-advisor.mjs`)
with synthetic session traces: caching-off, prefix-thrash, context-bloat-over-hours, all-Opus-simple,
verbose-output, and the negatives (healthy session → **zero** suggestions — the most important test, since
the whole game is not crying wolf).

### 7.4 Phasing
1. **v1** — history ring buffer + `advisor.ts` with **cache-health + context-bloat** + passive panel +
   `/clear` and new-terminal actions + dismissal memory. Highest ROI, lowest risk, no env changes.
2. **v2** — model-rightsize (suggest-only, two-axis card, relaunch action) + verbose-output + fleet/
   time-to-limit projection using `limitDetect`.
3. **v3** — ingest OTEL **events** (`OTEL_LOGS_EXPORTER`) for true per-turn precision + `query_source` /
   MCP / subagent attribution ("MCP server X is N% of your tokens").

---

## 8. Corrections & notes on current code

- ✅ **`pricing.ts` is correct and current** — Opus $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5,
  Fable 5 $10/$50, cache-read 0.1×, cache-write 1.25×; even includes `claude-mythos-5`. (Earlier I wrongly
  guessed Opus should be higher — it shouldn't.)
- ⚠️ **Cache-write multiplier vs TTL** — 1.25× is the 5-min value. Claude Code uses the **1-hour** TTL on
  subscription (2× write). For subscription sessions the estimate under-counts cache-write; add a
  billing-aware multiplier if you want the counterfactuals to match reality. (Low impact on subscription
  since cost is notional, but it matters for the *savings math* the advisor shows.)
- ✅ **`limitDetect.ts` stdout-scraping is the correct approach** — confirmed there is no telemetry signal
  for limits; reuse it for time-to-limit projections rather than inventing one.
- **History is the only missing primitive** — `UsageTracker` discards deltas; add the ring buffer.

---

## 9. Sources (load-bearing)

- **Claude Code telemetry & costs:** code.claude.com/docs — monitoring-usage, costs, model-config
  (metric names, `type` values, events, `/usage` behavior flags, auto-compaction, limit behavior).
- **Pricing/caching (authoritative):** Anthropic model & pricing tables (Opus $5/$25 · Sonnet 4.6 $3/$15 ·
  Haiku 4.5 $1/$5 · Fable 5 $10/$50; cache read 0.1×, write 1.25×/2×; per-model min prefix); prompt-caching
  docs (read:creation ratio rule, 1h-TTL-on-subscription).
- **FinOps/advisor design:** AWS Compute Optimizer & Cost Explorer (typed findings, performance-risk axis,
  percentile+headroom, 14-day/30-hour guards); Azure Advisor (impact tiers, ranges); GCP Recommender
  (priority/severity); Datadog Cloud Cost (risk × effort).
- **Alert fatigue:** Google SRE book & Ewaschuk "My Philosophy on Alerting" (actionable-or-silent, <50%
  accuracy = broken); incident.io; PagerDuty; clinical-alarm & SOC fatigue studies.
- **UX:** NN/g notifications taxonomy; Apple HIG; GitLab/Dependabot dismissal patterns; VS/VS Code preview-
  before-apply; CHI 2008 interruption-cost.
- **LLM cost techniques:** Anthropic prompt-caching blog & "lessons from building Claude Code"; quadratic
  re-send analyses (Augment Code, exe.dev); LiteLLM auto-router benchmark & RouterArena (downgrade risk);
  concise-CoT / token-budget papers; Helicone/ccusage (what LLM-spend tools surface today).
