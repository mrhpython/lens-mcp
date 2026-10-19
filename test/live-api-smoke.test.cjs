"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const enabled = process.env.RUN_LIVE_LENS_SMOKE === "1" && Boolean(process.env.SOULFIELD_API_KEY);

test("live local validate_artifact route reaches the configured Lens API", { skip: !enabled }, async (t) => {
    const repository = path.resolve(__dirname, "..");
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(repository, "mcp-server.cjs")],
        cwd: repository,
        env: {
            SOULFIELD_API_BASE: process.env.SOULFIELD_API_BASE || "http://localhost:8002",
            SOULFIELD_API_KEY: process.env.SOULFIELD_API_KEY,
            SOULFIELD_VALIDATE_TIMEOUT_MS: "180000",
            SOULFIELD_VALIDATE_BUDGET_MS: "600000"
        },
        stderr: "pipe"
    });
    const client = new Client({ name: "lens-live-smoke", version: "1.0.0" });
    await client.connect(transport);
    t.after(() => transport.close());

    const response = await client.callTool({
        name: "validate_artifact",
        arguments: {
            artifact_path: "package.json",
            evidence_roots: ["README.md"],
            evidence_queries: [{
                claim: "documented-tool",
                query: "validate_artifact"
            }],
            domain: "agency",
            context: "Internal live MCP transport smoke; validate package metadata only"
        }
    });
    assert.equal(response.isError, undefined);
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.validation_level, "evidence-preflight+gate");
    assert.equal(payload.evidence_preflight.status, "COMPLETE");
    assert.equal(payload.full_validator_status, "PENDING_AGENT_REVIEW");
    assert.equal(payload.gate.status, "complete");
    assert.equal(typeof payload.gate.id, "string");
});
