// ACP uses stdout for protocol messages. Keep diagnostics on stderr.
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

if (!process.env.CODEX_PATH?.trim()) {
  console.error('CODEX_PATH is required for the bundled Codex ACP adapter.');
  process.exit(1);
}

await import('@universal-agent/acp-extension-codex');

export {};
