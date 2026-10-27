// Licence seam. BlackHole-Dev is open source (Apache-2.0) with nothing gated, so this allows
// everything; it stays the one place a check would go if that ever changes.

import type { Licence } from "../shared/ext";

export function status(): Licence {
  return { ok: true, tier: "dev", reason: "open source, Apache-2.0" };
}
