"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const SERVER = path.resolve(__dirname, "..", "mcp-server.cjs");

const GATE_RESULT = {
    id: "receipt-fixture",
    status: "complete",
    tier: "pro",
    passed: false,
    halted: false,
    score: 7.5,
    lenses: {
        truth: {
            passed: false,
            status: "ran",
            violations: [{
                severity: "warning",
                issue: "Uncited statistic",
                quote: "47% of teams",
                quote_found: true,
                quote_status: "exact"
            }]
        },
        rights: { passed: true, status: "ran", violations: [] },
        consciousScan: { passed: true, status: "ran", flags: [] }
    }
};

// A fake Lens API: /v1/validate returns GATE_RESULT, /v1/scrub replaces the
// email address, or fails with 500 when scrubFails is set.
// `gate` replaces GATE_RESULT; `route(request, body)` may answer any other path.
async function fakeApi(t, { scrubFails = false, gate = GATE_RESULT, route = null } = {}) {
    const calls = [];
    const api = http.createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
            calls.push({ path: request.url, body: body ? JSON.parse(body) : null });
            if (request.url === "/v1/scrub") {
                if (scrubFails) {
                    response.writeHead(500, { "content-type": "application/json" });
                    response.end(JSON.stringify({ detail: "scrub down" }));
                    return;
                }
                const text = JSON.parse(body).text;
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({
                    scrubbed_text: text.replace(/\S+@\S+/g, "[REDACTED]"),
                    pii_found: [],
                    pii_count: 1
                }));
                return;
            }
            const routed = route ? route(request, body ? JSON.parse(body) : null) : null;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(routed || gate));
        });
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => api.close(resolve)));
    return { base: `http://127.0.0.1:${api.address().port}`, calls };
}

async function connect(t, env) {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        // No real identity file in tests unless a test names one.
        env: { PATH: process.env.PATH, HOME: process.env.HOME,
               LENS_PUBLIC_IDENTITY_FILE: "/nonexistent/lens-test-identity.txt", ...env },
        stderr: "pipe"
    });
    const client = new Client({ name: "receipts-test", version: "1" });
    await client.connect(transport);
    t.after(() => transport.close());
    return client;
}

async function tmpDir(t, prefix) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
}

const TEXT = "47% of teams ship faster. Contact jo@example.com for details.";
const SHA = crypto.createHash("sha256").update(TEXT, "utf8").digest("hex");

