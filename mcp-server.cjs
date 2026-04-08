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
            timeout: options.timeout || 60000
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
        description: "Run multi-dimensional validation on AI-generated content. Returns pass/fail, score (0-100), per-dimension results, and violation details. Requires SOULFIELD_API_KEY. Supports domains: general, finance, marketing, legal.",
        inputSchema: {
            text: z.string().describe("The AI-generated content to validate"),
            domain: z.enum(["general", "finance", "marketing", "legal"]).optional().describe("Domain context for validation (default: general)"),
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

            const result = await apiRequest("POST", "/v1/validate", payload, {
                apiKey: API_KEY,
                timeout: 60000  // LLM calls can take a while
            });

            return jsonResponse(result);
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
