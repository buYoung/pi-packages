// Turns one Pi session file into memory in the memory scope of the session's folder, with that
// scope's settings and models, then updates the summary. Runs from this repository against the
// built package, and loads the Pi extensions configured in the agent directory so that their
// model providers are available.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    createAgentSessionServices,
    getAgentDir,
    ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { WORKER_LIMIT } from "../dist/coordinator.js";
import { MemoryUserError, memoryFailureCode } from "../dist/failure.js";
import {
    createStages,
    needsExtraction,
    piMemoryModel,
} from "../dist/pipeline.js";
import { findRepository } from "../dist/repositories.js";
import { safeError } from "../dist/safety.js";
import { readSessionFile } from "../dist/session-file.js";
import { readSources } from "../dist/sources.js";
import { MemoryStore } from "../dist/store.js";

const USAGE = "Usage: create-memory <session-file>";

async function main(arg, signal) {
    // pnpm runs package scripts in the package folder; INIT_CWD is where the command was typed.
    const file = resolve(process.env.INIT_CWD ?? process.cwd(), arg);
    if (!existsSync(file))
        throw new MemoryUserError(`No such session file: ${file}`);
    let header;
    // Only the header is needed here; rejecting it ends the read.
    await readSessionFile(file, signal, new Set(), (value) => {
        header = value;
        return false;
    });
    if (!header) throw new MemoryUserError("Not a Pi session file.");
    const agentDir = getAgentDir();
    const store = new MemoryStore(join(agentDir, "pi-codex-memory"));
    try {
        const repository = findRepository(header.cwd);
        if (repository) store.registerRepository(repository);
        const scope = store.scopeFor(header.cwd);
        // An explicit request runs whether memory is on or off in the scope.
        const settings = store.getSettings(scope);
        // An explicit request, like Create memories now: parts no repository binding covers count
        // for the repository the session folder belongs to now.
        const sources = await readSources(
            file,
            settings.maxInputBytes - 8192,
            signal,
            {
                requireOrigin: false,
                requireBinding: false,
                expectedScope: scope,
                oldestPartMs:
                    Date.now() - settings.maxRolloutAgeDays * 86_400_000,
                isCwdExcluded:
                    scope === "global"
                        ? undefined
                        : (cwd) => store.selectsGlobal(cwd),
            },
        );
        const pending = sources.filter((source) =>
            needsExtraction(store, scope, source, Date.now()),
        );
        console.log(
            `Session ${header.id} in ${scope}: ${sources.length} part(s) from the last ${settings.maxRolloutAgeDays} day(s), ${pending.length} to create.`,
        );
        const services = await createAgentSessionServices({
            // A removed worktree leaves no folder to discover project extensions in.
            cwd: existsSync(header.cwd) ? header.cwd : process.cwd(),
            agentDir,
            resourceLoaderOptions: {
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true,
            },
        });
        for (const diagnostic of services.diagnostics)
            if (diagnostic.type === "error") console.error(diagnostic.message);
        const modelRegistry = new ModelRegistry(services.modelRuntime);
        const provider = services.settingsManager.getDefaultProvider(),
            modelId = services.settingsManager.getDefaultModel();
        const runId = randomUUID();
        const stages = createStages({
            store,
            scope,
            settings,
            signal,
            isExplicit: true,
            // A model choice of null follows Pi's default model, as a new Pi session would.
            model: piMemoryModel({
                modelRegistry,
                model:
                    provider && modelId
                        ? modelRegistry.find(provider, modelId)
                        : undefined,
                thinkingLevel:
                    services.settingsManager.getDefaultThinkingLevel() ??
                    "medium",
                sessionManager: { getSessionId: () => runId },
            }),
        });
        const tally = { extracted: 0, skipped: 0, failed: 0 };
        let next = 0,
            isBlocked = false;
        const work = async () => {
            while (next < pending.length && !isBlocked) {
                const source = pending[next++];
                const key = `extract:${source.id}`;
                const label = `Part ${source.part?.number ?? 1}`;
                if (
                    !(await stages.isModelReady(
                        key,
                        source.fingerprint,
                        settings.extractModel,
                    ))
                ) {
                    isBlocked = true;
                    tally.failed++;
                    console.error(
                        `${label}: the memory model is not available.`,
                    );
                    return;
                }
                const lease = store.claim(
                    scope,
                    key,
                    source.fingerprint,
                    Date.now(),
                    settings,
                    true,
                );
                if (!lease) {
                    tally.skipped++;
                    console.log(`${label}: another Pi session is on it.`);
                    continue;
                }
                const outcome = await stages.extract(source, lease);
                tally[outcome]++;
                console.log(`${label}: ${outcome}.`);
            }
        };
        // Every job settles, cancelled ones included, before storage closes.
        const results = await Promise.allSettled(
            Array.from(
                { length: Math.min(WORKER_LIMIT, pending.length) },
                work,
            ),
        );
        const rejected = results.find((result) => result.status === "rejected");
        if (rejected) throw rejected.reason;
        const summary = await stages.consolidate(true);
        // Without a claim the summary is either current or being updated by an open Pi session.
        console.log(
            `Created ${tally.extracted}, failed ${tally.failed}. ${summary.failed ? (summary.consolidated ? "Summary partly updated, then failed." : "Summary failed.") : summary.skipped ? (summary.consolidated ? "Summary partly updated, then stopped because settings or memories changed." : "Summary skipped because settings changed.") : summary.consolidated ? "Summary updated." : "Summary not updated: it is current, or an open Pi session is updating it."}`,
        );
        return tally.failed || summary.failed ? 1 : 0;
    } finally {
        store.close();
    }
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.length !== 1 || args[0].startsWith("-")) {
    console.error(USAGE);
    process.exit(2);
}
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
let code;
try {
    code = await main(args[0], controller.signal);
} catch (error) {
    const isCancelled = memoryFailureCode(error) === "aborted";
    console.error(isCancelled ? "Cancelled." : safeError(error));
    code = isCancelled ? 130 : 1;
}
// Loaded extensions may keep handles open.
process.exit(code);
