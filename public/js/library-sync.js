/**
 * Optional bridge from the browser ledger to the native SQLite ledger.
 *
 * The screens intentionally keep their synchronous storage contract. This
 * module makes the server database the durable authority while keeping the
 * same front end usable against the old backend or from a static/browser-only
 * development session.
 *
 * @module library-sync
 */

const ENDPOINT = '/api/library';

function cloneRecords(records) {
  return Array.isArray(records) ? JSON.parse(JSON.stringify(records)) : [];
}

export function createLibrarySync({ getLocal, setLocal, onChange, onError }) {
  let enabled = false;
  let pending = null;
  let queuedBeforeSync = null;
  let inFlight = false;
  let retryTimer = null;
  let startPromise = null;

  function reportError(error) {
    try { onError?.(error); } catch (callbackError) { console.error('[library] error callback failed', callbackError); }
  }

  async function flush() {
    if (!enabled || inFlight || !pending) return;
    const snapshot = pending;
    pending = null;
    // An empty browser snapshot is not a valid synchronization command. It
    // can be the result of a new tab, private storage, or a stale app boot.
    // Clearing a populated library is an explicit action and passes
    // `allowEmpty` below.
    if (!snapshot.records.length && !snapshot.allowEmpty) return;
    inFlight = true;
    try {
      const response = await fetch(ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ records: snapshot.records, allowEmpty: snapshot.allowEmpty }),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`Library database answered ${response.status}.`);
    } catch (error) {
      pending = snapshot;
      reportError(error);
      if (!retryTimer) {
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          void flush();
        }, 5000);
      }
    } finally {
      inFlight = false;
      if (pending && !retryTimer) void flush();
    }
  }

  async function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      let response;
      try {
        response = await fetch(ENDPOINT, { cache: 'no-store' });
      } catch {
        // Browser-only and legacy deployments simply do not expose this route.
        return false;
      }
      if (!response.ok) return false;

      let payload;
      try { payload = await response.json(); } catch { return false; }
      if (!Array.isArray(payload?.records)) return false;

      const remote = cloneRecords(payload.records);
      // Read after the request returns. A song can finish while the initial
      // request is in flight, and that current local snapshot is the one we
      // want to migrate if this really is a new empty database.
      const local = cloneRecords(getLocal?.());
      const early = queuedBeforeSync;
      queuedBeforeSync = null;
      enabled = true;

      // A populated server ledger wins. A new empty database adopts a
      // populated browser ledger once, which makes upgrading from the old app
      // safe. An empty local snapshot is never sent as a replacement.
      if (remote.length) {
        pending = null;
        setLocal?.(remote);
        try { onChange?.(remote); } catch (error) { reportError(error); }
      } else {
        const candidate = early?.records.length || early?.allowEmpty
          ? early
          : { records: local, allowEmpty: false };
        pending = candidate.records.length || candidate.allowEmpty ? candidate : null;
        if (!pending) {
          setLocal?.([]);
          try { onChange?.([]); } catch (error) { reportError(error); }
        }
      }

      await flush();
      return true;
    })();
    return startPromise;
  }

  function queue(records, { allowEmpty = false } = {}) {
    const snapshot = { records: cloneRecords(records), allowEmpty: Boolean(allowEmpty) };
    if (!enabled) {
      // Keep writes made during the initial request for the migration decision;
      // do not let them race the server-authority check.
      queuedBeforeSync = snapshot;
      return;
    }
    pending = snapshot;
    void flush();
  }

  return { start, queue };
}
