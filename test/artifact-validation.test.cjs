"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { validateArtifact } = require("../lib/artifact-validation.cjs");

async function makeFixture(t, artifactText, evidenceText) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-artifact-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const artifactDir = path.join(root, "artifact");
    const evidenceDir = path.join(root, "evidence");
    await fs.mkdir(artifactDir);
    await fs.mkdir(evidenceDir);
    const artifactPath = path.join(artifactDir, "candidate.md");
    const evidencePath = path.join(evidenceDir, "source.md");
    await fs.writeFile(artifactPath, artifactText, "utf8");
    await fs.writeFile(evidencePath, evidenceText, "utf8");
    return { root, artifactPath, evidenceDir };
}

test("locates evidence locally but leaves semantic verification to the validator agent", async (t) => {
    const fixture = await makeFixture(
        t,
        "The measured widget count is 12.",
        "Run receipt: measured widget count is 12."
    );
    let textSentToGate;

    const result = await validateArtifact({
        artifact_path: fixture.artifactPath,
        evidence_roots: [fixture.evidenceDir],
        evidence_queries: [{ claim: "widget-count", query: "measured widget count is 12" }]
    }, {
        validateGate: async (text) => {
            textSentToGate = text;
            return { passed: true, score: 10 };
        },
        runConsistency: async () => ({})
    });

    assert.equal(textSentToGate, "The measured widget count is 12.");
    assert.equal(result.validation_level, "evidence-preflight+gate");
    assert.equal(result.evidence_preflight.status, "COMPLETE");
    assert.equal(result.full_validator_status, "PENDING_AGENT_REVIEW");
    assert.deepEqual(result.claims_verified, []);
    assert.equal(result.claims_unverified[0].status, "SOURCE_LOCATED_REQUIRES_REVIEW");
    assert.equal(result.evidence_preflight.queries[0].matches[0].path, "source.md");
    assert.equal(JSON.stringify(result).includes(fixture.root), false);
});

test("a planted evidence mismatch cannot be hidden by a passing API gate", async (t) => {
    const fixture = await makeFixture(
        t,
        "The measured widget count is 12.",
        "Run receipt: measured widget count is 11."
    );

    const result = await validateArtifact({
        artifact_path: fixture.artifactPath,
        evidence_roots: [fixture.evidenceDir],
        evidence_queries: [{ claim: "widget-count", query: "measured widget count is 12" }]
    }, {
        validateGate: async () => ({ passed: true, score: 10 }),
        runConsistency: async () => ({})
    });

    assert.equal(result.gate.passed, true);
    assert.equal(result.evidence_preflight.status, "INCOMPLETE");
    assert.equal(result.evidence_preflight.queries[0].status, "NO_SOURCE_MATCH");
    assert.equal(result.full_validator_status, "UNKNOWN");
});

test("the submitted artifact cannot satisfy its own evidence query", async (t) => {
    const fixture = await makeFixture(
        t,
        "SELF_CITING_CLAIM appears only in the submitted artifact.",
        "The independent source does not contain the claim."
    );

    const result = await validateArtifact({
        artifact_path: fixture.artifactPath,
        evidence_roots: [fixture.root],
        evidence_queries: [{ claim: "self-citation", query: "SELF_CITING_CLAIM" }]
    }, {
        validateGate: async () => ({ passed: true }),
        runConsistency: async () => ({})
    });

    assert.equal(result.evidence_preflight.queries[0].status, "NO_SOURCE_MATCH");
    assert.equal(result.evidence_preflight.excluded_files.length, 1);
    assert.equal(result.full_validator_status, "UNKNOWN");
});

test("an authoritative consistency violation forces FAIL even when the gate passes", async (t) => {
    const fixture = await makeFixture(t, "Summary says 12.", "Body says 11.");

    const result = await validateArtifact({
        artifact_path: fixture.artifactPath,
        consistency: { numbers: { summary: "summary.md", body: "body.md" } }
    }, {
        validateGate: async () => ({ passed: true, score: 10 }),
        runConsistency: async () => ({ numbers: { status: "VIOLATION", exit_code: 6 } })
    });

    assert.equal(result.validation_level, "evidence-preflight+gate");
    assert.equal(result.consistency_status, "VIOLATION");
    assert.equal(result.full_validator_status, "FAIL");
});

test("an API gate failure propagates through a complete evidence preflight", async (t) => {
    const fixture = await makeFixture(t, "Claim with source.", "Claim with source.");

    const result = await validateArtifact({
        artifact_path: fixture.artifactPath,
        evidence_roots: [fixture.evidenceDir],
        evidence_queries: [{ claim: "sourced-claim", query: "Claim with source." }]
    }, {
        validateGate: async () => ({ status: "complete", passed: false, halted: false }),
        runConsistency: async () => ({})
    });

    assert.equal(result.evidence_preflight.status, "COMPLETE");
    assert.equal(result.gate_status, "FAIL");
    assert.equal(result.full_validator_status, "FAIL");
});

test("a Rights halt propagates through the combined path", async (t) => {
    const fixture = await makeFixture(t, "Claim with source.", "Claim with source.");

    const result = await validateArtifact({
        artifact_path: fixture.artifactPath,
        consistency: { numbers: { summary: "summary.md", body: "body.md" } }
    }, {
        validateGate: async () => ({ status: "complete", passed: false, halted: true }),
        runConsistency: async () => ({ numbers: { status: "CLEAN", exit_code: 0 } })
    });

    assert.equal(result.gate_status, "HALT");
    assert.equal(result.full_validator_status, "HALT");
});

test("no local evidence request is labelled gate-only", async (t) => {
    const fixture = await makeFixture(t, "A small candidate.", "Unused evidence.");

    const result = await validateArtifact({ artifact_path: fixture.artifactPath }, {
        validateGate: async () => ({ passed: true }),
        runConsistency: async () => ({})
    });

    assert.equal(result.validation_level, "gate-only");
    assert.equal(result.evidence_preflight.status, "NOT_RUN");
    assert.equal(result.full_validator_status, "NOT_RUN");
});

test("evidence text and local absolute paths are never sent to the API gate", async (t) => {
    const fixture = await makeFixture(
        t,
        "Public artifact text.",
        "PRIVATE_EVIDENCE_MARKER appears only in the local source."
    );
    let textSentToGate = "";

    await validateArtifact({
        artifact_path: fixture.artifactPath,
        evidence_roots: [fixture.evidenceDir],
        evidence_queries: [{ claim: "private-marker", query: "PRIVATE_EVIDENCE_MARKER" }]
    }, {
        validateGate: async (text) => {
            textSentToGate = text;
            return { passed: true };
        },
        runConsistency: async () => ({})
    });

    assert.equal(textSentToGate, "Public artifact text.");
    assert.equal(textSentToGate.includes("PRIVATE_EVIDENCE_MARKER"), false);
    assert.equal(textSentToGate.includes(fixture.root), false);
});
