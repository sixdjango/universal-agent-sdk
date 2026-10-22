import { build } from 'rolldown';

await build({
  input: 'src/index.ts',
  platform: 'node',
  external: [/^@openai\/codex(\/.*)?$/],
  output: {
    file: 'dist/index.js',
    format: 'esm',
    codeSplitting: false,
    intro:
      "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
});


