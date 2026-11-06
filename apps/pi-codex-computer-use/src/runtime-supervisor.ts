import { spawn } from "node:child_process";

/**
 * Runs one command with inherited stdio, so the MCP connection passes through unchanged.
 *
 * Desktop's Computer Use service authenticates its IPC peer through the sender's process ancestry.
 * Pi starts this supervisor from `cua_node/bin/node`, which keeps a Desktop-signed process between
 * Pi and the runtime (`runtime.ts` decides when, `connection.ts` builds the command line). The
 * runtime itself would otherwise be the child of Pi's own Node process and be rejected.
 */
const [command, ...args] = process.argv.slice(2);
if (!command) {
    process.stderr.write("runtime-supervisor: no command to run\n");
    process.exit(2);
}

const child = spawn(command, args, { stdio: "inherit" });
child.on("error", (error) => {
    process.stderr.write(`runtime-supervisor: ${error.message}\n`);
    process.exit(127);
});
// Pi closes the transport by signalling the supervisor; the runtime must not outlive it.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
