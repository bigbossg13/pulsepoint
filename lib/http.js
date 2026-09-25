// Small fetch wrapper with timeouts and retry/backoff for flaky or
// rate-limited upstream APIs.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson(url, { retries = 3, timeoutMs = 60_000, ...init } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status >= 500) {
        throw Object.assign(new Error(`HTTP ${res.status} from ${url}`), { retryable: true });
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 1000)}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      const retryable = err.retryable || err.name === "TimeoutError" || err.name === "TypeError";
      if (!retryable || attempt === retries) break;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastError;
}

export { sleep };
