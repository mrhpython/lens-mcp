#!/usr/bin/env node
/**
 * Soulfield Lens MCP Server
 *
 * Exposes Soulfield Lens validation as MCP tools for Claude Code,
 * Cursor, and other MCP-compatible agents.
 *
 * Two tiers, on purpose:
 *
 * A. Gate tier — wraps HTTP calls to http://localhost:8002/v1/*
 *   - validate_content: Multi-dimensional validation of AI-generated content
 *   - scrub_pii: PII-only pattern scan (no LLM)
 *   - lens_health: Check if Lens API service is running
 *
 * B. Validator tier — shells out to the local `lens-kit` CLI. These take LOCAL
 *    FILE PATHS and are stdio-only by design (see the boundary note below).
 *   - lens_catches_relevant / lens_catches_add / lens_catches_stats
 *   - lens_consistency_leaks / lens_consistency_numbers / lens_consistency_markers
 *
 * Why both: the gate is substrate-blind by construction — it judges one text and
 * has no tools, which is exactly what makes it an independent check. Tier B is
 * the half that can see the disk: deterministic cross-file checks and the
 * institutional defect memory. Neither replaces the other; the agent supplies
 * substrate evidence, the gate owns the score.
 */

// CRITICAL: Redirect all console.log to stderr BEFORE any imports
// MCP stdio protocol requires stdout to be protocol-only (no logging)
const _origLog = console.log;
console.log = (...args) => console.error('[soulfield-lens]', ...args);

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
// Use Zod v3 compatibility path for MCP SDK compatibility
// See: https://github.com/modelcontextprotocol/typescript-sdk/issues/906
const { z } = require("zod/v3");

