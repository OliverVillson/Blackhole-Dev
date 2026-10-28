import { describe, expect, it } from "vitest";
import { RpcError } from "../src/main/helper";
import { settle, unwrap } from "../src/shared/invoke";

describe("bh:invoke envelope", () => {
  it("resolves values", async () => {
    const r = await settle(async () => ({ ok: true, report: 1 }));
    expect(r).toEqual({ ok: true, value: { ok: true, report: 1 } });
    expect(unwrap(r)).toEqual({ ok: true, report: 1 });
  });

  it("returns an expected helper error as data, without logging it", async () => {
    const logged: unknown[] = [];
    const r = await settle(() => Promise.reject(new RpcError(-32002, "open a model first (Analysis > Model, or anatomy.open)")), (e) => logged.push(e));
    expect(r).toEqual({ ok: false, error: { message: "open a model first (Analysis > Model, or anatomy.open)", code: -32002, data: undefined } });
    expect(logged).toEqual([]);
    expect(() => unwrap(r)).toThrow("open a model first");
  });

  it("logs an unexpected throw and still hands the renderer its message", async () => {
    const logged: unknown[] = [];
    const r = await settle(() => { throw new TypeError("boom"); }, (e) => logged.push(e));
    expect(logged).toHaveLength(1);
    expect(() => unwrap(r)).toThrow(/^boom$/);
  });
});
