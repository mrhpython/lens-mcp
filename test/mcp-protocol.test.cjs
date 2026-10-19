"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

test("async job survives an MCP client reconnect without resubmission", async (t) => {
    const id = "12345678-1234-4234-8234-123456789abc";
    let submissions = 0;
    let ready = false;
    const receipt = { id, status: "complete", passed: false, halted: true,
        lenses: { rights: { status: "ran", passed: false } } };
    const api = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            if (req.method === "POST") submissions++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(ready ? receipt : { id, status: "pending" }));
        });
    });
    await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => api.close(resolve)));
    async function connect() {
        const transport = new StdioClientTransport({ command: process.execPath,
            args: [path.resolve(__dirname, "..", "mcp-server.cjs")],
            env: { SOULFIELD_API_BASE: `http://127.0.0.1:${api.address().port}`, SOULFIELD_API_KEY: "fixture-key" }, stderr: "pipe" });
        const client = new Client({ name: "recovery-test", version: "1" });
        await client.connect(transport);
        t.after(() => transport.close());
        return { client, transport };
    }
    const first = await connect();
    const submitted = await first.client.callTool({ name: "validation_submit", arguments: { text: "Frozen candidate" } });
    assert.equal(JSON.parse(submitted.content[0].text).job_id, id);
    await first.transport.close();
    const second = await connect();
    const pending = await second.client.callTool({ name: "validation_receipt", arguments: { job_id: id } });
    assert.equal(JSON.parse(pending.content[0].text).status, "pending");
    ready = true;
    const done = await second.client.callTool({ name: "validation_receipt", arguments: { job_id: id } });
    assert.deepEqual(JSON.parse(done.content[0].text), receipt);
    assert.equal(submissions, 1);
});

test("validate_artifact is exposed over stdio and sends only artifact text to the API", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-mcp-protocol-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const artifactPath = path.join(root, "candidate.md");
    const evidenceDir = path.join(root, "evidence");
    await fs.mkdir(evidenceDir);
    await fs.writeFile(artifactPath, "Candidate sent to Qwen.", "utf8");
    await fs.writeFile(path.join(evidenceDir, "receipt.md"), "LOCAL_ONLY_EVIDENCE", "utf8");

    let apiBody;
    const api = http.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
            apiBody = JSON.parse(body);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "test-gate-id",
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
    const address = api.address();

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve(__dirname, "..", "mcp-server.cjs")],
        cwd: path.resolve(__dirname, ".."),
        env: {
            SOULFIELD_API_BASE: `http://127.0.0.1:${address.port}`,
            SOULFIELD_API_KEY: "test-key",
            SOULFIELD_ASYNC_MIN_CHARS: "999999"
        },
        stderr: "pipe"
    });
    const client = new Client({ name: "lens-mcp-test", version: "1.0.0" });
    await client.connect(transport);
    t.after(() => transport.close());

    const tools = await client.listTools();
    assert.equal(tools.tools.length, 12);
    assert.equal(tools.tools.some((tool) => tool.name === "validate_artifact"), true);
    assert.equal(tools.tools.some((tool) => tool.name === "validation_submit"), true);
    assert.equal(tools.tools.some((tool) => tool.name === "validation_receipt"), true);

    const response = await client.callTool({
        name: "validate_artifact",
        arguments: {
            artifact_path: artifactPath,
            evidence_roots: [evidenceDir],
            evidence_queries: [{ claim: "local-marker", query: "LOCAL_ONLY_EVIDENCE" }],
            domain: "agency",
            context: "Protocol integration test"
        }
    });
    const payload = JSON.parse(response.content[0].text);

    assert.equal(response.isError, undefined);
    assert.equal(payload.validation_level, "evidence-preflight+gate");
    assert.equal(payload.full_validator_status, "PENDING_AGENT_REVIEW");
    assert.deepEqual(apiBody, {
        text: "Candidate sent to Qwen.",
        domain: "agency",
        context: "Protocol integration test"
    });
    assert.equal(JSON.stringify(apiBody).includes("LOCAL_ONLY_EVIDENCE"), false);
    assert.equal(JSON.stringify(apiBody).includes(root), false);

    const invalidResponse = await client.callTool({
        name: "validate_artifact",
        arguments: {
            artifact_path: artifactPath,
            evidence_queries: [{ claim: "missing-scope", query: "anything" }]
        }
    });
    const invalidPayload = JSON.parse(invalidResponse.content[0].text);
    assert.equal(invalidResponse.isError, true);
    assert.equal(invalidPayload.validation_level, "unknown");
    assert.equal(invalidPayload.gate_status, "UNKNOWN");
    assert.equal(invalidPayload.full_validator_status, "UNKNOWN");
});