const API_BASE = process.env.SOULFIELD_API_BASE || "http://localhost:8002";
const API_KEY = process.env.SOULFIELD_API_KEY || "";
const VALIDATE_TIMEOUT_MS = parseInt(process.env.SOULFIELD_VALIDATE_TIMEOUT_MS || "180000", 10);
// Long-input async submit+poll (2026-06-19): inputs >= ASYNC_MIN_CHARS are
// submitted as a pro-async job and polled to completion, so a single request
// never hits VALIDATE_TIMEOUT_MS (the 180s ceiling). Short inputs keep the
// fast sync path. VALIDATE_BUDGET_MS bounds total wall-clock for the poll loop.
const VALIDATE_BUDGET_MS = parseInt(process.env.SOULFIELD_VALIDATE_BUDGET_MS || "600000", 10);
const POLL_TIMEOUT_MS = parseInt(process.env.SOULFIELD_POLL_TIMEOUT_MS || "30000", 10);
const ASYNC_MIN_CHARS = parseInt(process.env.SOULFIELD_ASYNC_MIN_CHARS || "4000", 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Create MCP Server
// Version is read from package.json rather than hardcoded: it had drifted to
// 1.1.0 while the package shipped 1.1.1, so introspection reported a version
// that did not exist. package.json is in both the npm tarball and the image.
let PKG_VERSION = "0.0.0";
try {
    PKG_VERSION = require("./package.json").version || PKG_VERSION;
} catch (_) { /* keep the fallback; never fail startup over a version string */ }

const server = new McpServer({
    name: "soulfield-lens",
    version: PKG_VERSION
});

// --- Helpers ---

function jsonResponse(payload) {
    const text = JSON.stringify(payload, null, 2);
    return { content: [{ type: "text", text }] };
}

function jsonError(toolName, error) {
    console.error(`[${toolName}] error`, error);
    return {
        ...jsonResponse({ error: error.message || String(error) }),
        isError: true
    };
}

/**
 * Make an HTTP request to the Lens API.
 * Uses native Node.js http/https — no external deps needed.
 */
function apiRequest(method, path, body, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, API_BASE);
        const isHttps = url.protocol === "https:";
        const http = require(isHttps ? "https" : "http");

        const headers = {
            "Accept": "application/json",
            "User-Agent": "soulfield-lens-mcp/1.1.0"
        };

        if (body) {
            headers["Content-Type"] = "application/json";
        }

        if (options.apiKey) {
            headers["X-API-Key"] = options.apiKey;
        }

        const reqOptions = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: method,
            headers: headers,
            timeout: options.timeout || VALIDATE_TIMEOUT_MS
        };

        const req = http.request(reqOptions, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => {
                try {
                    const parsed = JSON.parse(data);
                    if (res.statusCode >= 400) {
                        const err = new Error(parsed.detail || parsed.error || `HTTP ${res.statusCode}`);
                        err.statusCode = res.statusCode;
                        err.body = parsed;
                        reject(err);
                    } else {
                        resolve(parsed);
                    }
                } catch (e) {
                    if (res.statusCode >= 400) {
                        const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
                        err.statusCode = res.statusCode;
                        reject(err);
                    } else {
                        reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
                    }
                }
            });
        });

        req.on("error", (err) => reject(err));
        req.on("timeout", () => {
            req.destroy();
            reject(new Error(`Request to ${path} timed out after ${reqOptions.timeout}ms`));
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

/**
 * Poll a pro/premium async validation job to completion.
 * Returns the completed ValidateResponse, or throws on failed/expired/budget.
 * Each GET is short (POLL_TIMEOUT_MS); the loop is bounded by budgetMs total.
 */
async function pollJob(jobId, budgetMs) {
    const start = Date.now();
    let delay = 2000;
    while (Date.now() - start < budgetMs) {
        await sleep(delay);
        let job;
        try {
            job = await apiRequest("GET", `/v1/validate/${jobId}`, null, {
                apiKey: API_KEY,
                timeout: POLL_TIMEOUT_MS
            });
        } catch (e) {
            // 404 = job evicted/expired → terminal; otherwise transient (slow
            // poll, 5xx) → keep trying within the budget.
            if (e.statusCode === 404) {
                throw new Error(`Validation job ${jobId} not found (expired)`);
            }
            delay = Math.min(delay * 1.5, 15000);
            continue;
        }
        if (job.status === "complete") return job;
        if (job.status === "failed") {
            throw new Error(`Validation job ${jobId} failed${job.error ? ": " + job.error : ""}`);
        }
        delay = Math.min(delay * 1.5, 15000);  // pending → backoff
    }
    throw new Error(`Validation exceeded total budget of ${budgetMs}ms (job ${jobId})`);
}

// --- Tools ---

/**
 * Tool: validate_content
 * Multi-dimensional validation of AI-generated content.
 * Calls POST /v1/validate with API key auth.
 */
server.registerTool(
    "validate_content",
    {
        title: "Validate Content",
        description: "Run the 10-lens validation gate on AI-generated content. Returns pass/fail, per-lens results, violation details, and a deterministic 0-10 score derived from violation counts (10 = clean, floors at 0; computed by the API tier layer, not by the LLM — the LLM-emitted 0-100 score was removed 2026-07-30). Requires SOULFIELD_API_KEY. Supports domains: general, finance, marketing, legal, seo, agency. WIRE CONTRACT (since 2026-08-10): each lens carries status (ran|skipped|error) and passed is null whenever no verdict was produced — parse passed===false as the violation signal, never !passed. HALT SEMANTICS: Rights runs first and halts the run on a critical violation; in a halted response downstream judged lenses read passed:null/status:skipped (unknown, not clean — consciousScan is non-blocking and keeps passed:true, its status:skipped is the never-ran signal).",
        inputSchema: {
            text: z.string().describe("The AI-generated content to validate"),
            domain: z.enum(["general", "finance", "marketing", "legal", "seo", "agency"]).optional().describe("Domain context for validation (default: general)"),
            context: z.string().optional().describe("Audience/purpose context for Relevance lens (Lens 9). Omit to skip Relevance silently.")
        }
    },
    async ({ text, domain, context }) => {
        try {
            if (!API_KEY) {
                return jsonError("validate_content", new Error(
                    "SOULFIELD_API_KEY not set. Set it as an environment variable in your MCP server config."
                ));
            }

            const payload = { text };
            if (domain) payload.domain = domain;
            if (context) payload.context = context;

            // Short inputs: fast single sync request (unchanged behavior).
            if (text.length < ASYNC_MIN_CHARS) {
                const result = await apiRequest("POST", "/v1/validate", payload, {
                    apiKey: API_KEY,
                    timeout: VALIDATE_TIMEOUT_MS
                });
                return jsonResponse(result);
            }

            // Long inputs: submit a pro-async job + poll to completion so a
            // single request never hits VALIDATE_TIMEOUT_MS (the 180s ceiling).
            let submit;
            try {
                submit = await apiRequest("POST", "/v1/validate", { ...payload, options: { async: true } }, {
                    apiKey: API_KEY,
                    timeout: VALIDATE_TIMEOUT_MS
                });
            } catch (e) {
                // Older server without the async flag (400/422/404) → one sync
                // attempt with the full budget as the per-request timeout.
                if (e.statusCode === 400 || e.statusCode === 422 || e.statusCode === 404) {
                    const result = await apiRequest("POST", "/v1/validate", payload, {
                        apiKey: API_KEY,
                        timeout: VALIDATE_BUDGET_MS
                    });
                    return jsonResponse(result);
                }
                throw e;  // 401 / 429 / other → outer catch
            }

            // Old server may ignore the flag and return a sync result.
            if (submit && submit.status === "complete") {
                return jsonResponse(submit);
            }
            if (submit && submit.status === "pending" && submit.id) {
                const result = await pollJob(submit.id, VALIDATE_BUDGET_MS);
                return jsonResponse(result);
            }
            // Unexpected shape — surface it rather than silently pass.
            return jsonResponse(submit);
        } catch (error) {
            // Provide actionable error messages for common failures
            if (error.statusCode === 401) {
                return jsonError("validate_content", new Error(
                    "Authentication failed (401). Check that SOULFIELD_API_KEY is valid."
                ));
            }
            if (error.statusCode === 429) {
                return jsonError("validate_content", new Error(
                    "Rate limited (429). Wait a moment and try again, or upgrade your API tier."
                ));
            }
            return jsonError("validate_content", error);
        }
    }
);

/**
 * Tool: scrub_pii
 * Server-side pattern scan for structured PII/secrets — no LLM. Requires API key.
 * This wrapper forwards the text to the hosted API's POST /v1/scrub; the
 * pattern matching runs there, not in this package.
 */
server.registerTool(
    "scrub_pii",
    {
        title: "Scrub PII",
        description: "Scan text for structured PII and secrets (emails, UK/US phone numbers, credit-card numbers, US SSNs, UK NI/UTR numbers, database connection strings, and common API-key/credential patterns) via the hosted Lens API. Returns scrubbed text with each match replaced by a generic [REDACTED] marker (the finding TYPE — email, phone_uk, ni_number, etc. — appears only in the findings list, not in the replacement), plus that findings list. It scrubs structured identifiers only: personal NAMES survive, so scrubbed output is not anonymized. Pattern-based server-side scan, no LLM call. Targets structured identifiers — it does not detect personal names or free-form PII, and coverage of structured formats is best-effort, not exhaustive. Requires SOULFIELD_API_KEY.",
        inputSchema: {
            text: z.string().describe("The text to scan for PII")
        }
    },
    async ({ text }) => {
        try {
            const result = await apiRequest("POST", "/v1/scrub", { text }, {
                apiKey: API_KEY,
                timeout: 10000  // Pattern scan server-side, no LLM — should be fast
            });

            return jsonResponse(result);
        } catch (error) {
            return jsonError("scrub_pii", error);
        }
    }
);

/**
 * Tool: lens_health
 * Check if the Lens API service is running.
 * Calls GET /v1/health — no auth needed.
 */
server.registerTool(
    "lens_health",
    {
        title: "Lens API Health Check",
        description: "Check if the Soulfield Lens API service is running and responsive. Returns status and version. No auth required.",
        inputSchema: {}
    },
    async () => {
        try {
            const result = await apiRequest("GET", "/v1/health", null, {
                timeout: 5000
            });

            return jsonResponse(result);
        } catch (error) {
            return jsonError("lens_health", new Error(
                `Lens API unreachable at ${API_BASE}: ${error.message}. Is the service running?`
            ));
        }
    }
);

// --- Kit CLI tools (local-only by design) ---
//
// The six tools below shell out to the installed `lens-kit` CLI instead of the
// hosted API, because they take LOCAL FILE PATHS. That is deliberate and it is a
// hard boundary: `consistency leaks|markers|numbers` read arbitrary paths off the
// caller's disk, so exposing them over a hosted HTTP endpoint would be a
// file-disclosure vector, not a feature. On a stdio server the paths are the
// caller's own machine, so the capability is safe here and ONLY here. Do not
// port these to lens-api or to lens-kit/serve.
//
// They exist because the gate is substrate-blind by construction (no tools, no
// file access — that is what keeps it an independent check). The cross-file
// defects it cannot see (a summary number the body never states, a marker
// dropped between formats, a leaked deny term) are caught here, deterministically
// and with no LLM call. Together they are the validator-agent tier; see
// docs/VALIDATOR-AGENT.md in lens-kit.

const KIT_BIN = process.env.LENS_KIT_BIN || "lens-kit";
const KIT_TIMEOUT_MS = parseInt(process.env.LENS_KIT_TIMEOUT_MS || "120000", 10);

/**
 * Run the lens-kit CLI. Uses spawn with an ARGV ARRAY and no shell, so file
 * paths and deny terms cannot be command-injected.
 *
 * Exit codes are load-bearing and are surfaced verbatim: 0 = clean,
 * 6 = consistency violation (a violation no score overrides), 2 = usage/config
 * error, 127 = CLI not installed. Anything non-zero that is not 6 is an ERROR,
 * never a pass — the caller must fail closed.
 */
function runKit(args, cwd) {
    return new Promise((resolve) => {
        const { spawn } = require("child_process");
        let child;
        try {
            child = spawn(KIT_BIN, args, {
                cwd: cwd || process.cwd(),
                shell: false,
                stdio: ["ignore", "pipe", "pipe"]
            });
        } catch (e) {
            return resolve({ spawn_error: e.message, exit_code: null });
        }
        let stdout = "", stderr = "", timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, KIT_TIMEOUT_MS);
        child.stdout.on("data", (d) => { stdout += d; });
        child.stderr.on("data", (d) => { stderr += d; });
        child.on("error", (e) => {
            clearTimeout(timer);
            resolve({ spawn_error: e.message, exit_code: null });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({
                exit_code: code,
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                timed_out: timedOut
            });
        });
    });
}

/**
 * Normalize a runKit result into an MCP response with an explicit verdict.
 * Fails CLOSED: a missing CLI, a timeout or an unexpected exit code is an
 * error, never a silent pass.
 */
function kitResponse(toolName, res, { violationCode = null } = {}) {
    if (res.spawn_error) {
        const hint = /ENOENT/.test(res.spawn_error)
            ? `lens-kit not found (tried "${KIT_BIN}"). Install it (pip install lens_kit) or set LENS_KIT_BIN to its path. Verdict is UNKNOWN — do not treat this as a pass.`
            : `${res.spawn_error} — verdict is UNKNOWN, do not treat this as a pass.`;
        return jsonError(toolName, new Error(hint));
    }
    if (res.timed_out) {
        return jsonError(toolName, new Error(
            `lens-kit timed out after ${KIT_TIMEOUT_MS}ms. Verdict is UNKNOWN — do not treat this as a pass.`
        ));
    }
    if (violationCode !== null && res.exit_code === violationCode) {
        return jsonResponse({
            verdict: "VIOLATION",
            exit_code: res.exit_code,
            note: "A consistency violation is authoritative — no gate score overrides it.",
            output: res.stdout,
            stderr: res.stderr || undefined
        });
    }
    if (res.exit_code === 0) {
        return jsonResponse({
            verdict: violationCode !== null ? "CLEAN" : "OK",
            exit_code: 0,
            output: res.stdout,
            stderr: res.stderr || undefined
        });
    }
    return jsonError(toolName, new Error(
        `lens-kit exited ${res.exit_code} (usage/config error, not a verdict). Verdict is UNKNOWN. stderr: ${res.stderr || "(none)"}`
    ));
}

const cwdArg = z.string().optional().describe(
    "Working directory to run in. catches.jsonl is read from and written to here. Defaults to the server's cwd."
);

server.registerTool(
    "lens_catches_relevant",
    {
        title: "Prior Catches (institutional defect memory)",
        description: "Read the defect bank BEFORE validating: prior named defects for an artifact type, most-recurrent patterns first. This is the institutional memory that makes the gate improve over time — the recurring traps tell you where this class of artifact has failed before. Any pattern at threshold is marked [PROMOTE], meaning it recurs often enough to deserve a deterministic check. Runs the local lens-kit CLI, no LLM call. Omit artifact_type and pass all=true when the type has no history yet.",
        inputSchema: {
            artifact_type: z.string().optional().describe("Artifact type to filter by, e.g. landing-copy, research-brief, content-pack"),
            domain: z.string().optional().describe("Also filter by domain, e.g. marketing, finance, agency"),
            all: z.boolean().optional().describe("Surface every catch regardless of artifact type"),
            threshold: z.number().int().optional().describe("Recurrence threshold for [PROMOTE] lines (default 3)"),
            format: z.enum(["block", "json"]).optional().describe("block = paste-ready surface (default); json = raw records"),
            cwd: cwdArg
        }
    },
    async ({ artifact_type, domain, all, threshold, format, cwd }) => {
        const args = ["catches", "relevant"];
        if (artifact_type) args.push(artifact_type);
        if (all) args.push("--all");
        if (domain) args.push("--domain", domain);
        if (threshold !== undefined) args.push("--threshold", String(threshold));
        if (format) args.push("--format", format);
        return kitResponse("lens_catches_relevant", await runKit(args, cwd));
    }
);

server.registerTool(
    "lens_catches_add",
    {
        title: "Record a Catch (append to defect memory)",
        description: "Append a NAMED DEFECT to the defect bank so it is caught next time. Record what was WRONG, the general pattern it is an instance of, and the forward rule that prevents it — doctrine REJECTS routine passes, so only log actual defects. Set self_catch=true when the defect was a failure of your own validation discipline. This is the write half of the improvement loop: enough recurrences of a pattern promote it to a deterministic check.",
        inputSchema: {
            catch: z.string().describe("What was WRONG (the specific defect found)"),
            pattern: z.string().describe("The general trap this is an instance of"),
            rule: z.string().describe("The forward rule that prevents this next time"),
            artifact_type: z.string().describe("Artifact type, e.g. landing-copy, research-brief"),
            domain: z.string().describe("Domain, e.g. marketing, finance, agency"),
            self_catch: z.boolean().optional().describe("True if this was a failure of the validator's own discipline"),
            cwd: cwdArg
        }
    },
    async ({ catch: catchText, pattern, rule, artifact_type, domain, self_catch, cwd }) => {
        const args = ["catches", "add",
            "--catch", catchText,
            "--pattern", pattern,
            "--rule", rule,
            "--artifact-type", artifact_type,
            "--domain", domain];
        if (self_catch) args.push("--self-catch");
        return kitResponse("lens_catches_add", await runKit(args, cwd));
    }
);

server.registerTool(
    "lens_catches_stats",
    {
        title: "Catch Recurrence Stats",
        description: "Per-pattern recurrence counts across the defect bank. Any pattern at or above the threshold gets a PROMOTE-to-deterministic-check suggestion — that is the signal a recurring judgment call should become a cheap fixed check instead. Use this to decide what to harden next.",
        inputSchema: { cwd: cwdArg }
    },
    async ({ cwd }) => kitResponse("lens_catches_stats", await runKit(["catches", "stats"], cwd))
);

server.registerTool(
    "lens_consistency_leaks",
    {
        title: "Forbidden-String Leak Scan",
        description: "Scan customer-facing files for deny-list terms (CASE-INSENSITIVE literal match — note lens_consistency_markers is case-SENSITIVE, they differ). Deterministic, no LLM. Exit 6 on a hit. Run this on EVERY customer-facing file before any irreversible publish: it is the check that catches a real client name, an internal codename or a banned absolute surviving into shipped copy. A credential scanner will not find these, because nothing here is a credential. IMPORTANT — a hit proves the STRING IS PRESENT, which is authoritative; it does not by itself prove a violation, because the match is NEGATION-BLIND: a banned phrase quoted in order to disclaim it ('we will not give you a guaranteed accuracy number') looks identical to the same phrase asserted. Adjudicate before acting. Deny terms should therefore be strings that are wrong in EVERY context (a real client name, an internal codename), not claims-you-do-not-make — those belong in a lens prompt.",
        inputSchema: {
            files: z.array(z.string()).min(1).describe("Local file path(s) to scan"),
            deny: z.array(z.string()).optional().describe("Extra deny terms, added to the profile's consistency.deny"),
            profile: z.string().optional().describe("Profile YAML providing consistency.deny"),
            cwd: cwdArg
        }
    },
    async ({ files, deny, profile, cwd }) => {
        const args = ["consistency", "leaks", ...files];
        if (profile) args.push("--profile", profile);
        if (deny && deny.length) args.push("--deny", ...deny);
        return kitResponse("lens_consistency_leaks", await runKit(args, cwd), { violationCode: 6 });
    }
);

server.registerTool(
    "lens_consistency_numbers",
    {
        title: "Number Parity (summary vs body)",
        description: "Check that every numeric literal in a summary actually appears in the body it summarizes. Deterministic, no LLM, exit 6 on a violation. Catches the invented figure — the number a summary asserts that its source never stated. TRIPWIRE, not an oracle: literal matching only, no semantic or derived arithmetic, so a legitimately computed total will flag. Review a hit, do not auto-trust it.",
        inputSchema: {
            summary: z.string().describe("The summary file (its numbers must appear in the body)"),
            body: z.string().describe("The body file the summary summarizes"),
            cwd: cwdArg
        }
    },
    async ({ summary, body, cwd }) =>
        kitResponse("lens_consistency_numbers", await runKit(["consistency", "numbers", summary, body], cwd), { violationCode: 6 })
);

server.registerTool(
    "lens_consistency_markers",
    {
        title: "Marker Parity (source vs rendered)",
        description: "Check that evidence markers counted in a source artifact survive into every rendered output. Deterministic, no LLM, exit 6 on a violation. Catches the caveat, citation or hedge that gets dropped between formats — the source says 'as-of 2026-04' and the rendered deck quietly does not. Matching is CASE-SENSITIVE (unlike lens_consistency_leaks, which is case-insensitive), so pick markers whose casing is stable across source and render: 'TRIPWIRE' in the source will NOT match 'Tripwire' in the render and will read as dropped when nothing was. TRIPWIRE: a deliberate subset render also under-counts legitimately. Before treating a hit as a removed caveat, grep the rendered file case-insensitively.",
        inputSchema: {
            source: z.string().describe("The source artifact (authoritative marker counts)"),
            rendered: z.array(z.string()).min(1).describe("Rendered output file(s) to check against the source"),
            markers: z.array(z.string()).optional().describe("Explicit marker strings (otherwise taken from the profile)"),
            profile: z.string().optional().describe("Profile YAML providing the marker set"),
            cwd: cwdArg
        }
    },
    async ({ source, rendered, markers, profile, cwd }) => {
        const args = ["consistency", "markers", source, ...rendered];
        if (profile) args.push("--profile", profile);
        if (markers && markers.length) args.push("--markers", ...markers);
        return kitResponse("lens_consistency_markers", await runKit(args, cwd), { violationCode: 6 });
    }
);

// --- Main ---

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Soulfield Lens MCP Server running on stdio (9 tools available)");
    if (!API_KEY) {
        console.error("WARNING: SOULFIELD_API_KEY not set — validate_content will fail");
    }
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
