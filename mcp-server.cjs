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
 * B. Local validator tier — orchestrates local evidence search and optional
 *    `lens-kit` checks. These take LOCAL FILE PATHS and are stdio-only by design.
 *   - validate_artifact: local evidence preflight + deterministic checks + API gate
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
const { validateArtifact } = require("./lib/artifact-validation.cjs");
const { registerValidationJobs } = require("./lib/validation-jobs.cjs");

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
// Receipt capture (self-improving loop plan 2026-11-01, section 5.3): when set,
// every gate result is appended to <dir>/receipts.jsonl (hashes, verdicts and
// short quotes only) and the PII-scrubbed text goes to <dir>/private/docs/,
// which carries its own "*" .gitignore. Unset = no capture, as before.
const RECEIPT_DIR = expandHome(process.env.LENS_RECEIPT_DIR || "");
const RECEIPT_QUOTE_MAX = 300;
// Joins the receipt's free-text fields for one /v1/scrub call. It is longer
// than the scrubber's 20-character [REDACTED] look-around and is cut by blank
// lines, so no PII pattern can match across two fields.
const RECEIPT_FIELD_SEP = "\n\n----lens-receipt-field-boundary----\n\n";

/**
 * Expand a leading "~" or "~/" to the home directory. A path set in .env or
 * .mcp.json inside quotes reaches us with the "~" unexpanded; without this it
 * would become a literal "~" folder under the server's cwd.
 */
function expandHome(p) {
    if (!p) return p;
    const os = require("os");
    const path = require("path");
    if (p === "~") return os.homedir();
    if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
    return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The user's own published details (name, postal address, contact email, phone), one per line, from
 * LENS_PUBLIC_IDENTITY_FILE or ~/.config/soulfield-lens/public-identity.txt ('#' comments, lines under
 * 3 characters skipped). Sent as /v1/scrub's "keep" list so they are not redacted: they belong in the
 * user's outgoing work. Anyone else's details still are. No file: [] (the default for a new user).
 * Read on every call, so an edit applies to the next scrub.
 */
function ownIdentity() {
    const fs = require("fs");
    const file = expandHome(process.env.LENS_PUBLIC_IDENTITY_FILE || "~/.config/soulfield-lens/public-identity.txt");
    try {
        return fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim())
            .filter((l) => l.length >= 3 && !l.startsWith("#"));
    } catch {
        return [];
    }
}

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
            "User-Agent": "soulfield-lens-mcp/1.2.0"
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

registerValidationJobs(server, z, apiRequest, API_KEY, jsonResponse,
    RECEIPT_DIR
        ? (text, domain, context, result) =>
            writeReceipt(RECEIPT_DIR, { text, domain, context, meta: { source: "validation_job" }, result })
        : null);

/**
 * Send exact artifact text through the API gate. Evidence and local file paths
 * are deliberately not accepted here and are never added to the API payload.
 * `meta` ({source, artifact_type}) is local only: it labels the receipt and is
 * never sent to the API.
 */
async function validateText(text, domain, context, meta = {}) {
    const result = await requestValidation(text, domain, context);
    if (RECEIPT_DIR) {
        await writeReceipt(RECEIPT_DIR, { text, domain, context, meta, result });
    }
    return result;
}

async function requestValidation(text, domain, context) {
    if (!API_KEY) {
        const error = new Error(
            "SOULFIELD_API_KEY not set. Set it as an environment variable in your MCP server config."
        );
        error.code = "NO_API_KEY";
        throw error;
    }

    const payload = { text };
    if (domain) payload.domain = domain;
    if (context) payload.context = context;

    if (text.length < ASYNC_MIN_CHARS) {
        return apiRequest("POST", "/v1/validate", payload, {
            apiKey: API_KEY,
            timeout: VALIDATE_TIMEOUT_MS
        });
    }

    let submit;
    try {
        submit = await apiRequest("POST", "/v1/validate", { ...payload, options: { async: true } }, {
            apiKey: API_KEY,
            timeout: VALIDATE_TIMEOUT_MS
        });
    } catch (error) {
        if (error.statusCode === 400 || error.statusCode === 422 || error.statusCode === 404) {
            return apiRequest("POST", "/v1/validate", payload, {
                apiKey: API_KEY,
                timeout: VALIDATE_BUDGET_MS
            });
        }
        throw error;
    }

    if (submit && submit.status === "complete") return submit;
    if (submit && submit.status === "pending" && submit.id) {
        return pollJob(submit.id, VALIDATE_BUDGET_MS);
    }
    return submit;
}

