"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const DEFAULT_LIMITS = Object.freeze({
    maxArtifactBytes: 1_000_000,
    maxEvidenceFiles: 500,
    maxEvidenceBytes: 20_000_000,
    maxMatchesPerQuery: 20
});

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

function sha256(text) {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function readUtf8File(filePath, maxBytes, kind) {
    const resolved = path.resolve(filePath);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
        throw new Error(`${kind} must be a regular file`);
    }
    if (stat.size > maxBytes) {
        throw new Error(`${kind} exceeds the ${maxBytes}-byte local safety limit`);
    }
    const buffer = await fs.readFile(resolved);
    if (buffer.includes(0)) {
        throw new Error(`${kind} is binary; only UTF-8 text is supported`);
    }
    return { resolved, text: buffer.toString("utf8"), bytes: buffer.length };
}

async function collectEvidenceFiles(roots, limits) {
    const files = [];
    const skippedSymlinks = [];

    async function addPath(absolutePath, rootIndex, rootPath) {
        const entry = await fs.lstat(absolutePath);
        if (entry.isSymbolicLink()) {
            skippedSymlinks.push({
                root: `root_${rootIndex + 1}`,
                path: path.relative(rootPath, absolutePath) || path.basename(absolutePath)
            });
            return;
        }
        if (entry.isFile()) {
            files.push({
                absolutePath,
                root: `root_${rootIndex + 1}`,
                path: path.relative(rootPath, absolutePath) || path.basename(absolutePath),
                bytes: entry.size
            });
            if (files.length > limits.maxEvidenceFiles) {
                throw new Error(`Evidence scope exceeds the ${limits.maxEvidenceFiles}-file local safety limit`);
            }
            return;
        }
        if (!entry.isDirectory()) return;

        const children = await fs.readdir(absolutePath, { withFileTypes: true });
        children.sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
            if (child.isDirectory() && SKIPPED_DIRECTORIES.has(child.name)) continue;
            await addPath(path.join(absolutePath, child.name), rootIndex, rootPath);
        }
    }

    for (const [index, root] of roots.entries()) {
        const resolvedRoot = path.resolve(root);
        const stat = await fs.lstat(resolvedRoot);
        const relativeBase = stat.isDirectory() ? resolvedRoot : path.dirname(resolvedRoot);
        await addPath(resolvedRoot, index, relativeBase);
    }

    return { files, skippedSymlinks };
}

async function searchEvidence(roots, queries, suppliedLimits = {}, options = {}) {
    if (!queries.length) {
        return {
            status: "NOT_RUN",
            scope_complete: true,
            files_read: [],
            skipped_binary_files: [],
            skipped_symlinks: [],
            excluded_files: [],
            queries: []
        };
    }
    if (!roots.length) {
        throw new Error("evidence_roots is required when evidence_queries are supplied");
    }

    const limits = { ...DEFAULT_LIMITS, ...suppliedLimits };
    const { files, skippedSymlinks } = await collectEvidenceFiles(roots, limits);
    const excludedPaths = new Set(
        (options.excludePaths || []).map((excludedPath) => path.resolve(excludedPath))
    );
    const includedFiles = files.filter((file) => !excludedPaths.has(file.absolutePath));
    const excludedFiles = files
        .filter((file) => excludedPaths.has(file.absolutePath))
        .map(({ root, path: relativePath }) => ({ root, path: relativePath }));
    const searchable = [];
    const skippedBinaryFiles = [];
    let totalBytes = 0;

    for (const file of includedFiles) {
        totalBytes += file.bytes;
        if (totalBytes > limits.maxEvidenceBytes) {
            throw new Error(`Evidence scope exceeds the ${limits.maxEvidenceBytes}-byte local safety limit`);
        }
        const buffer = await fs.readFile(file.absolutePath);
        if (buffer.includes(0)) {
            skippedBinaryFiles.push({ root: file.root, path: file.path });
            continue;
        }
        searchable.push({ ...file, text: buffer.toString("utf8") });
    }

    const queryResults = queries.map((query, queryIndex) => {
        const matches = [];
        const needle = query.case_sensitive === false ? query.query.toLocaleLowerCase() : query.query;
        for (const file of searchable) {
            const lines = file.text.split(/\r?\n/);
            for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
                const haystack = query.case_sensitive === false
                    ? lines[lineIndex].toLocaleLowerCase()
                    : lines[lineIndex];
                if (!haystack.includes(needle)) continue;
                matches.push({
                    root: file.root,
                    path: file.path,
                    line: lineIndex + 1,
                    excerpt: lines[lineIndex].trim().slice(0, 240)
                });
                if (matches.length >= limits.maxMatchesPerQuery) break;
            }
            if (matches.length >= limits.maxMatchesPerQuery) break;
        }
        return {
            claim: query.claim || `claim_${queryIndex + 1}`,
            query: query.query,
            case_sensitive: query.case_sensitive !== false,
            status: matches.length ? "SOURCE_LOCATED_REQUIRES_REVIEW" : "NO_SOURCE_MATCH",
            matches
        };
    });

    const scopeComplete = skippedSymlinks.length === 0 && skippedBinaryFiles.length === 0;
    const everyQueryMatched = queryResults.every((result) => result.matches.length > 0);
    return {
        status: scopeComplete && everyQueryMatched ? "COMPLETE" : "INCOMPLETE",
        scope_complete: scopeComplete,
        files_read: searchable.map(({ root, path: relativePath, bytes }) => ({
            root,
            path: relativePath,
            bytes
        })),
        skipped_binary_files: skippedBinaryFiles,
        skipped_symlinks: skippedSymlinks,
        excluded_files: excludedFiles,
        queries: queryResults
    };
}

