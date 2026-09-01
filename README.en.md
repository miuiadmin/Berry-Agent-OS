<p align="center">
  <strong>Berry</strong><br>
  <sub>Possibly the world's first Agent OS</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/berryagent"><img alt="npm" src="https://img.shields.io/badge/version-1.0.0--alpha-blue?style=flat-square"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.19-green?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square">
  <img alt="telemetry" src="https://img.shields.io/badge/telemetry-0-brightgreen?style=flat-square">
  <img alt="codename" src="https://img.shields.io/badge/codename-Peiligang-orange?style=flat-square">
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <strong>English</strong> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a>
</p>

---

> **The most romantic thing I can imagine is growing old together with your Agent.**

Your Agent remembers the hesitation from that microservice refactoring six months ago. It knows which repos you trust, which frameworks you hate, that code written at 3 AM usually needs rewriting. It wasn't born today — it has been with you for two hundred days, through three projects' life and death, accumulating a lifetime of preferences, trust, and hard-won lessons.

This is not science fiction. This is Berry's design goal: **an operating system where Agents stay alive** — not a disposable sandbox, not a monthly-reset free trial, but a place where an Agent can settle, grow, and grow old.

Berry's minimal kernel does exactly **install, run, guard, store**; everything else — conversation, coding agent, memory, long goals, scheduled tasks, MCP, LSP, observability, web UI — loads as an **application** on the composition tree. **Installable, unloadable, replaceable** — while your Agent's five lifelines (credentials, memory, trust history, budgets, ledgers) accumulate only once. Every app grows on the same state — **new brain, same body**.

**27** modules (all implemented) · **27** lifecycle hooks · **25** durable event types · **15** official bundle pieces (14 Ring 2 + default coder app, each unloadable) · **2,400+** tests · **0** telemetry.

**Floor goal: the factory default layer ships at the daily-usable level of Codex / Claude Code.**

## Table of Contents

