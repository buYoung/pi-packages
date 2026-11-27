import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAction } from "../../dist/contracts.js";
import {
    PolicyEngine,
    validateSettings,
} from "../../dist/policy/index.js";
import {
    CODEX_EXECPOLICY_REVISION,
    evaluateRules,
    matchesRule,
    parseRules,
} from "../../dist/policy/rules.js";
import { fixture } from "../harness/fixtures.mjs";

// Ported boundaries from Codex a956835d/execpolicy parser, host_executable and network-rule tests.
test("[rules] Codex Starlark functions, comprehensions, f-strings and tuple examples reach actual matching", async () => {
    const source = `
def read_rule(program):
    choices = [f"{value}" for value in ["show", "status"]]
    prefix_rule(pattern=[program, choices], decision="allow",
        match=[["git", "status", "--short"], "git show"], not_match=["git push"])
read_rule("git")
prefix_rule(pattern=["git", "show", "secret"], decision="forbidden", justification="private")
`;
    const result = await evaluateRules(
        [{ name: "generated.rules", source }],
        [
            ["git", "status", "--short"],
            ["git", "push"],
            ["git", "show", "secret"],
        ],
    );
    expect(result.revision).toBe(CODEX_EXECPOLICY_REVISION);
    expect(result.matches[0][0].decision).toBe("allow");
    expect(result.matches[1].length).toBe(0);
    expect(
        result.matches[2].some((rule) => rule.decision === "forbidden"),
    ).toBeTruthy();
    expect(() =>
        parseRules(`${source}\nprefix_rule(pattern=["x"], not_match=[["x"]])`),
    ).toThrow(/INVALID_RULES|rule engine/);
    expect(() => parseRules('load("external.star", "rule")\nrule()')).toThrow();
});

test("[rules] host executable constraints reject aliases and preserve exact-path precedence", async () => {
    const program =
        process.platform === "win32" ? "C:/Tools/git.exe" : "/usr/bin/git";
    const other =
        process.platform === "win32" ? "C:/Other/git.exe" : "/other/git";
    const source = `host_executable(name="git", paths=[${JSON.stringify(program)}])
prefix_rule(pattern=["git", "status"], decision="allow")
prefix_rule(pattern=[${JSON.stringify(program)}, "push"], decision="forbidden")`;
    const result = await evaluateRules(
        [{ name: "host.rules", source }],
        [
            [program, "status"],
            [other, "status"],
            [program, "push"],
            ["git", "status"],
        ],
    );
    expect(result.matches[0][0].decision).toBe("allow");
    expect(result.matches[1].length).toBe(0);
    expect(result.matches[2][0].decision).toBe("forbidden");
    expect(result.matches[3][0].decision).toBe("allow");
});

// Ported from Codex 3d86e43b/execpolicy/tests/basic.rs (canonical_matching, #59535). JavaScript
// escapes keep precomposed and decomposed spellings distinct; \\u0345 passes a Starlark escape through.
const canonicalRules = `
prefix_rule(pattern=[["Tool", "bash"], "Run", ["ONE", "two", "set"]], canonical_matching=True,
            match=["TOOL rUn Two extra", "bA\u{17f}h RUN one", "bash run \u{17f}et"],
            not_match=["TOOL run three", "tool runner two"])
prefix_rule(pattern=["caf\u{e9}", ["r\u{e9}sum\u{e9}", "run"]], canonical_matching=True,
            match=["CAFE\u{301} RE\u{301}SUME\u{301}"], not_match=["cafe resume", "\u{ff43}af\u{e9} r\u{e9}sum\u{e9}"])
# Full case folding can expand one character into two, within a single token.
prefix_rule(pattern=["stra\u{df}e"], canonical_matching=True,
            match=["STRASSE"], not_match=["STRAS SE"])
# U+0345 folds to a spacing iota. Reorder the acute accent before folding
# so it stays attached to the alpha.
prefix_rule(pattern=["\u{3b1}\\u0345\\u0301"], canonical_matching=True,
            match=["\u{3ac}\u{3b9}"], not_match=["\u{3b1}\u{3af}"])
prefix_rule(pattern=["caf\u{e9}"], not_match=["cafe\u{301}"])
prefix_rule(pattern=["set-content"], canonical_matching=True, not_match=["set-c\u{f8}ntent"])
prefix_rule(pattern=["bash"], not_match=["ba\u{17f}h"])
prefix_rule(pattern=["Tool", "Run"], not_match=["tool Run", "Tool run"])
`;

