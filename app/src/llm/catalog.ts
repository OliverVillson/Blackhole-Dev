// Model and server presets. No SDK imports, so the renderer can use it too.
export const ANTHROPIC_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
] as const;

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

export const LOCAL_PRESETS = {
  mlx: { label: "mlx_lm.server", baseUrl: "http://127.0.0.1:8080/v1" },
  llamacpp: { label: "llama.cpp server", baseUrl: "http://127.0.0.1:8080/v1" },
  ollama: { label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
} as const;
