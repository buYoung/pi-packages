export const CODEX_EXECPOLICY_REVISION =
    "3d86e43b075adeba2193ec5c22ac92f55afd82e6";
export interface PrefixRule {
    readonly pattern: readonly (string | readonly string[])[];
    readonly decision: "allow" | "prompt" | "forbidden";
    readonly justification?: string;
    /** Set by `canonical_matching=True`: every token uses Unicode canonical caseless comparison. */
    readonly canonicalMatching?: boolean;
}
export interface RuleSource {
    readonly name: string;
    readonly source: string;
}
export interface RuleMatch {
    readonly decision: PrefixRule["decision"];
    readonly justification?: string | null;
    readonly matchedPrefix: readonly string[];
    readonly resolvedProgram?: string | null;
}
export interface CompiledRules {
    readonly revision: string;
    readonly rules: readonly PrefixRule[];
    readonly matches: readonly (readonly RuleMatch[])[];
    readonly allowedDomains: readonly string[];
    readonly deniedDomains: readonly string[];
    readonly networkRules: readonly {
        host: string;
        protocol: string;
        decision: PrefixRule["decision"];
        justification?: string | null;
    }[];
    readonly hostExecutables: Readonly<Record<string, readonly string[]>>;
}