/**
 * Pull the receipt fields out of a gate response: per-lens verdicts and one
 * finding per violation. Quotes are kept whole here so the scrub sees every
 * email or phone number intact; writeReceipt caps them after the scrub.
 */
function receiptFindings(result) {
    const perLens = {};
    const findings = [];
    const lenses = (result && result.lenses) || {};
    for (const [lens, entry] of Object.entries(lenses)) {
        if (!entry || typeof entry !== "object") continue;
        perLens[lens] = {
            passed: entry.passed === undefined ? null : entry.passed,
            status: entry.status || null
        };
        for (const v of entry.violations || []) {
            findings.push({
                lens,
                severity: v.severity || null,
                issue: typeof v.issue === "string" ? v.issue : "",
                quote: typeof v.quote === "string" ? v.quote : "",
                quote_status: v.quote_status || null
            });
        }
    }
    return { perLens, findings };
}

/**
 * Scrub several short strings with one POST /v1/scrub call. Returns the
 * scrubbed strings in order, or null if the call fails or the joined reply
 * does not split back into the same number of fields.
 */
async function scrubFields(fields) {
    if (!fields.some((f) => f)) return fields.slice();
    try {
        const scrub = await apiRequest("POST", "/v1/scrub", { text: fields.join(RECEIPT_FIELD_SEP), keep: ownIdentity() }, {
            apiKey: API_KEY,
            timeout: 10000
        });
        if (typeof scrub.scrubbed_text !== "string") return null;
        const parts = scrub.scrubbed_text.split(RECEIPT_FIELD_SEP);
        return parts.length === fields.length ? parts : null;
    } catch (error) {
        console.error("[receipt] field scrub failed:", error.message || String(error));
        return null;
    }
}

/**
 * Scrub the whole text and save it under <dir>/private/docs/<sha>.txt.
 * Returns { docStatus, piiCount }. If the scrub fails the doc is NOT written,
 * rather than saving unscrubbed text.
 */
async function saveScrubbedDoc(docsDir, sha, text) {
    const fs = require("fs/promises");
    const path = require("path");
    try {
        const scrub = await apiRequest("POST", "/v1/scrub", { text, keep: ownIdentity() }, {
            apiKey: API_KEY,
            timeout: 10000
        });
        if (typeof scrub.scrubbed_text !== "string") {
            throw new Error("scrub response has no scrubbed_text");
        }
        await fs.writeFile(path.join(docsDir, `${sha}.txt`), scrub.scrubbed_text,
            { encoding: "utf8", mode: 0o600 });
        return {
            docStatus: "written",
            piiCount: typeof scrub.pii_count === "number" ? scrub.pii_count : null
        };
    } catch (error) {
        console.error("[receipt] scrub failed; doc not saved:", error.message || String(error));
        return { docStatus: "not_written_scrub_failed", piiCount: null };
    }
}

/**
 * Append one receipt line and save the scrubbed text. Capture must never fail
 * a validation, so every error is logged to stderr and swallowed. The text is
 * scrubbed by the same POST /v1/scrub the scrub_pii tool uses. The free-text
 * fields of the line (context, each issue and quote) are scrubbed too, in one
 * more call that runs at the same time. If that call fails, those fields are
 * written as null and findings_status says so. The scrub finds structured
 * identifiers only (emails, phones, card numbers, keys); names survive it.
 */
