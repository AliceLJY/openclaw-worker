delete process.env.CLAUDECODE;
import { query } from "@anthropic-ai/claude-agent-sdk";
process.stderr.write("=== SDK Test Start ===\n");
try {
  for await (const msg of query({ 
    prompt: "say hello in Chinese, just 2 words", 
    options: { 
      model: "claude-opus-4-6",
      permissionMode: "bypassPermissions", 
      allowDangerouslySkipPermissions: true, 
      cwd: "/Users/anxianjingya" 
    } 
  })) {
    process.stderr.write(`[${msg.type}] sub=${msg.subtype||"-"} result=${(msg.result||"").slice(0,200)} errors=${JSON.stringify(msg.errors||[])} cost=${msg.total_cost_usd||"-"} duration=${msg.duration_ms||"-"} sid=${(msg.session_id||"").slice(0,8)}\n`);
  }
  process.stderr.write("=== Normal Exit ===\n");
} catch(e) {
  process.stderr.write(`=== CAUGHT ERROR ===\nMessage: ${e.message}\nName: ${e.name}\nCode: ${e.code||"-"}\n`);
}
