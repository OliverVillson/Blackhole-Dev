import type { BhBridge } from "../shared/ext";
import type { HelperMethod, HelperParams, HelperResult } from "../shared/rpc";

export const bh: BhBridge = (window as unknown as { bh: BhBridge }).bh;

export function helper<M extends HelperMethod>(method: M, params: HelperParams<M>): Promise<HelperResult<M>> {
  return bh.invoke("helper:call", method, params);
}
