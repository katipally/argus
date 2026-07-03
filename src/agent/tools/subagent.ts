import type { AgentTool, RunnerConfig } from "../engine/runner";
import type { AgentEvent } from "../engine/events";
import { Runner } from "../engine/runner";
import { buildReadonlyTools } from "./index";
import { subagentPrompt } from "../prompt";

// spawn_subagent: a read-only child Runner sharing the same provider config.
// Depth is capped structurally — the child's toolset has no spawn tool. Child
// events carry the child sessionId so the dock nests them under the parent.

const MAX_CONCURRENT = 2;
let active = 0;
let seq = 0;

export function makeSubagentTool(getConfig: () => RunnerConfig, emit: (e: AgentEvent) => void, parentId: string): AgentTool {
  return {
    name: "spawn_subagent",
    description:
      "Spawn a read-only reconnaissance subagent for one focused sub-question (it can query layers, sitreps, places, crime — it cannot move the map). Returns its findings. Use for parallelizable research, not for actions.",
    parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
    async run({ task }) {
      const t = String(task ?? "").trim();
      if (!t) return "Error: task required.";
      if (active >= MAX_CONCURRENT) return "Error: subagent limit reached — wait for running subagents to finish.";
      active++;
      const childId = `${parentId}/sub-${++seq}`;
      emit({ type: "subagent-start", sessionId: parentId, childId, task: t });
      try {
        const child = new Runner({
          sessionId: childId,
          config: getConfig(),
          tools: buildReadonlyTools(),
          emit,
          systemPrompt: () => subagentPrompt(t),
        });
        const answer = await child.run(t);
        return answer || "(subagent returned no text)";
      } catch (e) {
        return `Subagent error: ${(e as Error).message}`;
      } finally {
        active--;
        emit({ type: "subagent-done", sessionId: parentId, childId });
      }
    },
  };
}
