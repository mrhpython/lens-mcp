# Soulfield Lens — MCP server

**Outside-in validation for AI-generated text, as an MCP tool.**

Every AI tool asks the same model that wrote the answer whether it's any good. It says yes. The Soulfield Lens is outside-in: a **separate model** runs a **fixed gate** over your output. It checks text — it doesn't write it. This package puts that gate inside Claude Code, Cursor, and any other MCP-compatible agent, so output can be validated on the path where it's generated.

The gate is **fail-closed**: a borderline case returns UNKNOWN, never a silent pass. There is no generation step, so it can't fabricate claims of its own — only check. It can still be wrong about a judgment; that is exactly why borderline cases return UNKNOWN instead of a confident yes.

This is a thin stdio wrapper around the hosted Lens API (`api.soulfield.one`). No local model, no build step — one file, two dependencies.

It exposes **two tiers**. The **gate tier** (3 tools) needs nothing but an API key. The **validator tier** (6 tools) is optional and only activates if you also have the `lens-kit` CLI installed locally — it runs deterministic cross-file checks and the defect memory that the single-document gate cannot see. Skip it and the gate tier works exactly as before.

## Try it before you install anything

The keyless demo endpoint runs the same gate — a few runs a day per IP, no signup:

```bash
curl -s https://api.soulfield.one/v1/demo \
  -H 'content-type: application/json' \
  -d '{"text": "<paste the AI output you are about to ship>"}'
```

## Install

```bash
npm install -g @soulfield/lens-mcp
```

Or run without installing: `npx @soulfield/lens-mcp`.

### Claude Code

```bash
claude mcp add soulfield-lens \
  -e SOULFIELD_API_BASE=https://api.soulfield.one \
  -e SOULFIELD_API_KEY=<your-key> \
  -- npx @soulfield/lens-mcp
```

### Any MCP client (JSON config)

```json
{
  "mcpServers": {
    "soulfield-lens": {
      "command": "npx",
      "args": ["@soulfield/lens-mcp"],
      "env": {
        "SOULFIELD_API_BASE": "https://api.soulfield.one",
        "SOULFIELD_API_KEY": "<your-key>"
      }
    }
  }
}
```

Production calls need an API key — request one at [hello@soulfield.one](mailto:hello@soulfield.one?subject=API%20key%20request). `lens_health` works without one.

## Tools

### Gate tier — hosted API, works out of the box

| Tool | What it does | Auth |
|---|---|---|
| `validate_content` | Runs the outside-in gate over text. Returns pass/fail, score, per-dimension results, and violation details with reasoning. Optional `domain` (general, finance, marketing, legal, seo, agency) and `context` (audience/purpose). | key |
| `scrub_pii` | Server-side scan for structured PII and secrets — emails, UK/US phone numbers, credit-card numbers, US SSNs, UK NI/UTR numbers, database connection strings, and common API-key/credential patterns. Returns scrubbed text (each match replaced by a type marker) plus findings. Pattern-based, no LLM call. Targets structured identifiers — it does not detect personal names or free-form PII, and structured-format coverage is best-effort, not exhaustive. | key |
| `lens_health` | Checks the Lens API is up. Returns status and version. | none |

### Validator tier — optional, requires the `lens-kit` CLI locally

> **Version note:** the validator tier lands in **1.1.0**. If `npm view @soulfield/lens-mcp version` still reports `1.0.0`, the registry has not caught up with this repo yet and `npx @soulfield/lens-mcp` will give you the three gate-tier tools only. Install from source in the meantime.