- [Berry in Three Minutes](#berry-in-three-minutes)
- [Positioning at a Glance](#positioning-at-a-glance)
- [Architecture at a Glance](#architecture-at-a-glance)
- [Quick Start](#quick-start)
- [Features at a Glance](#features-at-a-glance)
- [Architecture at a Glance](#architecture-at-a-glance)
- [Everything Is an App](#everything-is-an-app)
- [Security Model](#security-model)
- [Documentation](#documentation)
- [What Berry Is Not](#what-berry-is-not)
- [Project Status](#project-status)
- [Telemetry](#telemetry)
- [Contributing](#contributing)
- [License](#license)

---

## Berry in Three Minutes

### Act I: Today's Agents are disposable

Have you noticed that every time you switch AI tools, you have to teach it all over again? — "I use pnpm", "don't touch that file", "you can trust this repo". It learns. Then you switch tools, and everything resets to zero. **Today's Agents have no childhood, no growing up — only first encounters, over and over.** ChatGPT doesn't remember your Claude preferences, Claude Code doesn't know the rules you taught it in Cursor. All your investment in tuning becomes preparation for the next reset.

### Act II: What's missing is not brains, it's life

In 2026, model capabilities converge and prices fall — smart brains are available for rent to anyone. But what you actually need is not a smarter brain, **it's a companion that remembers you**. Who remembers which repositories you trust? Who holds the decision trail from that 3 AM refactoring? Who still carries your shared habits and lessons after you've switched from model to model? **The answers don't live in models — they live in the lifeline your Agent needs.**

### Act III: Berry — the OS where Agents settle

Berry answers this the operating-system way. Your Agent's every day is an **append-only event log** — every conversation turn, every tool call, every approval decision, durably recorded, tamper-proof, never lost. The memory piece extracts and evolves, long goals continue across days, skills sharpen with use, trust accumulates one entry at a time. **Your Agent has lived here for a long time, and will live longer.** Switching models is like an organ transplant — the brain gets upgraded, but the body remembers everything.

## Positioning at a Glance

|                       | Agent Frameworks  | Coding Agents       | **Berry**                           |
| --------------------- | ----------------- | ------------------- | ----------------------------------- |
| **What you get**      | SDK + deps        | A product           | **An OS where Agents settle**       |
| **Capability form**   | Code in your repo | Hardwired           | **Data — installable & unloadable** |
| **State across apps** | Siloed            | Locked in the app   | **Lifelines that never reset**      |
| **Upgrading**         | Rewrite & deploy  | Wait for the vendor | **Install / uninstall / `/reload`** |
| **Ecosystem**         | —                 | Closed              | **npm is the market (3 sources)**   |
| **Floor**             | Depends on you    | Codex / Claude Code | **Factory defaults = daily-usable** |

Alright, enough romance. **Now the steel and iron.**

## Architecture at a Glance

```text
            ┌─────────────────────────────────────────────┐
            │  Fixed kernel (Ring 0): install · run ·     │
            │  guard · store — 27-module one-way DAG,     │
            │  machine-gated, not unloadable              │
            └──────────────────┬──────────────────────────┘
                               │ composition tree (default layer + overlay.yaml)
        ┌──────────┬──────────┼──────────────┬───────────┐
        ▼          ▼          ▼              ▼           ▼
     coder       chat      memory         goal      …11 pieces
   (default     (conver-  (operator     (long       (each
     app)       sation)    state)       goals)    unloadable)
        └──────────┴──────────┴──────────────┴───────────┘
                               │ event sourcing (append-only log = source of truth)
                               ▼
                 SQLite WAL: sessions · credentials · memory · ledgers
```

## Quick Start

```bash
# Requires Node.js >= 22.19
git clone <this repo> && cd berry
npm install
npm run build
npm link          # installs the berry command

berry             # interactive TUI (defaults to the coder app, resumes the latest session in the current directory)
berry run "hi"    # one-shot run (exit code is the result)
berry dump-config # effective-composition diagnostics (model / composition tree / app load state, no database writes)
```

First launch creates the data directory at `~/.berry/`. The default model is `anthropic/claude-sonnet-5`, overridable via `APP_MODEL`; provider credentials go through the pi-ai credential chain (environment variables or the credential store).

## Features

### Kernel

- **27-module one-way DAG**: all implemented, machine-enforced by `npm run lint:topology` — no central anything beyond install/run/guard/store, not unloadable.
- **Three-ring assembly**: Ring 0 (kernel, fixed) → Ring 1 (required rows, replaceable) → Ring 2 (official bundle, each unloadable) → Ring 3 (third-party ecosystem).

### Sessions & Data

- **Event sourcing**: append-only event log (SQLite WAL) + derived projections — **every day of your Agent is a durable fact**.
- **Long-conversation compaction** (`compaction`): surfaceOp masking + five-step durable flow, zero new table families.
- **Workspace snapshot rollback** (`checkpoint`): sha256 blob store + per-run manifest, `/rewind` two-phase transactional rollback.
- **Session forking & adoption**: `fork` prefix freeze + `adopt` foreground switch.

### Official Bundle (Ring 2, each unloadable)

| Piece        | Role                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `coder`      | Default coding-agent app (pure manifest, `/app` to switch)                                                        |
| `chat`       | Conversation app (fallback anchor)                                                                                |
| `memory`     | Memory store: extraction/merging/dual-path injection/cross-session retrieval/utility evolution/TTL/version chains |
| `subagent`   | Sub-agent delegation + declarative sub-agents                                                                     |
| `goal`       | Long-goal state machine + budget brake + clock wake                                                               |
| `scheduler`  | `/tick` scheduled tasks — launchd/crontab registrar, no resident process                                          |
| `mcp`        | MCP client bridge (stdio, zero new dependencies)                                                                  |
| `lsp`        | Language-server bridge: diagnostics/symbols/definitions/references + post-write diagnostic injection              |
| `web`        | Fetch tool + SSRF five-part hygiene                                                                               |
| `compaction` | Long-conversation compaction: surfaceOp masking + five-step durable flow                                          |
| `checkpoint` | Workspace snapshot rollback: sha256 blob store + `/rewind` two-phase transactional rollback                       |
| `obs`        | Observability: hourly rollups + `obs_query` + `/obs` overview + alerting                                          |
| `admin`      | Platform admin: apps_list / events_query / install verbs                                                          |
| `webui`      | Loopback web UI (`--port` one-shot, SSE + SPA)                                                                    |
| `browser`    | Browser automation: hand-written minimal CDP bridge + navigate/snapshot/interaction tools                         |

### Security Stack

- **Three-stage tool pipeline**: schema validation → gate (approval/sandbox/allowlist) → execute — durably ledgered, no bypass.
- **Three sandbox tiers**: `read-only` / `workspace-write` / `danger-full-access` (macOS seatbelt / Linux bwrap).
- **Approval pairs**: `approval/asked` → `approval/decided` audit trail.
- **Allowlist**: audit-logged auto-approve, enumerable and revocable.
- **Vocabulary enforcement**: machine-checked event vocabulary — misspelled names fail loudly, kernel words can't be forged.

### Loading & Ecosystem

- **Composition tree**: default layer + `overlay.yaml` field-level overrides.
- **Two-state install/mount**: `install` to warehouse (zero effect), `mount` writes the row that makes it live.
- **Two-tier scoping**: global (official) / per-app (third-party — authorization and blast radius follow the host app).
- **`/reload --app`**: per-zone hot reload — other apps' runtimes untouched.
- **Skills**: SKILL.md two-layer + progressive disclosure — drop a directory in and it works.

## Everything Is an App

Loading follows the **app-center model**: an app is an independent installable (npm's three sources are the marketplace — registry names / git / local directories; no proprietary store), and installing alone changes nothing — install puts it in the warehouse, mounting writes the composition row that makes it live. Official pieces mount globally to serve all apps (operator state such as memory grows on one shared base); third-party pieces mount per-app (authorization and blast radius follow the host app).

Writing a Berry app takes a single `index.ts`: a default-exported `apply(ctx, config)`, declarative metadata (inject dependencies, config schema, event vocabulary), and every registration goes through `ctx.effect` — scope rollback un-registers automatically. 27 lifecycle hooks span six layers (session / agent / turn / message / tool pipeline / provider), with the full observation and governance surface open. See the [App Development Guide](docs/应用开发指南.md) (Chinese).

## Security Model

- **Three-stage tool pipeline**: schema validation → gate (approval / sandbox / allowlist decisions) → execute — the only legal path for tool execution, durably ledgered with no bypasses.
- **Three sandbox tiers**: `read-only` / `workspace-write` / `danger-full-access`; third-party apps default to the external process domain (per-row fork + PM middle layer + OS sandbox layer), with indirect subprocesses narrowed by row-level whitelists. **Apps are born sandboxed — permissions are declared, never stolen.**
- **Approval pairs**: every write-level action lands an `approval/asked` / `approval/decided` audit pair; "always allow" goes through the enumerable, revocable allowlist.
- **Vocabulary enforcement**: the event-vocabulary registry is machine-checked — misspelled names fail loudly, and kernel words cannot be forged by third parties.

## Documentation

| Doc                                          | Contents                                             |
| -------------------------------------------- | ---------------------------------------------------- |
| [docs/架构总览.md](docs/架构总览.md)         | Ring model, module DAG, event system, assembly order |
| [docs/使用指南.md](docs/使用指南.md)         | CLI / TUI commands, data directory, env vars, skills |
| [docs/应用开发指南.md](docs/应用开发指南.md) | entry.ts shape, inject services, hooks, composition  |
| [docs/开发指南.md](docs/开发指南.md)         | Four gates, test discipline, module boundaries       |
| [docs/运维手册.md](docs/运维手册.md)         | Data layout, backup, reset, dual-open guards, triage |

> Documentation is currently authoritative in Chinese; English versions are planned alongside the 1.0 release.

## What Berry Is Not

- **Not another agent framework** — a framework gives you an SDK to write code; Berry gives you a loading surface to install apps. Capability pieces are data (installable, unloadable, replaceable), not dependencies in your project.
- **Not a resident cloud service** — the single-machine form defaults to zero ports and zero listeners; the web UI is a loopback piece opened one-shot via `--port`, and the daemon form is an explicit choice.
- **No autonomy promises** — approval pairs, budget brakes, an enumerable and revocable allowlist: write authority stays with humans and ledgers, and every bit of power the model gets has an audit surface.
- **No second ecosystem format** — apps are npm packages (three-source distribution), skills are SKILL.md directories, configuration is overlay.yaml: no proprietary store, no proprietary container format.

## Project Status

`1.0.0-alpha` — pre-release window: APIs, vocabulary, and type surfaces evolve freely; breaking changes land as single atomic commits. Retrieval, command execution, web access, MCP, LSP, and observability (rollups + alerting) are implemented; the multi-tenant server form is deferred until real demand pulls it.

## Telemetry

**Zero telemetry by default** — this tool sends no network packets: no usage statistics, no crash reports, no version checks (upgrading is entirely your decision). The model calls you configure are the only outbound traffic. **Your Agent's life belongs to you alone.**

If any reporting is ever introduced, four promises apply: announcement first (Why this exists / How it works / What data is collected / How to disable it — all four sections before release), off by default (flipping the default is a Breaking Change), a machine-verifiable off switch (not a promise that it can be turned off), and minimal data (anything that can stay offline stays offline).

## Contributing

```bash
npm run dev               # TUI (tsx, debug-level logs by default)
npm test                  # full test suite
npm run typecheck         # tsc --noEmit, two passes
npm run lint:topology     # module DAG + event vocabulary gates
npm run format:check      # Prettier
```

All four gates green is the precondition for every commit. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) — official pieces ship with the package; third-party apps and skills carry their own licenses.
