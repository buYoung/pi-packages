#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { discoverChecks } from "./discovery.js";
import { makeReport, safeResult, writeReport } from "./report.js";
import { assertAllowedModel, assertLiveEnvironment, MODEL_ID } from "./policy.js";
import { EnvironmentError, VerificationError, type CheckContext, type CheckResult } from "./types.js";

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HELP = `Usage: pnpm --filter @buyong/pi-claude-bridge verify <check...> [--live] [--report path]
       pnpm --filter @buyong/pi-claude-bridge verify --all [--live] [--report path]
       pnpm --filter @buyong/pi-claude-bridge verify --cache [--live] [--report path]
       pnpm --filter @buyong/pi-claude-bridge verify --list

--model claude-haiku-5-5  Verification model. The claude-bridge/ prefix is also accepted.
--live                  Calls the real model with the subscription login.
--report path           Saves the version, source hashes, check results, and request count as JSON.
--cache                 Runs only the optional cache measurement checks (cache group). --all does not include them.

The default is offline. spawn checks only the SDK arguments with an executable that has no network access.
live checks are skipped without --live. If every check is skipped, the exit code is 0 and none count as pass.
Exit codes: 0=no failures, 1=check failed, 2=usage or environment error.
`;

export function parseCLI(argv: string[]) {
	try {
		const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
			all: { type: "boolean" }, cache: { type: "boolean" }, list: { type: "boolean" }, live: { type: "boolean" },
			report: { type: "string" }, model: { type: "string", default: MODEL_ID }, help: { type: "boolean" },
		} });
		if (values.all && positionals.length || values.list && (values.all || positionals.length)) throw new Error();
		if (values.cache && (values.all || values.list || positionals.length)) throw new Error();
		if (!values.help && !values.list && !values.all && !values.cache && !positionals.length) throw new Error();
		return { ...values, names: [...new Set(positionals)] };
	} catch { throw new EnvironmentError("invalid-arguments"); }
}

export interface CLIHost {
	appDir?: string;
	checksDir?: string;
	env?: NodeJS.ProcessEnv;
	print?: (line: string) => void;
}

export async function runCLI(argv: string[], host: CLIHost = {}): Promise<number> {
	const appDir = host.appDir ?? APP_DIR;
	const print = host.print ?? console.log;
	let args: ReturnType<typeof parseCLI> | undefined;
	let report: ReturnType<typeof makeReport> | undefined;
	const context: CheckContext = { appDir, modelId: MODEL_ID, isLive: false, apiCalls: 0 };
	try {
		args = parseCLI(argv);
		if (args.help) { print(HELP); return 0; }
		report = makeReport(appDir);
		context.modelId = args.model;
		assertAllowedModel(context.modelId);
		context.isLive = args.live === true;
		if (context.isLive) assertLiveEnvironment(host.env ?? process.env, context.modelId);
		const checks = await discoverChecks(host.checksDir ?? join(appDir, "tools/verify/checks"));
		if (args.list) { for (const check of checks) print(`${check.name}\t${check.mode}${check.group ? `\t${check.group}` : ""}`); return 0; }
		// Cache checks are optional measurements: only --cache or an explicit name runs them.
		const selected = args.cache ? checks.filter(check => check.group === "cache")
			: args.all ? checks.filter(check => check.group !== "cache") : args.names.map(name => {
			const check = checks.find(item => item.name === name);
			if (!check) throw new EnvironmentError("unknown-check");
			return check;
		});
		let hasEnvironmentError = false;
		for (const check of selected) {
			const startCalls = context.apiCalls;
			let result: CheckResult = { name: check.name, mode: check.mode, inputs: check.inputs, expected: check.expected, observed: {}, status: "skipped", apiCalls: 0 };
			if (check.mode === "live" && !context.isLive) result.observed = { reason: "requires-live" };
			else {
				try { result.observed = await check.run(context); result.status = "pass"; }
				catch (error) {
					result.status = "fail";
					result.observed = error instanceof VerificationError ? { ...error.observed, errorCode: error.code } : { errorCode: "unexpected-check-error" };
					if (error instanceof EnvironmentError) hasEnvironmentError = true;
				}
			}
			result.apiCalls = context.apiCalls - startCalls;
			result = safeResult(result);
			report.checks.push(result);
			print(`${result.status}\t${result.name}\t${result.mode}`);
			if (hasEnvironmentError) break;
		}
		report.apiCalls = context.apiCalls;
		if (args.report) writeReport(args.report, report);
		const count = (status: CheckResult["status"]) => report!.checks.filter(check => check.status === status).length;
		print(`pass ${count("pass")} / fail ${count("fail")} / skipped ${count("skipped")} / apiCalls ${context.apiCalls}`);
		return hasEnvironmentError ? 2 : count("fail") ? 1 : 0;
	} catch (error) {
		const code = error instanceof VerificationError ? error.code : "verification-environment-error";
		print(`error: ${code}`);
		if (args?.report && report) {
			report.apiCalls = context.apiCalls;
			report.errorCode = code;
			try { writeReport(args.report, report); } catch { print("error: report-write-failed"); }
		}
		return 2;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCLI(process.argv.slice(2));
