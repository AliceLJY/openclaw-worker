delete process.env.CLAUDECODE;
import { query } from "@anthropic-ai/claude-agent-sdk";
process.stderr.write("SDK loaded\n");
try {
  for await (const msg of query({ prompt: "say hi", options: { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, cwd: "/Users/anxianjingya" } })) {
    process.stderr.write(`MSG: ${msg.type} ${msg.subtype||""} ${(msg.result||"").slice(0,80)} ${JSON.stringify(msg.errors||[])}\n`);
  }
  process.stderr.write("DONE\n");
} catch(e) {
  process.stderr.write(`ERR: ${e.message}\n`);
}