**Prerequisite:** `pip install lens_kit` (Apache-2.0, [github.com/mrhpython/lens-kit](https://github.com/mrhpython/lens-kit)), or set `LENS_KIT_BIN` to its path. Without it these six tools return **UNKNOWN with an error** — never a silent pass. No API key needed: they run locally and make no LLM call.

**Why they run locally and not on the hosted API:** they take file paths off your disk. A hosted endpoint that accepted arbitrary local paths would be a file-disclosure vector, not a feature. On stdio the paths are your own machine, so the capability is safe here and only here — and for that reason it will not be added to the hosted API.

| Tool | What it does | Exit semantics |
|---|---|---|
| `lens_consistency_leaks` | Scans files for deny-list terms (case-insensitive literal). Run on every customer-facing file before an irreversible publish: catches a real client name, an internal codename or a banned absolute surviving into shipped copy. A credential scanner will not find these, because nothing here is a credential. | **violation is authoritative** — no gate score overrides it |
| `lens_consistency_numbers` | Checks every numeric literal in a summary actually appears in the body it summarizes. Catches the invented figure. **Tripwire:** literal matching only, no derived arithmetic — a legitimately computed total will flag. Review, don't auto-trust. | violation / clean |
| `lens_consistency_markers` | Checks evidence markers in a source survive into every rendered output — the caveat or citation dropped between formats. **Tripwire:** a deliberate subset render under-counts legitimately. | violation / clean |
| `lens_catches_relevant` | Reads the defect bank before you validate: prior named defects for an artifact type, most-recurrent first. Patterns at threshold are marked `[PROMOTE]` — they recur often enough to deserve a fixed check. | — |
| `lens_catches_add` | Records a named defect so it is caught next time: what was wrong, the general pattern, the forward rule. Routine passes are rejected by design — only real defects. | — |
| `lens_catches_stats` | Per-pattern recurrence counts with promote suggestions. Tells you what to harden next. | — |

The two tiers are complementary, not alternatives. The gate has no tools and no file access — that is precisely what makes it an independent check, and it is also why it cannot see a contradiction spread across two files. The validator tier sees the disk; the gate owns the score. Pair them: gather substrate evidence with the local tools, hand the text to the gate, and never argue a gate FAIL into a PASS. Full protocol: [`docs/VALIDATOR-AGENT.md`](https://github.com/mrhpython/lens-kit/blob/main/docs/VALIDATOR-AGENT.md).

**What you get per run:** receipts — what was checked, what passed, what was held, and why. Machine-readable, not a badge. We won't hand you a guaranteed accuracy number for your data: scores don't transfer across models, datasets, and runtimes, and a tool that promises a fixed figure on data it has never seen is making the exact claim this gate exists to catch.

## Long inputs

Inputs of ~4,000 characters and up are submitted as an async job and polled to completion automatically, so a single long validation never dies on a request timeout. Short inputs use the fast synchronous path. No configuration needed.

## Configuration (env vars)

| Variable | Default | Purpose |
|---|---|---|
| `SOULFIELD_API_BASE` | `http://localhost:8002` | Lens API base URL. Use `https://api.soulfield.one` for the hosted service, or your own deployment. |
| `SOULFIELD_API_KEY` | — | Required for `validate_content` and `scrub_pii`. |
| `SOULFIELD_VALIDATE_TIMEOUT_MS` | `180000` | Per-request timeout for the sync path. |
| `SOULFIELD_VALIDATE_BUDGET_MS` | `600000` | Total wall-clock budget for the async poll loop. |
| `SOULFIELD_ASYNC_MIN_CHARS` | `4000` | Input length at which the async path kicks in. |
| `LENS_KIT_BIN` | `lens-kit` | Path to the `lens-kit` CLI for the validator tier. Only needed if it is not on `PATH`. |
| `LENS_KIT_TIMEOUT_MS` | `120000` | Timeout for a validator-tier command. On timeout the verdict is UNKNOWN, never a pass. |

## The rest of the product

This wrapper is one of several surfaces on the same engine:

- **Free one-output audit** — [api.soulfield.one/audit](https://api.soulfield.one/audit). The audit is the demo.
- **Wire it in** (SDK stop-hook and middleware) — [api.soulfield.one/developers](https://api.soulfield.one/developers).
- **Own it** — the kit: lenses, compiler, self-improve loop, validator agent, Apache-2.0. Train it on your own data. Public repo: [github.com/mrhpython/lens-kit](https://github.com/mrhpython/lens-kit) — clone it, `pip install -e ".[dev]"`, and the test suite runs offline with no key. Installing it is also what activates the validator tier above.

We hold our own marketing copy to the same gate this package exposes.

## License

MIT — see [LICENSE](LICENSE). (The lens-kit product is licensed separately under Apache-2.0.)
