// The wire shape of window.bh.invoke. A handler that throws inside ipcMain.handle makes Electron
// print "Error occurred in handler for 'bh:invoke'" with a stack, even for expected answers such
// as "open a model first" (-32002) or a recipe error. So main always resolves with an envelope
// and the preload rethrows the error in the renderer. (Only the message survives contextBridge,
// so a panel that must tell an expected state apart asks its main handler to return it as data.)

export type InvokeResult = { ok: true; value: unknown } | { ok: false; error: { message: string; code?: number; data?: unknown } };

/** True for a JSON-RPC error the helper answered on purpose (any code), as opposed to a crash. */
export function isRpcAnswer(e: unknown): e is { message: string; code: number; data?: unknown } {
  return e instanceof Error && typeof (e as { code?: unknown }).code === "number";
}

export async function settle(run: () => unknown, onUnexpected?: (e: unknown) => void): Promise<InvokeResult> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    if (isRpcAnswer(e)) return { ok: false, error: { message: e.message, code: e.code, data: e.data } };
    onUnexpected?.(e);
    return { ok: false, error: { message: String((e as Error)?.message ?? e) } };
  }
}

/** Renderer side: the value, or the error rethrown. */
export function unwrap(res: InvokeResult): unknown {
  if (res.ok) return res.value;
  throw new Error(res.error.message || "failed with no message");
}