test("validate_content writes one receipt line and a scrubbed private doc", async (t) => {
    const api = await fakeApi(t);
    const dir = await tmpDir(t, "lens-receipts-");
    const client = await connect(t, {
        SOULFIELD_API_BASE: api.base,
        SOULFIELD_API_KEY: "fixture-key",
        LENS_RECEIPT_DIR: dir
    });

    const response = await client.callTool({
        name: "validate_content",
        arguments: { text: TEXT, domain: "agency", context: "Landing page", artifact_type: "landing-copy" }
    });
    assert.equal(response.isError, undefined);
    assert.deepEqual(JSON.parse(response.content[0].text), GATE_RESULT);

    // artifact_type is local only: it never reaches the API payload.
    const validateCall = api.calls.find((c) => c.path === "/v1/validate");
    assert.deepEqual(validateCall.body, { text: TEXT, domain: "agency", context: "Landing page" });

    const lines = (await fs.readFile(path.join(dir, "receipts.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const receipt = JSON.parse(lines[0]);
    assert.equal(receipt.text_sha256, SHA);
    assert.equal(receipt.domain, "agency");
    assert.equal(receipt.context, "Landing page");
    assert.equal(receipt.artifact_type, "landing-copy");
    assert.equal(receipt.source, "validate_content");
    assert.equal(receipt.doc_status, "written");
    assert.ok(!Number.isNaN(Date.parse(receipt.date)));
    assert.deepEqual(receipt.per_lens.truth, { passed: false, status: "ran" });
    assert.deepEqual(receipt.per_lens.rights, { passed: true, status: "ran" });
    assert.deepEqual(receipt.findings, [{
        lens: "truth", severity: "warning", issue: "Uncited statistic",
        quote: "47% of teams", quote_status: "exact"
    }]);
    assert.equal(receipt.findings_status, "scrubbed");
    // No document text in the receipt line.
    assert.ok(!lines[0].includes("jo@example.com"));
    assert.ok(!lines[0].includes("ship faster"));

    assert.equal(await fs.readFile(path.join(dir, "private", ".gitignore"), "utf8"), "*\n");
    const doc = await fs.readFile(path.join(dir, "private", "docs", `${SHA}.txt`), "utf8");
    assert.equal(doc, "47% of teams ship faster. Contact [REDACTED] for details.");
});

test("a failed scrub keeps the receipt but never saves unscrubbed text", async (t) => {
    const api = await fakeApi(t, { scrubFails: true });
    const dir = await tmpDir(t, "lens-receipts-");
    const client = await connect(t, {
        SOULFIELD_API_BASE: api.base,
        SOULFIELD_API_KEY: "fixture-key",
        LENS_RECEIPT_DIR: dir
    });
    const response = await client.callTool({ name: "validate_content", arguments: { text: TEXT } });
    assert.equal(response.isError, undefined);
    const receipt = JSON.parse((await fs.readFile(path.join(dir, "receipts.jsonl"), "utf8")).trim());
    assert.equal(receipt.doc_status, "not_written_scrub_failed");
    await assert.rejects(fs.stat(path.join(dir, "private", "docs", `${SHA}.txt`)));
    // The line's free-text fields are dropped too, not saved unscrubbed.
    assert.equal(receipt.findings_status, "text_dropped_scrub_failed");
    assert.deepEqual(receipt.findings, [{
        lens: "truth", severity: "warning", issue: null, quote: null, quote_status: "exact"
    }]);
    assert.equal(receipt.context, null);
});

test("quotes, issues and context are scrubbed before the receipt line is written", async (t) => {
    // The email starts at character 299. A cut before the scrub would keep
    // " j" (part of the address); scrub-then-cut keeps " [" (part of the marker).
    const longQuote = "x".repeat(298) + " jo@example.com";
    const gate = {
        ...GATE_RESULT,
        lenses: {
            truth: {
                passed: false,
                status: "ran",
                violations: [
                    { severity: "warning", issue: "Names jo@example.com as a source", quote: "ask jo@example.com", quote_status: "exact" },
                    { severity: "info", issue: "Long quote", quote: longQuote, quote_status: "exact" }
                ]
            }
        }
    };
    const api = await fakeApi(t, { gate });
    const dir = await tmpDir(t, "lens-receipts-");
    const client = await connect(t, {
        SOULFIELD_API_BASE: api.base,
        SOULFIELD_API_KEY: "fixture-key",
        LENS_RECEIPT_DIR: dir
    });
    const response = await client.callTool({
        name: "validate_content",
        arguments: { text: TEXT, context: "Outreach to jo@example.com" }
    });
    assert.equal(response.isError, undefined);
    // The response itself is the API's, unchanged.
    assert.deepEqual(JSON.parse(response.content[0].text), gate);

    const raw = (await fs.readFile(path.join(dir, "receipts.jsonl"), "utf8")).trim();
    assert.ok(!raw.includes("jo@"));
    const receipt = JSON.parse(raw);
    assert.equal(receipt.findings_status, "scrubbed");
    assert.equal(receipt.context, "Outreach to [REDACTED]");
    assert.equal(receipt.findings[0].issue, "Names [REDACTED] as a source");
    assert.equal(receipt.findings[0].quote, "ask [REDACTED]");
    assert.equal(receipt.findings[1].quote, "x".repeat(298) + " [");
    // One scrub call for the doc and one for the line's fields.
    assert.equal(api.calls.filter((c) => c.path === "/v1/scrub").length, 2);
});

test("a leading ~ in LENS_RECEIPT_DIR expands to the home directory", async (t) => {
    const api = await fakeApi(t);
    const home = await tmpDir(t, "lens-home-");
    const client = await connect(t, {
        SOULFIELD_API_BASE: api.base,
        SOULFIELD_API_KEY: "fixture-key",
        HOME: home,
        LENS_RECEIPT_DIR: "~/review"
    });
    const response = await client.callTool({ name: "validate_content", arguments: { text: TEXT } });
    assert.equal(response.isError, undefined);
    const receipt = JSON.parse((await fs.readFile(path.join(home, "review", "receipts.jsonl"), "utf8")).trim());
    assert.equal(receipt.text_sha256, SHA);
});

test("validation_submit then validation_receipt writes one receipt when the job completes", async (t) => {
    const jobId = "12345678-1234-4234-8234-123456789abc";
    let polls = 0;
    const api = await fakeApi(t, {
        route: (request) => {
            if (request.method === "POST" && request.url === "/v1/validate") {
                return { id: jobId, status: "pending" };
            }
            if (request.method === "GET" && request.url === `/v1/validate/${jobId}`) {
                polls += 1;
                return polls === 1 ? { id: jobId, status: "pending" } : { ...GATE_RESULT, id: jobId };
            }
            return null;
        }
    });
    const dir = await tmpDir(t, "lens-receipts-");
    const client = await connect(t, {
        SOULFIELD_API_BASE: api.base,
        SOULFIELD_API_KEY: "fixture-key",
        LENS_RECEIPT_DIR: dir
    });
    const submit = await client.callTool({ name: "validation_submit", arguments: { text: TEXT, domain: "agency" } });
    assert.equal(JSON.parse(submit.content[0].text).job_id, jobId);
    await client.callTool({ name: "validation_receipt", arguments: { job_id: jobId } });
    await assert.rejects(fs.stat(path.join(dir, "receipts.jsonl")));
    await client.callTool({ name: "validation_receipt", arguments: { job_id: jobId } });
    await client.callTool({ name: "validation_receipt", arguments: { job_id: jobId } });
    const lines = (await fs.readFile(path.join(dir, "receipts.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const receipt = JSON.parse(lines[0]);
    assert.equal(receipt.source, "validation_job");
    assert.equal(receipt.validation_id, jobId);
    assert.equal(receipt.text_sha256, SHA);
    assert.equal(receipt.domain, "agency");
});

test("an unwritable receipt dir never fails the validation", async (t) => {
    const api = await fakeApi(t);
    const root = await tmpDir(t, "lens-receipts-");
    const notADir = path.join(root, "file");
    await fs.writeFile(notADir, "x", "utf8");
    const client = await connect(t, {
        SOULFIELD_API_BASE: api.base,
        SOULFIELD_API_KEY: "fixture-key",
        LENS_RECEIPT_DIR: notADir
    });
    const response = await client.callTool({ name: "validate_content", arguments: { text: TEXT } });
    assert.equal(response.isError, undefined);
    assert.deepEqual(JSON.parse(response.content[0].text), GATE_RESULT);
});

test("no LENS_RECEIPT_DIR means no scrub call and no files", async (t) => {
    const api = await fakeApi(t);
    const client = await connect(t, { SOULFIELD_API_BASE: api.base, SOULFIELD_API_KEY: "fixture-key" });
    const response = await client.callTool({ name: "validate_content", arguments: { text: TEXT } });
    assert.equal(response.isError, undefined);
    assert.deepEqual(api.calls.map((c) => c.path), ["/v1/validate"]);
});

// A fake lens-kit: it saves its argv, its cwd and the --from-json record into
// <cwd>/fake-kit-call.json, so the test can check what the server sent.
async function fakeKit(dir) {
    const bin = path.join(dir, "fake-lens-kit");
    await fs.writeFile(bin, `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
const i = args.indexOf("--from-json");
const record = i >= 0 ? JSON.parse(fs.readFileSync(args[i + 1], "utf8")) : null;
fs.writeFileSync("fake-kit-call.json", JSON.stringify({ args, cwd: process.cwd(), record }));
console.log("Appended catch c-fixture to catches.jsonl");
`, { mode: 0o755 });
    return bin;
}

test("lens_catches_add passes snippet, lenses_failed and provenance via --from-json", async (t) => {
    const kitDir = await tmpDir(t, "lens-kit-bin-");
    const catchesDir = await tmpDir(t, "lens-catches-");
    const client = await connect(t, {
        LENS_KIT_BIN: await fakeKit(kitDir),
        LENS_CATCHES_DIR: catchesDir
    });
    const snippet = "47% of teams\n  ship faster.";
    const response = await client.callTool({
        name: "lens_catches_add",
        arguments: {
            catch: "Uncited 47% figure",
            pattern: "uncited statistic",
            rule: "cite every external number",
            artifact_type: "landing-copy",
            domain: "agency",
            snippet,
            lenses_failed: ["truth"],
            provenance: "michael"
        }
    });
    assert.equal(response.isError, undefined);
    assert.equal(JSON.parse(response.content[0].text).verdict, "OK");

    // No cwd argument: the call ran in the default catches dir.
    const call = JSON.parse(await fs.readFile(path.join(catchesDir, "fake-kit-call.json"), "utf8"));
    assert.equal(await fs.realpath(call.cwd), await fs.realpath(catchesDir));
    assert.deepEqual(call.args.slice(0, 3), ["catches", "add", "--from-json"]);
    assert.deepEqual(call.record, {
        catch: "Uncited 47% figure",
        pattern: "uncited statistic",
        rule: "cite every external number",
        artifact_type: "landing-copy",
        domain: "agency",
        snippet,
        lenses_failed: ["truth"],
        provenance: "michael"
    });
    // The temporary JSON file is removed after the call.
    await assert.rejects(fs.stat(call.args[3]));
});

test("lens_catches_add rejects an unknown provenance before running lens-kit", async (t) => {
    const kitDir = await tmpDir(t, "lens-kit-bin-");
    const catchesDir = await tmpDir(t, "lens-catches-");
    const client = await connect(t, { LENS_KIT_BIN: await fakeKit(kitDir), LENS_CATCHES_DIR: catchesDir });
    const response = await client.callTool({
        name: "lens_catches_add",
        arguments: {
            catch: "d", pattern: "p", rule: "r", artifact_type: "x", domain: "agency",
            provenance: "gpt"
        }
    });
    assert.equal(response.isError, true);
    await assert.rejects(fs.stat(path.join(catchesDir, "fake-kit-call.json")));
});


test("scrub calls send the user's own published details as the keep list", async (t) => {
    const api = await fakeApi(t);
    const dir = await tmpDir(t, "lens-identity-");
    const identity = path.join(dir, "identity.txt");
    await fs.writeFile(identity, "# own details\nJo Example\njo@example.com\nx\n");
    const client = await connect(t, {
        SOULFIELD_API_BASE: api.base,
        SOULFIELD_API_KEY: "fixture-key",
        LENS_RECEIPT_DIR: dir,
        LENS_PUBLIC_IDENTITY_FILE: identity
    });
    await client.callTool({ name: "scrub_pii", arguments: { text: TEXT } });
    await client.callTool({ name: "validate_content", arguments: { text: TEXT, domain: "agency" } });
    const scrubs = api.calls.filter((c) => c.path === "/v1/scrub");
    assert.ok(scrubs.length >= 2);
    for (const call of scrubs) assert.deepEqual(call.body.keep, ["Jo Example", "jo@example.com"]);
});

test("without an identity file the keep list is empty", async (t) => {
    const api = await fakeApi(t);
    const client = await connect(t, { SOULFIELD_API_BASE: api.base, SOULFIELD_API_KEY: "fixture-key" });
    await client.callTool({ name: "scrub_pii", arguments: { text: TEXT } });
    assert.deepEqual(api.calls.find((c) => c.path === "/v1/scrub").body.keep, []);
});
