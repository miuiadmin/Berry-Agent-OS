<p align="center">
  <strong>Berry</strong><br>
  The operating system for AI applications
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/berryagent"><img alt="npm" src="https://img.shields.io/badge/version-1.0.0--alpha-blue?style=flat-square"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.19-green?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square">
  <img alt="telemetry" src="https://img.shields.io/badge/telemetry-0-brightgreen?style=flat-square">
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <strong>English</strong> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a>
</p>

---

The Berry kernel does exactly four things — **install, run, guard, store** — and everything else ships as an application on the composition tree. Models and tools change every month; your credentials, memory, trust history, budgets, and ledgers accumulate only once. Berry holds these five pieces of operator state, and every app you install grows on the same state — the next one just continues where the last left off.

Apps come in three shapes along the type axis: **applications (launched) / extensions (invoked) / services (depended on)** — even the first-run experience is not in the kernel: the factory default is the **coder** coding-agent app (pure manifest assembly), with the official `chat` conversation app as the fallback anchor. Dual self-evolution (usage evolution + skill evolution) takes the emergent path: no central scheduler, the kernel only provides primitives.

**Floor goal: the factory default layer ships at the daily-usable level of Codex / Claude Code.**

**26** modules (all implemented) · **35** lifecycle hooks · **16** durable event types · **12** official bundle pieces (each unloadable) · **2,400+** tests · **0** telemetry.

## Table of Contents

- [Why Berry](#why-berry)
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

## Why Berry

The real asset of an AI application is not the model — models change monthly — it is **operator state**: credentials, memory, trust history, budgets, ledgers. Today you use a conversation app, tomorrow a coding agent, the day after a data-cleaning app. They should all grow on the same state instead of starting from zero each time.

Berry answers this the operating-system way:

- **Minimal kernel**: the fixed kernel does four things — install (app & context loading), run (agent loop), guard (security & approval), store (sessions & credentials). 25 modules in a one-way dependency DAG, enforced by machine gates — the kernel cannot be unloaded and its responsibilities cannot bloat.
- **Everything is an app**: conversation is an app, the coding agent is an app, the memory store is an app — even the MCP bridge and the web UI are apps. Apps can be installed, unloaded, and replaced; remove any one of them and the core loop keeps running.
- **Event-sourced sessions**: a conversation is an append-only event log (SQLite WAL); model history is a projection of the log. Masking, forking, recovery, and replay are all carried by log semantics — your history is your data.

## Architecture at a Glance

```text
            ┌─────────────────────────────────────────────┐
            │  Fixed kernel (Ring 0): install · run ·     │
            │  guard · store — 25-module one-way DAG,     │
            │  machine-gated, not unloadable              │
            └──────────────────┬──────────────────────────┘
                               │ composition tree (default layer + overlay.yaml)
        ┌──────────┬──────────┼──────────────┬───────────┐
        ▼          ▼          ▼              ▼           ▼
     coder       chat      memory         goal      …12 pieces
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

## Features at a Glance

- **Minimal kernel (Ring 0)**: 25 modules in a one-way DAG, all implemented, machine-enforced by `npm run lint:topology` — no central anything beyond install/run/guard/store.
- **Event-sourced sessions**: append-only event log + derived projections; long-conversation compaction (`compaction`), workspace snapshot rollback (`checkpoint` /rewind), session forking and adoption — all carried by the log.
- **Official bundle (Ring 2, every piece unloadable)**: `coder` (default coding-agent app), `chat` (conversation app), `memory` (memory store: extraction/merging/dual-path injection/cross-session retrieval/utility evolution/TTL/version chains), `subagent` (sub-agent delegation), `goal` (long-goal state machine + budget brake + clock wake), `scheduler` (`/tick` scheduled tasks — launchd/crontab registrar, no resident process), `mcp` (MCP client bridge), `lsp` (language-server bridge: diagnostics/symbols/definitions/references), `web` (fetch tool + SSRF hygiene), `obs` (observability: hourly rollups + `obs_query` + `/obs` overview + alerting), `admin` (platform administration tools), `webui` (loopback web UI, one-shot `--port`).
- **Built-in security stack**: three-stage tool pipeline (schema validation → gate → execute), three sandbox tiers (read-only / workspace-write / danger-full-access, macOS seatbelt / Linux bwrap), writable-root derivation and carve-outs, approval pairs, allowlist (audit-logged auto-approve).
- **Skills system**: SKILL.md two-layer structure + progressive disclosure — drop a directory in and it works; apps can carry skills in their packages.
- **Composition-tree loading**: default layer + `overlay.yaml` field-level overrides; the app-center loading surface — two-state install/mount, two-tier scoping (global / per-app), `/reload --app` per-zone hot reload, and process-domain sandboxing by default for third-party rows.

## Everything Is an App

Loading follows the **app-center model**: an app is an independent installable (npm's three sources are the marketplace — registry names / git / local directories; no proprietary store), and installing alone changes nothing — install puts it in the warehouse, mounting writes the composition row that makes it live. Official pieces mount globally to serve all apps (operator state such as memory grows on one shared base); third-party pieces mount per-app (authorization and blast radius follow the host app).

Writing a Berry app takes a single `index.ts`: a default-exported `apply(ctx, config)`, declarative metadata (inject dependencies, config schema, event vocabulary), and every registration goes through `ctx.effect` — scope rollback un-registers automatically. 35 lifecycle hooks span six layers (session / agent / turn / message / tool pipeline / provider), with the full observation and governance surface open. See the [App Development Guide](docs/应用开发指南.md) (Chinese).

## Security Model

- **Three-stage tool pipeline**: schema validation → gate (approval / sandbox / allowlist decisions) → execute — the only legal path for tool execution, durably ledgered with no bypasses.
- **Three sandbox tiers**: `read-only` / `workspace-write` / `danger-full-access`; third-party apps default to the external process domain (per-row fork + PM middle layer + OS sandbox layer), with indirect subprocesses narrowed by row-level whitelists.
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

**Zero telemetry by default** — this tool sends no network packets: no usage statistics, no crash reports, no version checks (upgrading is entirely your decision). The model calls you configure are the only outbound traffic.

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
