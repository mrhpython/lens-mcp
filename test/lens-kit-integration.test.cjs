"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const enabled = process.env.RUN_LENS_KIT_INTEGRATION === "1";

test("validate_artifact preserves a real lens-kit consistency violation over a passing gate", { skip: !enabled }, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-kit-integration-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, "summary.md"), "Measured total: 12", "utf8");
    await fs.writeFile(path.join(root, "body.md"), "Measured total: 11", "utf8");

    const api = http.createServer((request, response) => {
        request.resume();
        request.on("end", () => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "passing-gate",
                status: "complete",
                tier: "pro",
                passed: true,
                score: 10,
                lenses: {}
            }));
        });
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => api.close(resolve)));

    const repository = path.resolve(__dirname, "..");
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(repository, "mcp-server.cjs")],
        cwd: repository,
        env: {
            SOULFIELD_API_BASE: `http://127.0.0.1:${api.address().port}`,
            SOULFIELD_API_KEY: "test-key",
            LENS_KIT_BIN: process.env.LENS_KIT_BIN || "lens-kit"
        },
        stderr: "pipe"
    });
    const client = new Client({ name: "lens-kit-integration", version: "1.0.0" });
    await client.connect(transport);
    t.after(() => transport.close());

    const response = await client.callTool({
        name: "validate_artifact",
        arguments: {
            artifact_path: "summary.md",
            consistency: {
                numbers: { summary: "summary.md", body: "body.md" }
            },
            cwd: root,
            domain: "agency",
            context: "Deterministic consistency integration test"
        }
    });
    assert.equal(response.isError, undefined);
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.gate.passed, true);
    assert.equal(payload.consistency_checks.numbers.status, "VIOLATION");
    assert.equal(payload.consistency_checks.numbers.exit_code, 6);
    assert.equal(payload.consistency_status, "VIOLATION");
    assert.equal(payload.full_validator_status, "FAIL");
});
