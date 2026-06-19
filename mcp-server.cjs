#!/usr/bin/env node
/**
 * Soulfield Lens MCP Server
 *
 * Exposes Soulfield Lens validation as MCP tools for Claude Code,
 * Cursor, and other MCP-compatible agents.
 *
 * Tools:
 *   - validate_content: Multi-dimensional validation of AI-generated content
 *   - scrub_pii: PII-only scan using regex (instant, no LLM)
 *   - lens_health: Check if Lens API service is running
 *
 * Wraps HTTP calls to http://localhost:8002/v1/*
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
const server = new McpServer({
    name: "soulfield-lens",
    version: "1.0.0"
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
            "User-Agent": "soulfield-lens-mcp/1.0.0"
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
        description: "Run multi-dimensional validation on AI-generated content. Returns pass/fail, score (0-100), per-dimension results, and violation details. Requires SOULFIELD_API_KEY. Supports domains: general, finance, marketing, legal, seo, agency.",
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
 * PII-only scan using regex — instant, no LLM. Requires API key.
 * Calls POST /v1/scrub.
 */
server.registerTool(
    "scrub_pii",
    {
        title: "Scrub PII",
        description: "Scan text for PII (emails, phone numbers, SSNs, credit cards, etc.) using regex. Returns scrubbed text with PII replaced by type markers, plus a list of findings. Instant — no LLM call. Requires SOULFIELD_API_KEY.",
        inputSchema: {
            text: z.string().describe("The text to scan for PII")
        }
    },
    async ({ text }) => {
        try {
            const result = await apiRequest("POST", "/v1/scrub", { text }, {
                apiKey: API_KEY,
                timeout: 10000  // Regex-only, should be fast
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

// --- Main ---

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Soulfield Lens MCP Server running on stdio (3 tools available)");
    if (!API_KEY) {
        console.error("WARNING: SOULFIELD_API_KEY not set — validate_content will fail");
    }
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
