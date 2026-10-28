import { describe, expect, it } from "vitest";
import { hubRepoFrom, splitError } from "../src/shared/errors";

const HF = "open model: cannot open recursive-si/flint-40b: 401 Client Error. (Request ID: Root=1-6ae20043-332290c94d5ce789084004e4;8a607011-7c99-426e-848e-daaf4d436ded) Repository Not Found for url: https://huggingface.co/recursive-si/flint-40b/resolve/main/config.json. Please make sure you specified the correct `repo_id` and `repo_type`. If you are trying to access a private or gated repo, make sure you are authenticated and your token has the required permissions. For more details, see https://huggingface.co/docs/huggingface_hub/authentication\nInvalid username or password.";

describe("splitError", () => {
  it("turns the Hugging Face 401 page into one line with the id and what to do", () => {
    const e = splitError(HF);
    expect(e.head).toBe("open model: cannot open recursive-si/flint-40b: this repo is gated or private on Hugging Face, or the id is wrong. Add a Hugging Face token in Settings");
    expect(e.more).toBe(true);
    expect(e.full).toBe(HF);
  });
  it("names the repo from the URL when the prefix does not", () => {
    const e = splitError("HfHubHTTPError: 401 Client Error: Unauthorized for url: https://huggingface.co/RecursiveSI/flint/resolve/main/config.json");
    expect(e.head).toContain("(tried RecursiveSI/flint)");
  });
  it("keeps short errors as they are", () => {
    expect(splitError("lint: 2 error(s)")).toEqual({ head: "lint: 2 error(s)", full: "lint: 2 error(s)", more: false });
  });
  it("shows the first line of a traceback and keeps the rest for details", () => {
    const e = splitError("plan failed: KeyError 'x'\nTraceback (most recent call last):\n  File ...");
    expect(e.head).toBe("plan failed: KeyError 'x'");
    expect(e.more).toBe(true);
  });
  it("cuts a very long single line at a word", () => {
    const e = splitError("word ".repeat(100));
    expect(e.head.length).toBeLessThanOrEqual(201);
    expect(e.head.endsWith("…")).toBe(true);
  });
  it("finds the repo in hub URLs", () => {
    expect(hubRepoFrom("see https://huggingface.co/Qwen/Qwen3.6-35B-A3B/resolve/main/x")).toBe("Qwen/Qwen3.6-35B-A3B");
    expect(hubRepoFrom("https://huggingface.co/docs/huggingface_hub/authentication")).toBeNull();
  });
});
