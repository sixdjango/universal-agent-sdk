#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { createRequire } from "node:module";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { discoverPiExtensions } from "./extensions.js";
import { serve } from "./server.js";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--list-extensions") {
  try {
    process.stdout.write(JSON.stringify(await discoverPiExtensions()) + "\n");
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.message : String(error)) + "\n",
    );
    process.exitCode = 1;
  }
} else {
  // Own the OS process tree before Pi (or any descendant) can start when native addon is available.
  if (process.platform === "win32") {
    try {
      createRequire(import.meta.url)(
        `../native/win32-${process.arch}.node`,
      ).join();
    } catch {
      // Fallback to standard process tree termination when bundled without native .node addon
    }
  }
  const server = serve(
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
    args,
  );
  void server.closed.then(() => process.exit(process.exitCode ?? 0));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void server.close();
    });
  }
}
