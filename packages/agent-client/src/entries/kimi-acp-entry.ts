import { runKimiAcp } from '@universal-agent/acp-extension-kimi';

// ACP uses stdout for protocol messages. Keep diagnostics on stderr.
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

runKimiAcp();