async function writeReceipt(dir, { text, domain, context, meta, result }) {
    if (!result || typeof result !== "object" || !result.lenses) return;
    const fs = require("fs/promises");
    const path = require("path");
    const crypto = require("crypto");
    try {
        const sha = crypto.createHash("sha256").update(text, "utf8").digest("hex");
        const privateDir = path.join(dir, "private");
        const docsDir = path.join(privateDir, "docs");
        await fs.mkdir(docsDir, { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(privateDir, ".gitignore"), "*\n", { mode: 0o600 });

        const { perLens, findings } = receiptFindings(result);
        const fields = [context || "", ...findings.flatMap((f) => [f.issue, f.quote])];
        const [doc, scrubbed] = await Promise.all([
            saveScrubbedDoc(docsDir, sha, text),
            scrubFields(fields)
        ]);

        let lineContext = null;
        let findingsStatus = "scrubbed";
        if (scrubbed) {
            lineContext = scrubbed[0] || null;
            findings.forEach((f, i) => {
                f.issue = scrubbed[1 + 2 * i];
                f.quote = scrubbed[2 + 2 * i].slice(0, RECEIPT_QUOTE_MAX);
            });
        } else {
            findingsStatus = "text_dropped_scrub_failed";
            for (const f of findings) {
                f.issue = null;
                f.quote = null;
            }
        }

        const line = {
            date: new Date().toISOString(),
            text_sha256: sha,
            text_length: text.length,
            domain: domain || null,
            context: lineContext,
            source: (meta && meta.source) || "validate_content",
            validation_id: result.id || null,
            passed: result.passed === undefined ? null : result.passed,
            halted: result.halted === undefined ? null : result.halted,
            score: result.score === undefined ? null : result.score,
            tier: result.tier || null,
            per_lens: perLens,
            findings,
            findings_status: findingsStatus,
            doc_status: doc.docStatus,
            pii_count: doc.piiCount
        };
        if (meta && meta.artifact_type) line.artifact_type = meta.artifact_type;
        await fs.appendFile(path.join(dir, "receipts.jsonl"), JSON.stringify(line) + "\n",
            { encoding: "utf8", mode: 0o600 });
    } catch (error) {
        console.error("[receipt] write failed; validation result unaffected:", error.message || String(error));
    }
}

function validationErrorResponse(toolName, error) {
    if (error.code === "NO_API_KEY") {
        return jsonError(toolName, error);
    }
    if (error.statusCode === 401) {
        return jsonError(toolName, new Error(
            "Authentication failed (401). Check that SOULFIELD_API_KEY is valid."
        ));
    }
    if (error.statusCode === 429) {
        return jsonError(toolName, new Error(
            "Rate limited (429). Wait a moment and try again, or upgrade your API tier."
        ));
    }
    return jsonError(toolName, error);
}

function artifactErrorResponse(error) {
    let message = error.message || String(error);
    if (error.statusCode === 401) {
        message = "Authentication failed (401). Check that SOULFIELD_API_KEY is valid.";
    } else if (error.statusCode === 429) {
        message = "Rate limited (429). Wait a moment and try again, or upgrade your API tier.";
    }
    console.error("[validate_artifact] error", error);
    return {
        ...jsonResponse({
            validation_level: "unknown",
            gate_status: "UNKNOWN",
            full_validator_status: "UNKNOWN",
            error: message
        }),
        isError: true
    };
}

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
            context: z.string().optional().describe("Audience/purpose context for Relevance lens (Lens 9). Omit to skip Relevance silently."),
            artifact_type: z.string().optional().describe("Artifact type, e.g. landing-copy, outreach-email. Local only: it labels the saved receipt when LENS_RECEIPT_DIR is set and is never sent to the API.")
        }
    },
    async ({ text, domain, context, artifact_type }) => {
        try {
            return jsonResponse(await validateText(text, domain, context,
                { source: "validate_content", artifact_type }));
        } catch (error) {
            return validationErrorResponse("validate_content", error);
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
            const result = await apiRequest("POST", "/v1/scrub", { text, keep: ownIdentity() }, {
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
 * Default working directory for the three catches tools, so every catch lands
 * in one catches.jsonl (plan section 5.4). LENS_CATCHES_DIR overrides it. If the
 * directory does not exist (an npm or Docker install), fall back to the
 * server's cwd as before. The consistency tools keep the server's cwd: their
 * relative file paths are the caller's, not lens-kit's.
 */
function catchesCwd() {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const dir = expandHome(process.env.LENS_CATCHES_DIR)
        || path.join(os.homedir(), "dev", "tools", "lens-kit");
    try {
        if (fs.statSync(dir).isDirectory()) return dir;
    } catch (_) { /* missing: fall back below */ }
    return process.cwd();
}

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
    "Working directory to run in. Defaults to the server's cwd."
);

const catchesCwdArg = z.string().optional().describe(
    "Working directory to run in. catches.jsonl is read from and written to here. Defaults to ~/dev/tools/lens-kit (or LENS_CATCHES_DIR), so all catches land in one file."
);

function artifactKitOutcome(res) {
    if (res.spawn_error) {
        return { status: "UNKNOWN", exit_code: null, error: res.spawn_error };
    }
    if (res.timed_out) {
        return {
            status: "UNKNOWN",
            exit_code: res.exit_code,
            error: `lens-kit timed out after ${KIT_TIMEOUT_MS}ms`
        };
    }
    if (res.exit_code === 6) {
        return {
            status: "VIOLATION",
            exit_code: 6,
            output: res.stdout,
            stderr: res.stderr || undefined
        };
    }
    if (res.exit_code === 0) {
        return {
            status: "CLEAN",
            exit_code: 0,
            output: res.stdout,
            stderr: res.stderr || undefined
        };
    }
    return {
        status: "UNKNOWN",
        exit_code: res.exit_code,
        error: `lens-kit exited ${res.exit_code}; this is a usage/config error, not a verdict`,
        stderr: res.stderr || undefined
    };
}

async function runArtifactConsistency(specification, cwd) {
    const checks = [];

    if (specification.leaks) {
        const args = ["consistency", "leaks", ...specification.leaks.files];
        if (specification.leaks.profile) args.push("--profile", specification.leaks.profile);
        if (specification.leaks.deny && specification.leaks.deny.length) {
            args.push("--deny", ...specification.leaks.deny);
        }
        checks.push(runKit(args, cwd).then((result) => ["leaks", artifactKitOutcome(result)]));
    }

    if (specification.numbers) {
        const args = [
            "consistency", "numbers",
            specification.numbers.summary,
            specification.numbers.body
        ];
        checks.push(runKit(args, cwd).then((result) => ["numbers", artifactKitOutcome(result)]));
    }

    if (specification.markers) {
        const args = [
            "consistency", "markers",
            specification.markers.source,
            ...specification.markers.rendered
        ];
        if (specification.markers.profile) args.push("--profile", specification.markers.profile);
        if (specification.markers.markers && specification.markers.markers.length) {
            args.push("--markers", ...specification.markers.markers);
        }
        checks.push(runKit(args, cwd).then((result) => ["markers", artifactKitOutcome(result)]));
    }

    return Object.fromEntries(await Promise.all(checks));
}

server.registerTool(
    "validate_artifact",
    {
        title: "Validate Local Artifact",
        description: "Local orchestration entry point: read one artifact, run bounded literal searches across explicitly permitted evidence roots, run requested lens-kit consistency checks, and send ONLY the artifact text to the independent API gate. Literal matches locate candidate evidence but do not prove semantic truth, so this tool returns gate-only, evidence-preflight+gate, FAIL on an authoritative consistency violation, UNKNOWN on incomplete evidence/check errors, or PENDING_AGENT_REVIEW. Only a separate validator agent with host file read/search may issue a full-validator verdict. Local stdio only; never expose this tool through the hosted API.",
        inputSchema: {
            artifact_path: z.string().min(1).describe("Local UTF-8 artifact file to validate"),
            evidence_roots: z.array(z.string().min(1)).max(20).optional().describe("Explicitly permitted local files/directories searched for evidence. Required when evidence_queries are supplied."),
            evidence_queries: z.array(z.object({
                claim: z.string().min(1).describe("Stable claim identifier or short claim label"),
                query: z.string().min(1).max(500).describe("Literal text to locate inside the evidence roots"),
                case_sensitive: z.boolean().optional().describe("Default true; false performs a case-insensitive literal search")
            })).max(50).optional().describe("Bounded literal searches. A match is a source location requiring validator review, not semantic proof."),
            consistency: z.object({
                leaks: z.object({
                    files: z.array(z.string().min(1)).min(1),
                    deny: z.array(z.string()).optional(),
                    profile: z.string().optional()
                }).optional(),
                numbers: z.object({
                    summary: z.string().min(1),
                    body: z.string().min(1)
                }).optional(),
                markers: z.object({
                    source: z.string().min(1),
                    rendered: z.array(z.string().min(1)).min(1),
                    markers: z.array(z.string()).optional(),
                    profile: z.string().optional()
                }).optional()
            }).optional().describe("Optional local deterministic cross-file checks. Exit 6 is an authoritative violation."),
            domain: z.enum(["general", "finance", "marketing", "legal", "seo", "agency"]).optional(),
            context: z.string().optional().describe("Audience/purpose context for Relevance"),
            cwd: cwdArg
        }
    },
    async (input) => {
        try {
            const path = require("path");
            const localBase = input.cwd ? path.resolve(input.cwd) : process.cwd();
            const normalizedInput = {
                ...input,
                artifact_path: path.isAbsolute(input.artifact_path)
                    ? input.artifact_path
                    : path.resolve(localBase, input.artifact_path),
                evidence_roots: (input.evidence_roots || []).map((root) =>
                    path.isAbsolute(root) ? root : path.resolve(localBase, root)
                )
            };
            const result = await validateArtifact(normalizedInput, {
                validateGate: (text, domain, context) =>
                    validateText(text, domain, context, { source: "validate_artifact" }),
                runConsistency: runArtifactConsistency
            });
            return jsonResponse(result);
        } catch (error) {
            return artifactErrorResponse(error);
        }
    }
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
            cwd: catchesCwdArg
        }
    },
    async ({ artifact_type, domain, all, threshold, format, cwd }) => {
        const args = ["catches", "relevant"];
        if (artifact_type) args.push(artifact_type);
        if (all) args.push("--all");
        if (domain) args.push("--domain", domain);
        if (threshold !== undefined) args.push("--threshold", String(threshold));
        if (format) args.push("--format", format);
        return kitResponse("lens_catches_relevant", await runKit(args, cwd || catchesCwd()));
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
            snippet: z.string().optional().describe("The offending text, verbatim (a short fragment). With lenses_failed it makes the catch exportable as a training label."),
            lenses_failed: z.array(z.string()).optional().describe("Canonical lens keys the snippet failed, e.g. [\"truth\", \"causality\"]. lens-kit rejects an unknown key."),
            provenance: z.enum(["michael", "seat", "deterministic", "qwen"]).optional().describe("Who judged the lens label. Rows marked qwen are never exported as training labels."),
            cwd: catchesCwdArg
        }
    },
    async ({ catch: catchText, pattern, rule, artifact_type, domain, self_catch, snippet, lenses_failed, provenance, cwd }) => {
        // The record goes through lens-kit's --from-json path: one JSON file
        // carries every field, so the snippet keeps its exact bytes and newlines
        // and no text passes through argv. The file is private and removed after.
        const record = { catch: catchText, pattern, rule, artifact_type, domain };
        if (self_catch) record.self_catch = true;
        if (snippet) record.snippet = snippet;
        if (lenses_failed && lenses_failed.length) record.lenses_failed = lenses_failed;
        if (provenance) record.provenance = provenance;
        const fs = require("fs/promises");
        const os = require("os");
        const path = require("path");
        let tmpDir;
        try {
            tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-catch-"));
            const jsonPath = path.join(tmpDir, "catch.json");
            await fs.writeFile(jsonPath, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
            const res = await runKit(["catches", "add", "--from-json", jsonPath], cwd || catchesCwd());
            return kitResponse("lens_catches_add", res);
        } catch (error) {
            return jsonError("lens_catches_add", error);
        } finally {
            if (tmpDir) {
                await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
            }
        }
    }
);

server.registerTool(
    "lens_catches_stats",
    {
        title: "Catch Recurrence Stats",
        description: "Per-pattern recurrence counts across the defect bank. Any pattern at or above the threshold gets a PROMOTE-to-deterministic-check suggestion — that is the signal a recurring judgment call should become a cheap fixed check instead. Use this to decide what to harden next.",
        inputSchema: { cwd: catchesCwdArg }
    },
    async ({ cwd }) => kitResponse("lens_catches_stats", await runKit(["catches", "stats"], cwd || catchesCwd()))
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
    console.error("Soulfield Lens MCP Server running on stdio (10 tools available)");
    if (!API_KEY) {
        console.error("WARNING: SOULFIELD_API_KEY not set — validate_content will fail");
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error("Fatal error in main():", error);
        process.exit(1);
    });
}

module.exports = {
    artifactKitOutcome,
    catchesCwd,
    receiptFindings,
    runArtifactConsistency,
    validateText,
    writeReceipt
};
