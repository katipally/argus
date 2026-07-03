import type { Effort } from "../shared/types"

/** Map a reasoning effort level to a thinking token budget (Anthropic / Google). */
export function thinkingBudget(effort?: Effort): number {
  switch (effort) {
    case "low":
      return 2048
    case "medium":
      return 4096
    case "high":
      return 8192
    case "xhigh":
      return 12288
    case "max":
      return 16384
    default:
      return 0
  }
}
