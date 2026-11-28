# PRODUCT.md — Product Strategy Contract for Headroom

## 1. One-Liner & Value Proposition

- **One-liner:** Headroom shows remaining **Claude Code**, **Codex**, and **Gemini** 5-hour and weekly usage limits with reset times and burn-rate forecasts at a glance on an iPhone home/lock-screen widget (via Scriptable), backed by a zero-cost Cloudflare Worker and D1 sync layer.

## 2. Target Users & Core Jobs-to-be-Done

| Persona | Context | Core Job-to-be-Done | Current Alternative |
|---|---|---|---|
| Multi-AI individual developer | Uses Claude Code, Codex, and Gemini across multiple machines (Windows / macOS) | When away from my desk or switching tools, I want to see remaining 5-hour and weekly quota plus reset times so I pace usage without wasting expiring capacity or hitting surprise lockouts | Manually opening terminals on each machine to check `/usage` |

## 3. Differentiators

- Zero quota spent on monitoring (reads local `/usage` and `statusLine` / RPC rate-limit state; halts automatically if model tokens would be billed).
- Zero App Store build or review overhead (runs in iOS Scriptable across home-screen small/medium/large widgets, 3 lock-screen widget styles, and an interactive detail view).
- Strictly fits inside the Cloudflare Workers and D1 Free Plan via precomputed public `/view` rows and hard daily D1 query budgets.

## 4. Current Stage & Monetization Model

```autopilot
stage: growth
monetization: none
```

- Open-source, self-hosted developer utility designed for `$0/mo` infrastructure cost on the Cloudflare Free Plan.

## 5. Current #1 Bottleneck & North Star Metric

```autopilot
bottleneck: onboarding
north_star_metric: time_to_first_live_widget_under_10_minutes
focus_areas:
  - "Surface already-stored D1 and collector fields in Scriptable widgets and CLI"
  - "Zero-friction setup self-diagnosis (doctor CLI) and stale vs paused clarity"
  - "Consolidate configuration and reduce ongoing solo-maintainer burden"
```

- **Evidence:** Initial setup spans Cloudflare D1 migrations, per-machine write tokens, `statusLine` wiring, and configuring the Scriptable widget on iPhone, making first-sync verification and stale/hold troubleshooting the main friction points.

## 6. Strict Non-Goals (NEVER Propose or Prototype)

- Never read, transmit, or store provider credentials, API keys, OAuth tokens, emails, account IDs, organization IDs, raw CLI output, or local file paths.
- Never make billable LLM or provider API calls to check usage limits.
- Never introduce paid infrastructure, external databases, Redis, or background polling that exceeds Cloudflare Workers and D1 Free Plan daily read/write limits.
- Never add third-party analytics, telemetry SDKs, or external trackers.
- Never require a paid Apple Developer account or native Xcode iOS app build for core widget viewing.

## 7. User Feedback & Competitor Notes

- Make it effortless on the phone to distinguish "data is stale because all PCs are asleep" from "collector is paused or rate-limited" without needing to inspect logs on a PC.
- Future display clients (macOS menu bar, Windows tray, Discord bot) should consume the existing precomputed Worker `/view` JSON contract without extra D1 reads.

## 8. `ai-prototype` Acceptance Criteria & Feature Flag Convention

```autopilot
feature_flag_mechanism: none
```

- Headroom is a solo-maintained Scriptable widget, local collector CLI, and personal Cloudflare Worker: `ai-prototype` changes ship as focused Draft PRs (< 300 changed lines) backed by direct unit test assertions rather than permanent runtime environment flags.
