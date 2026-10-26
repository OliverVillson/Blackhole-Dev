// Licence seam. The paywall is undecided, so this allows everything. Every paid feature asks
// this one function, so the real check can drop in here later.

import type { Licence } from "../shared/ext";

export function status(): Licence {
  return { ok: true, tier: "dev", reason: "no licence check yet" };
}
