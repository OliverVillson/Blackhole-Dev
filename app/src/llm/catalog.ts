// Model and server presets. No SDK imports, so the renderer can use it too.
import type { Effort } from "./types";

export interface AnthropicModelInfo {
  id: string;
  label: string;
  /** One line shown under the picker. */
  blurb: string;
  /** Effort the copilot starts at for this model. */
  defaultEffort: Effort;
  /** Server-side refusal fallback (`fallbacks: "default"`). Haiku has none. */
  fallback: boolean;
}

export const ANTHROPIC_MODELS: readonly AnthropicModelInfo[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", blurb: "Best for recipes · $4 / $20 per M tokens", defaultEffort: "high", fallback: true },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", blurb: "Faster, half the price · $2 / $10 per M tokens", defaultEffort: "medium", fallback: true },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", blurb: "Quick questions, very cheap · $0.10 / $0.50 per M tokens", defaultEffort: "medium", fallback: false },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", blurb: "Most capable, slowest and priciest · $10 / $50 per M tokens", defaultEffort: "high", fallback: true },
];

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

export function anthropicModel(id: string): AnthropicModelInfo | undefined {
  return ANTHROPIC_MODELS.find((m) => m.id === id);
}

export interface ClaudeCodeModelInfo {
  /** Passed to `claude --model`; "default" leaves the choice to Claude Code. */
  id: string;
  label: string;
  blurb: string;
  defaultEffort: Effort;
}

/** Claude Code takes model aliases and resolves them to the newest model the plan allows. */
export const CLAUDE_CODE_MODELS: readonly ClaudeCodeModelInfo[] = [
  { id: "default", label: "Claude Code default", blurb: "Whatever your Claude Code is set to · uses your Claude plan's limits", defaultEffort: "high" },
  { id: "opus", label: "Opus (Claude Code)", blurb: "Best for recipes · uses your Claude plan's limits", defaultEffort: "high" },
  { id: "sonnet", label: "Sonnet (Claude Code)", blurb: "Faster, lighter on your plan's limits", defaultEffort: "medium" },
  { id: "haiku", label: "Haiku (Claude Code)", blurb: "Quick questions, lightest on your limits", defaultEffort: "medium" },
  { id: "fable", label: "Fable (Claude Code)", blurb: "Most capable where your plan includes it · heavy on limits", defaultEffort: "high" },
];

export function claudeCodeModel(id: string): ClaudeCodeModelInfo | undefined {
  return CLAUDE_CODE_MODELS.find((m) => m.id === id);
}

/** Every current Claude model takes all five levels. */
export const EFFORTS: readonly { id: Effort; label: string }[] = [
  { id: "low", label: "Low · fastest, cheapest" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max · slowest, most tokens" },
];

export const LOCAL_PRESETS = {
  mlx: { label: "mlx_lm.server", baseUrl: "http://127.0.0.1:8080/v1" },
  llamacpp: { label: "llama.cpp server", baseUrl: "http://127.0.0.1:8080/v1" },
  ollama: { label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
} as const;
