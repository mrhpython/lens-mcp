"use strict";

// Short MCP calls keep an async API job retrievable across client timeouts.
// onComplete(text, domain, context, result) is optional: when given, it is
// called once for each job this process submitted and then read as complete,
// so the receipt writer sees these jobs too. The submitted text is held in
// memory only until then, for at most MAX_PENDING jobs; a server restart
// drops it and that job then gets no receipt.
const MAX_PENDING = 100;

function registerValidationJobs(server, z, apiRequest, apiKey, jsonResponse, onComplete = null) {
    const idSchema = z.string().uuid();
    const pending = new Map();
    const remember = (id, job) => {
        if (!onComplete) return;
        pending.set(id, job);
        if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
    };
    const settle = async (id, result) => {
        const job = pending.get(id);
        if (!job || !result || result.status !== "complete") return;
        pending.delete(id);
        try { await onComplete(job.text, job.domain, job.context, result); }
        catch (error) { console.error("[validation_jobs] receipt hook failed:", error.message || String(error)); }
    };
    const options = () => {
        if (!apiKey) throw new Error("SOULFIELD_API_KEY is not configured");
        return { apiKey, timeout: 10000 };
    };
    const call = async (operation) => {
        try { return jsonResponse(await operation()); }
        catch (_) {
            // Never echo upstream bodies: they may contain submitted content.
            return { ...jsonResponse({ gate_status: "UNKNOWN",
                error: "Validation request unavailable; no verdict returned. Do not automatically resubmit an uncertain submission." }), isError: true };
        }
    };
    server.registerTool("validation_submit", {
        title: "Submit validation job",
        description: "Submit exact finished text once to the local API async gate. Save the returned id with the candidate SHA-256 locally, then use validation_receipt. Pending is UNKNOWN, never clearance. An uncertain submission must not be automatically retried.",
        inputSchema: { text: z.string().min(1), domain: z.enum(["general", "finance", "marketing", "legal", "seo", "agency"]).optional(), context: z.string().optional() }
    }, async ({ text, domain, context }) => call(async () => {
        const payload = { text, options: { async: true } };
        if (domain) payload.domain = domain;
        if (context) payload.context = context;
        const result = await apiRequest("POST", "/v1/validate", payload, options());
        idSchema.parse(result.id);
        remember(result.id, { text, domain, context });
        await settle(result.id, result);
        return { gate_status: "UNKNOWN", job_id: result.id,
            status: result.status, next_tool: "validation_receipt" };
    }));
    server.registerTool("validation_receipt", {
        title: "Retrieve validation receipt",
        description: "Read an existing validation job without submitting text again. Returns the API receipt unchanged. Pending, failed, missing or incomplete receipts confer no clearance. The independent validator must verify completeness and candidate hash binding.",
        inputSchema: { job_id: idSchema }
    }, async ({ job_id }) => call(async () => {
        idSchema.parse(job_id);
        const result = await apiRequest("GET", `/v1/validate/${job_id}`, null, options());
        if (result.id !== job_id) throw new Error("Mismatched job id");
        await settle(job_id, result);
        return result;
    }));
}

module.exports = { registerValidationJobs };
