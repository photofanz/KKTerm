/** One close transaction per detached window; restore and disconnect cannot race. */
export function createRemoteFullscreenClose(actions: {
  announceInactive: () => Promise<void>;
  restore: () => Promise<void>;
  disconnect: () => Promise<void>;
  onFailure: (error: unknown) => Promise<void>;
}) {
  let closing = false;
  return async (restore = false) => {
    if (closing) return;
    closing = true;
    try {
      await actions.announceInactive();
      if (restore) await actions.restore();
      else await actions.disconnect();
    } catch (error) {
      try { await actions.onFailure(error); }
      finally { closing = false; }
    }
  };
}
