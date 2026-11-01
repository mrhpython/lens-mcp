"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { z } = require("zod/v3");
const { registerValidationJobs } = require("../lib/validation-jobs.cjs");
const id = "12345678-1234-4234-8234-123456789abc";
function setup(request, key = "fixture-key") {
    const tools = {};
    registerValidationJobs({ registerTool(name, _, fn) { tools[name] = fn; } }, z,
        request, key, value => value);
    return tools;
}
test("submit once and retrieve pending then complete without another POST", async () => {
    const calls = [];
    const receipt = { id, status: "complete", passed: true, lenses: { truth: { passed: false } } };
    const tools = setup(async (...args) => {
        calls.push(args);
        return calls.length < 3 ? { id, status: "pending" } : receipt;
    });
    const job = await tools.validation_submit({ text: "Frozen candidate", domain: "agency" });
    assert.equal(job.gate_status, "UNKNOWN");
    assert.equal(job.job_id, id);
    assert.equal((await tools.validation_receipt({ job_id: id })).status, "pending");
    assert.deepEqual(await tools.validation_receipt({ job_id: id }), receipt);
    assert.deepEqual(calls.map(c => c[0]), ["POST", "GET", "GET"]);
    assert.deepEqual(calls[0][2], { text: "Frozen candidate", domain: "agency", options: { async: true } });
    assert.equal(calls[0][3].timeout, 10000);
});
test("errors and uncertain submissions remain UNKNOWN without retry or content leakage", async () => {
    let count = 0;
    const tools = setup(async () => { count++; throw new Error("PRIVATE_BODY"); });
    const result = await tools.validation_submit({ text: "candidate" });
    assert.equal(count, 1);
    assert.equal(result.gate_status, "UNKNOWN");
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes("PRIVATE_BODY"), false);
});
test("invalid ids, mismatched ids and missing key fail closed", async () => {
    let count = 0;
    const tools = setup(async () => { count++; return { id: "wrong" }; });
    assert.equal((await tools.validation_receipt({ job_id: "../other" })).isError, true);
    assert.equal(count, 0);
    assert.equal((await tools.validation_receipt({ job_id: id })).isError, true);
    assert.equal((await setup(async () => { throw new Error("should not call"); }, "").validation_submit({ text: "candidate" })).isError, true);
});
test("Rights HALT and failed jobs remain literal API results", async () => {
    for (const result of [{ id, status: "complete", halted: true, passed: false }, { id, status: "failed" }]) {
        assert.deepEqual(await setup(async () => result).validation_receipt({ job_id: id }), result);
    }
});
test("onComplete fires once per submitted job, only when complete, and never changes the result", async () => {
    const seen = [];
    const receipt = { id, status: "complete", passed: true, lenses: { truth: { passed: true } } };
    let calls = 0;
    const request = async () => (++calls < 3 ? { id, status: "pending" } : receipt);
    const tools = {};
    registerValidationJobs({ registerTool(name, _, fn) { tools[name] = fn; } }, z,
        request, "fixture-key", value => value,
        async (...args) => { seen.push(args); throw new Error("hook failure is swallowed"); });
    await tools.validation_submit({ text: "Frozen candidate", domain: "agency", context: "Email" });
    await tools.validation_receipt({ job_id: id });
    assert.equal(seen.length, 0);
    assert.deepEqual(await tools.validation_receipt({ job_id: id }), receipt);
    assert.deepEqual(await tools.validation_receipt({ job_id: id }), receipt);
    assert.deepEqual(seen, [["Frozen candidate", "agency", "Email", receipt]]);
    // A job this process did not submit has no text, so it gets no receipt.
    const other = "87654321-1234-4234-8234-123456789abc";
    const tools2 = {};
    const seen2 = [];
    registerValidationJobs({ registerTool(name, _, fn) { tools2[name] = fn; } }, z,
        async () => ({ ...receipt, id: other }), "fixture-key", value => value,
        async (...args) => { seen2.push(args); });
    await tools2.validation_receipt({ job_id: other });
    assert.equal(seen2.length, 0);
});
