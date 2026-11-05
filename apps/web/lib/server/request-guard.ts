// The app has no login: it relies on binding to loopback. These checks keep other websites from
// using the browser to reach it: the Host check defeats DNS rebinding, and the Origin check blocks
// cross-site requests to state-changing endpoints.

// Hostnames are case-insensitive; IPv6 loopback appears in brackets in the Host header.
const loopbackHostPattern = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

export type RequestGuardFailure = {
  code: 'forbidden_host' | 'forbidden_origin';
  message: string;
};

/** True when a Host header names a loopback address (with an optional port) and nothing else. */
export const isLoopbackHost = (host: string | null): host is string =>
  host !== null && loopbackHostPattern.test(host);

/** Rejects requests that were not addressed to a loopback host. */
export const checkHost = (headers: Headers): RequestGuardFailure | undefined =>
  isLoopbackHost(headers.get('host'))
    ? undefined
    : { code: 'forbidden_host', message: 'Requests must be addressed to the local application.' };

/**
 * For state-changing requests: the Host must be loopback and the browser-supplied Origin must be
 * exactly this application's origin. A missing Origin is rejected, so non-browser clients must
 * send one explicitly.
 */
export const checkMutationRequest = (headers: Headers): RequestGuardFailure | undefined => {
  const hostFailure = checkHost(headers);
  if (hostFailure !== undefined) {
    return hostFailure;
  }
  const host = headers.get('host')?.toLowerCase();
  const origin = headers.get('origin')?.toLowerCase();
  if (origin === undefined || origin !== `http://${host}`) {
    return {
      code: 'forbidden_origin',
      message: 'Changes are accepted only from the AI Agent Manager web app.',
    };
  }
  return undefined;
};

const crossOriginFailure: RequestGuardFailure = {
  code: 'forbidden_origin',
  message: 'Repository content is available only to the AI Agent Manager web app.',
};

/**
 * For reads that return repository content (review diffs): the Host must be loopback, and a
 * request that a browser marks as cross-origin is rejected. Same-origin `fetch` GETs usually send
 * no Origin, so a missing Origin is allowed; a present Origin must be this application's origin,
 * and `Sec-Fetch-Site` (when sent) must be `same-origin` or `none` (typed URL, bookmark).
 */
export const checkContentRead = (headers: Headers): RequestGuardFailure | undefined => {
  const hostFailure = checkHost(headers);
  if (hostFailure !== undefined) {
    return hostFailure;
  }
  const site = headers.get('sec-fetch-site')?.toLowerCase();
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return crossOriginFailure;
  }
  const origin = headers.get('origin')?.toLowerCase();
  if (origin !== undefined && origin !== `http://${headers.get('host')?.toLowerCase()}`) {
    return crossOriginFailure;
  }
  return undefined;
};
