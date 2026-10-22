#!/usr/bin/env node
import { Writable } from "node:stream";
import { createInterface } from "node:readline";

import {
  DevinAcpProxy,
  type JsonRpcMessage,
  type ProxyOutput,
} from "./proxy.js";
import { spawnDevinRuntime } from "./runtime-process.js";

const devinPath = process.env.DEVIN_PATH;
if (!devinPath) {
  console.error("DEVIN_PATH must point to the official Devin runtime");
  process.exit(1);
}

const child = spawnDevinRuntime(devinPath);
const proxy = new DevinAcpProxy();

if (!child.stdin || !child.stdout) {
  console.error("Official Devin runtime stdio is not piped");
  process.exit(1);
}
const childStdin = child.stdin;
const childStdout = child.stdout;

function exit(code: number) {
  process.stdout.write("", () => process.exit(code));
}

function write(stream: Writable, message: JsonRpcMessage) {
  stream.write(`${JSON.stringify(message)}\n`);
}

function dispatch(output: ProxyOutput) {
  for (const message of output.toRuntime) write(childStdin, message);
  for (const message of output.toClient) write(process.stdout, message);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  try {
    dispatch(proxy.handleClient(JSON.parse(line)));
  } catch (error) {
    console.error(
      `Invalid ACP client message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});

createInterface({ input: childStdout }).on("line", (line) => {
  try {
    dispatch(proxy.handleRuntime(JSON.parse(line)));
  } catch (error) {
    console.error(
      `Invalid Devin runtime message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});

process.stdin.on("end", () => childStdin.end());
child.on("error", (error) => {
  console.error(`Failed to launch official Devin runtime: ${error.message}`);
  exit(1);
});
child.on("close", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else exit(code ?? 1);
});
