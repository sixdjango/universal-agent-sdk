// ACP uses stdout for protocol messages. Keep diagnostics on stderr.
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

await import('@universal-agent/acp-extension-pi/dist/index.js');

export {};