function consistencyStatus(results) {
    const checks = Object.values(results || {});
    if (!checks.length) return "NOT_RUN";
    if (checks.some((check) => check.status === "VIOLATION")) return "VIOLATION";
    if (checks.some((check) => check.status !== "CLEAN")) return "UNKNOWN";
    return "CLEAN";
}

function gateStatus(gate) {
    if (!gate || typeof gate !== "object") return "UNKNOWN";
    if (gate.halted === true) return "HALT";
    if (gate.status && gate.status !== "complete") return "UNKNOWN";
    if (gate.passed === false) return "FAIL";
    if (gate.passed === true) return "PASS";
    return "UNKNOWN";
}

async function validateArtifact(input, dependencies) {
    if (!dependencies || typeof dependencies.validateGate !== "function") {
        throw new Error("validateGate dependency is required");
    }

    const limits = { ...DEFAULT_LIMITS, ...(dependencies.limits || {}) };
    const artifact = await readUtf8File(
        input.artifact_path,
        limits.maxArtifactBytes,
        "artifact_path"
    );
    const roots = input.evidence_roots || [];
    const queries = input.evidence_queries || [];
    const evidence = await searchEvidence(roots, queries, limits, {
        excludePaths: [artifact.resolved]
    });
    const consistency = dependencies.runConsistency
        ? await dependencies.runConsistency(input.consistency || {}, input.cwd)
        : {};
    const gate = await dependencies.validateGate(artifact.text, input.domain, input.context);
    const consistencyVerdict = consistencyStatus(consistency);
    const gateVerdict = gateStatus(gate);
    const hasLocalPreflight = queries.length > 0 || Object.keys(consistency).length > 0;

    let fullValidatorStatus = "NOT_RUN";
    if (hasLocalPreflight) {
        if (gateVerdict === "HALT") {
            fullValidatorStatus = "HALT";
        } else if (gateVerdict === "FAIL" || consistencyVerdict === "VIOLATION") {
            fullValidatorStatus = "FAIL";
        } else if (
            gateVerdict === "UNKNOWN" ||
            evidence.status === "INCOMPLETE" ||
            consistencyVerdict === "UNKNOWN"
        ) {
            fullValidatorStatus = "UNKNOWN";
        } else {
            fullValidatorStatus = "PENDING_AGENT_REVIEW";
        }
    }

    return {
        validation_level: hasLocalPreflight ? "evidence-preflight+gate" : "gate-only",
        artifact: {
            name: path.basename(artifact.resolved),
            bytes: artifact.bytes,
            sha256: sha256(artifact.text)
        },
        evidence_scope: roots.map((_, index) => `root_${index + 1}`),
        files_read: evidence.files_read,
        searches_and_commands: evidence.queries.map((query) => ({
            claim: query.claim,
            operation: "literal-search",
            query: query.query,
            case_sensitive: query.case_sensitive
        })),
        claims_verified: [],
        claims_unverified: evidence.queries.map((query) => ({
            claim: query.claim,
            status: query.status,
            reason: query.status === "SOURCE_LOCATED_REQUIRES_REVIEW"
                ? "A literal match locates evidence; semantic verification still requires the separate validator agent."
                : "No literal source match was found in the declared evidence scope."
        })),
        evidence_preflight: evidence,
        consistency_checks: consistency,
        consistency_status: consistencyVerdict,
        gate,
        gate_status: gateVerdict,
        full_validator_status: fullValidatorStatus,
        note: "Only a separate validator agent with direct file-read/search access may convert PENDING_AGENT_REVIEW into a full-validator verdict. Evidence content was not sent to the API gate."
    };
}

module.exports = {
    DEFAULT_LIMITS,
    gateStatus,
    searchEvidence,
    sha256,
    validateArtifact
};
