import type { ClientSideConnection } from "@agentclientprotocol/sdk";
export type AgentConnection = Pick<
  ClientSideConnection,
  | "initialize"
  | "newSession"
  | "resumeSession"
  | "loadSession"
  | "prompt"
  | "cancel"
  | "setSessionConfigOption"
  | "request"
>;
export type PiStream = {
  writable: WritableStream<Uint8Array>;
  readable: ReadableStream<Uint8Array>;
};