test("[rules] canonical_matching compares every prefix token with Unicode canonical caseless matching", async () => {
    const result = await evaluateRules(
        [{ name: "case.rules", source: canonicalRules }],
        [
            ["TOOL", "rUn", "Two", "extra"],
            ["STRASSE"],
            ["BASH"],
            ["Tool", "Run"],
            ["tool", "Run"],
        ],
    );
    expect(result.matches[0]).toStrictEqual([
        {
            decision: "allow",
            justification: null,
            matchedPrefix: ["TOOL", "rUn", "Two"],
            resolvedProgram: null,
        },
    ]);
    expect(result.matches[1][0].matchedPrefix).toStrictEqual(["STRASSE"]);
    // Windows resolves the program name case-insensitively before an exact rule compares it.
    expect(result.matches[2].length).toBe(process.platform === "win32" ? 1 : 0);
    expect(result.matches[3].length).toBe(1);
    expect(result.matches[4].length).toBe(0);
    expect(
        result.rules.filter((rule) => rule.canonicalMatching).length,
    ).toBe(6);
    expect(
        parseRules('prefix_rule(pattern=["git"], canonical_matching=False)'),
    ).toStrictEqual([{ pattern: ["git"], decision: "allow" }]);
    for (const source of [
        'prefix_rule(pattern=["git"], canonical_matching="yes")',
        'prefix_rule(pattern=["git"], canonical_matching=1)',
        'prefix_rule(pattern=["git"], canonical_matching=True, not_match=["GIT"])',
    ])
        await expect(
            evaluateRules([{ name: "invalid.rules", source }]),
        ).rejects.toThrow(expect.objectContaining({ code: "INVALID_RULES" }));
    const [rule] = parseRules(
        'prefix_rule(pattern=["git", "push"], canonical_matching=True)',
    );
    expect(matchesRule(["GIT", "PUSH", "origin"], rule)).toBe(true);
    expect(matchesRule(["git", "pull"], rule)).toBe(false);
});

test("[rules] canonical host executable resolution uses only the relevant declarations", async () => {
    const path = (name) =>
        process.platform === "win32" ? `C:/Tools/${name}.exe` : `/usr/bin/${name}`;
    const bash = path("bash"),
        longS = path("ba\u{17f}h");
    const source = `prefix_rule(pattern=["bash"], canonical_matching=True, decision="forbidden",
            match=[[${JSON.stringify(bash)}]], not_match=[[${JSON.stringify(longS)}]])
host_executable(name="bash", paths=[${JSON.stringify(bash)}])
host_executable(name="ba\u{17f}h", paths=[${JSON.stringify(longS)}])`;
    const result = await evaluateRules(
        [{ name: "host.rules", source }],
        [[bash, "-c", "true"], [longS], [path("BASH")]],
    );
    expect(result.matches[0][0].decision).toBe("forbidden");
    expect(result.matches[1].length).toBe(0);
    expect(result.matches[2].length).toBe(0);
    const undeclared = await evaluateRules(
        [
            {
                name: "undeclared.rules",
                source: 'prefix_rule(pattern=["bash"], canonical_matching=True, decision="forbidden")',
            },
        ],
        [[path("BASH")]],
    );
    expect(undeclared.matches[0][0].resolvedProgram).toBeTruthy();
});

