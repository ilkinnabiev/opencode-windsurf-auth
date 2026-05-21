/**
 * Compatibility check between the running WindsurfAPI proxy and what
 * this plugin was last E2E-verified against.
 *
 * We never *block* on a version mismatch — upstream may legitimately
 * fix something in a minor that we haven't re-verified yet, and hard
 * blocking would force users to wait for a plugin release just to use
 * an upstream patch. Instead we surface a single, clear warning per
 * locator session so the user has somewhere to look when a request
 * starts behaving oddly after they updated the proxy.
 */

import { SUPPORTED_PROXY } from "../constants.js";
import { log } from "../logger.js";

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse `MAJOR.MINOR.PATCH` (with optional leading `v`). Pre-release
 * suffixes (`-rc1`, `+build7`) are stripped before parse — we only care
 * about the numeric ordering for the warn/info decision.
 *
 * Returns `null` for anything we can't confidently order against —
 * caller then skips the compat check rather than guessing.
 */
export function parseSemver(input: string | undefined | null): Semver | null {
  if (!input) return null;
  const stripped = input.trim().replace(/^v/i, "").split(/[-+]/)[0];
  const parts = stripped.split(".");
  if (parts.length < 3) return null;
  const [maj, min, pat] = parts;
  const major = Number(maj);
  const minor = Number(min);
  const patch = Number(pat);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/** -1 if a<b, 0 if equal, +1 if a>b. */
export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

export type CompatVerdict = "ok" | "older-than-min" | "newer-major" | "newer-minor" | "unknown";

export interface CompatResult {
  verdict: CompatVerdict;
  proxyVersion: string | null;
  /** Human-readable message — empty string for `ok` / `unknown`. */
  message: string;
}

/**
 * Compare the proxy's reported version against the window the plugin
 * was last verified against. Returns a verdict + a message ready for
 * the logger (empty when no action is warranted).
 */
export function evaluateProxyCompat(proxyVersion: string | undefined | null): CompatResult {
  const observed = parseSemver(proxyVersion);
  if (!observed) {
    // Either the proxy didn't report a version (very old build) or it
    // reported something we can't parse (custom fork). Stay silent — the
    // actual /health probe already confirmed the provider marker, so we
    // know we're talking to *some* WindsurfAPI. Anything more is noise.
    return {
      verdict: "unknown",
      proxyVersion: proxyVersion ?? null,
      message: "",
    };
  }

  const min = parseSemver(SUPPORTED_PROXY.MIN)!;
  const verified = parseSemver(SUPPORTED_PROXY.LAST_VERIFIED)!;
  // Normalise display: strip leading `v` so we never produce `vv2.0.97`.
  const display = proxyVersion!.trim().replace(/^v/i, "");

  if (compareSemver(observed, min) < 0) {
    return {
      verdict: "older-than-min",
      proxyVersion: display,
      message:
        `WindsurfAPI v${display} is older than the minimum this plugin was verified against ` +
        `(v${SUPPORTED_PROXY.MIN}). Some endpoints (e.g. /v1/messages tool_use, ` +
        `dashboard prompt-overrides) may behave differently. Upgrade upstream:\n` +
        `  cd <WindsurfAPI checkout> && git fetch --tags && git checkout v${SUPPORTED_PROXY.LAST_VERIFIED} && npm install`,
    };
  }

  if (observed.major !== verified.major) {
    return {
      verdict: "newer-major",
      proxyVersion: display,
      message:
        `WindsurfAPI v${display} is a MAJOR version ahead of what this plugin was verified ` +
        `against (v${SUPPORTED_PROXY.LAST_VERIFIED}). Breaking endpoint changes are likely. If you ` +
        `see request failures, pin upstream:\n` +
        `  cd <WindsurfAPI checkout> && git checkout v${SUPPORTED_PROXY.LAST_VERIFIED} && npm install`,
    };
  }

  if (compareSemver(observed, verified) > 0) {
    // Newer minor/patch — usually benign. Surface as info, not warn, so
    // we don't cry wolf every time the user updates.
    return {
      verdict: "newer-minor",
      proxyVersion: display,
      message:
        `WindsurfAPI v${display} is newer than the plugin's last verified version ` +
        `(v${SUPPORTED_PROXY.LAST_VERIFIED}). Should be fine; report issues at ` +
        `https://github.com/ilkinnabiev/opencode-windsurf-auth/issues if requests start failing.`,
    };
  }

  return { verdict: "ok", proxyVersion: display, message: "" };
}

/**
 * Emit a single compat log line for the given proxy version. Convenience
 * wrapper around `evaluateProxyCompat` + the structured logger. Returns
 * the verdict so callers (tests, diagnostics) can branch on it.
 */
export function logProxyCompat(proxyVersion: string | undefined | null): CompatVerdict {
  const result = evaluateProxyCompat(proxyVersion);
  switch (result.verdict) {
    case "older-than-min":
    case "newer-major":
      log.warn(result.message);
      break;
    case "newer-minor":
      log.info(result.message);
      break;
    case "ok":
    case "unknown":
      // Stay silent — `locateProxy` already logged the version in its
      // "connected to WindsurfAPI at ... (vX.Y.Z)" line.
      break;
  }
  return result.verdict;
}
