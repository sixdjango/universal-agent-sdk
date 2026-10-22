import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";

if (process.platform !== "win32")
  throw new Error("Build the Windows addon on Windows");
execFileSync(
  process.execPath,
  ["node_modules/node-gyp/bin/node-gyp.js", "rebuild", "--directory", "native"],
  { stdio: "inherit" },
);
copyFileSync(
  "native/build/Release/job.node",
  `native/win32-${process.arch}.node`,
);