test("[rules] a canonical forbidden rule denies differently cased commands through the policy engine", async (t) => {
    const f = await fixture(t);
    const path = join(f.control, "case.rules");
    await writeFile(
        path,
        'prefix_rule(pattern=["git", "push"], canonical_matching=True, decision="forbidden", justification="no pushes")\n',
    );
    const policy = new PolicyEngine(
        validateSettings({ ruleFiles: [path] }),
        f.profile,
    );
    await policy.initialize(f.workspace);
    const action = (command) =>
        createAction(
            {
                toolCallId: "canonical-rule",
                tool: "bash",
                args: { command },
                cwd: f.workspace,
                source: "model",
                sessionId: "s",
                policyRevision: policy.revision,
            },
            policy.profile,
        );
    const denied = await policy.evaluate(action("GIT Push origin"));
    expect(denied.kind).toBe("deny");
    expect(denied.isHardDeny).toBe(true);
    expect((await policy.evaluate(action("git status"))).kind).not.toBe(
        "deny",
    );
});

test("[rules] all network_rule protocols and overlay ordering reach approval policy", async (t) => {
    const f = await fixture(t);
    const paths = [
        join(f.control, "base.rules"),
        join(f.control, "overlay.rules"),
    ];
    await writeFile(
        paths[0],
        `
network_rule(host="api.example.com", protocol="https", decision="allow")
network_rule(host="blocked.example.com", protocol="http", decision="forbidden")
network_rule(host="tcp.example.com", protocol="socks5_tcp", decision="allow")
network_rule(host="udp.example.com", protocol="socks5_udp", decision="forbidden")
network_rule(host="[::1]:443", protocol="https", decision="allow")
`,
    );
    await writeFile(
        paths[1],
        `
network_rule(host="api.example.com", protocol="https_connect", decision="forbidden")
network_rule(host="api.example.com", protocol="http-connect", decision="allow")
network_rule(host="prompt.example.com", protocol="https", decision="prompt")
`,
    );
    const policy = new PolicyEngine(
        validateSettings({ ruleFiles: paths }),
        f.profile,
    );
    await policy.initialize(f.workspace);
    const action = (host) =>
        createAction(
            {
                toolCallId: "network-rule",
                tool: "bash",
                args: { command: `curl ${JSON.stringify(`https://${host}`)}` },
                cwd: f.workspace,
                source: "model",
                sessionId: "s",
                policyRevision: policy.revision,
            },
            policy.profile,
        );
    expect((await policy.evaluate(action("api.example.com"))).kind).toBe(
        "allow",
    );
    expect(
        (await policy.evaluate(action("blocked.example.com"))).isHardDeny,
    ).toBe(true);
    expect((await policy.evaluate(action("prompt.example.com"))).kind).toBe(
        "ask",
    );
    expect(
        policy.profile.allowedDomains.includes("tcp.example.com"),
    ).toBeTruthy();
    expect(
        policy.profile.deniedDomains.includes("udp.example.com"),
    ).toBeTruthy();
    expect(
        policy.profile.deniedDomains.includes("api.example.com"),
    ).toBeFalsy();
    expect(policy.profile.allowedDomains.includes("::1")).toBeTruthy();
    expect((await policy.evaluate(action("[::1]"))).kind).toBe("allow");
});

test("[rules] malformed rules, cancelled evaluation and oversized requests fail closed", async () => {
    await expect(
        evaluateRules([
            {
                name: "bad.rules",
                source: 'network_rule(host="ok.example", protocol="smtp", decision="allow")',
            },
        ]),
    ).rejects.toThrow(/rule engine/);
    const controller = new AbortController();
    controller.abort();
    await expect(
        evaluateRules(
            [{ name: "empty.rules", source: "" }],
            [],
            controller.signal,
        ),
    ).rejects.toThrow();
    await expect(
        evaluateRules([
            { name: "large.rules", source: "#".repeat(9 * 1024 * 1024) },
        ]),
    ).rejects.toThrow(/size/);
});
