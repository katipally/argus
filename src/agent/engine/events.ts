// Engine → UI events, the Friday bus contract trimmed to what the dock renders.

export type AgentEvent =
  | { type: "message-start"; sessionId: string }
  | { type: "text"; sessionId: string; delta: string }
  | { type: "reasoning"; sessionId: string; delta: string }
  | { type: "tool-call"; sessionId: string; callId: string; name: string; input: unknown }
  | { type: "tool-result"; sessionId: string; callId: string; output: string; isError: boolean }
  | { type: "subagent-start"; sessionId: string; childId: string; task: string }
  | { type: "subagent-done"; sessionId: string; childId: string }
  | { type: "usage"; sessionId: string; input: number; output: number }
  | { type: "turn-done"; sessionId: string }
  | { type: "error"; sessionId: string; message: string };
