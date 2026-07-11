# Soulfield Lens — MCP server

**Outside-in validation for AI-generated text, as an MCP tool.**

Every AI tool asks the same model that wrote the answer whether it's any good. It says yes. The Soulfield Lens is outside-in: a **separate model** runs a **fixed gate** over your output. It checks text — it doesn't write it. This package puts that gate inside Claude Code, Cursor, and any other MCP-compatible agent, so output can be validated on the path where it's generated.

The gate is **fail-closed**: a borderline case returns UNKNOWN, never a silent pass. There is no generation step, so it can't fabricate claims of its own — only check. It can still be wrong about a judgment; that is exactly why borderline cases return UNKNOWN instead of a confident yes.

This is a thin stdio wrapper around the hosted Lens API (`api.soulfield.one`). No local model, no build step — one file, two dependencies.

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

| Tool | What it does | Auth |
|---|---|---|
| `validate_content` | Runs the outside-in gate over text. Returns pass/fail, score, per-dimension results, and violation details with reasoning. Optional `domain` (general, finance, marketing, legal, seo, agency) and `context` (audience/purpose). | key |
| `scrub_pii` | Server-side scan for structured PII and secrets — emails, UK/US phone numbers, credit-card numbers, US SSNs, UK NI/UTR numbers, database connection strings, and common API-key/credential patterns. Returns scrubbed text (each match replaced by a type marker) plus findings. Pattern-based, no LLM call. Targets structured identifiers — it does not detect personal names or free-form PII, and structured-format coverage is best-effort, not exhaustive. | key |
| `lens_health` | Checks the Lens API is up. Returns status and version. | none |

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

## The rest of the product

This wrapper is one of several surfaces on the same engine:

- **Free one-output audit** — [api.soulfield.one/audit](https://api.soulfield.one/audit). The audit is the demo.
- **Wire it in** (SDK stop-hook and middleware) — [api.soulfield.one/developers](https://api.soulfield.one/developers).
- **Own it** — the kit: lenses, compiler, self-improve loop, validator agent, Apache-2.0. Train it on your own data. Start at [api.soulfield.one](https://api.soulfield.one/).

We hold our own marketing copy to the same gate this package exposes.

## License

MIT — see [LICENSE](LICENSE). (The lens-kit product is licensed separately under Apache-2.0.)
