import type { Readable, Writable } from 'node:stream';
import type { HttpMethod, Route } from './types.js';

export function safeWrite(
  readable: Readable,
  writable: Writable,
  chunk: unknown,
) {
  if (!writable.write(chunk)) {
    readable.pause();
    writable.on('drain', () => readable.resume());
  }
}

const HTML_RE =
  /^\s*(?:<!doctype\s+html|<html[\s>]|<[a-z][\w-]*(?:\s[^>]*)?>)/i;
const CSS_RE = /^\s*([.#:@*a-z][\w\s,>~+:.[\]()="'-]*\{[\s\S]*?\})/i;

// JPEG: FF D8 FF — PNG: 89 50 4E 47 — GIF: 47 49 46 — WEBP: 52 49 46 46…57 45 42 50
function sniffImageMagicBytes(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return 'image/gif';
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image/webp';
  return null;
}

export function detectContentType(input: unknown) {
  // ── Binary buffers ────────────────────────────────────────────────────────
  if (input instanceof ArrayBuffer || input instanceof Uint8Array) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    return sniffImageMagicBytes(bytes) ?? 'application/octet-stream';
  }

  if (Buffer.isBuffer(input)) {
    const bytes = new Uint8Array(
      input.buffer,
      input.byteOffset,
      input.byteLength,
    );
    return sniffImageMagicBytes(bytes) ?? 'application/octet-stream';
  }

  // ── Strings ───────────────────────────────────────────────────────────────
  if (typeof input === 'string') {
    if (HTML_RE.test(input)) return 'text/html';
    if (CSS_RE.test(input)) return 'text/css';

    // SVG is XML/text — check before falling back to plain text
    if (input.trimStart().startsWith('<svg')) return 'image/svg+xml';
  }

  // ── Json ───────────────────────────────────────────────────────────────
  if (typeof input === 'object' && typeof input !== null) {
    return 'application/json';
  }

  return 'text/plain';
}

export function validateStatus(code: number) {
  if (!Number.isInteger(code)) {
    return {
      error: new TypeError(
        `Invalid status code: ${JSON.stringify(code)}. Status code must be an integer.`,
      ),
    };
  }
  if (code < 100 || code > 999) {
    return {
      error: new RangeError(
        `Invalid status code: ${JSON.stringify(code)}. Status code must be greater than 99 and less than 1000.`,
      ),
    };
  }
  return {};
}

export function validateJson(input: unknown) {
  if (typeof input === 'function' || typeof input === 'bigint') {
    return { error: new TypeError(`Cannot serialize ${typeof input}`) };
  }
  try {
    const data = JSON.stringify(input);
    return { data };
  } catch (e) {
    return { error: e instanceof Error ? e : new TypeError(String(e)) };
  }
}

export function compilePath<Params extends string = never>(path: string) {
  const paramNames: Params[] = [];
  const regexStr = path
    .replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    })
    .replace(/\//g, '\\/');
  return { regex: new RegExp(`^${regexStr}\\/?$`), paramNames };
}

type MatchSuccess = {
  success: true;
  route: Route;
  params: Record<string, string>;
};

type MatchError = {
  success: false;
  error: string;
  code: number;
};

type MatchResult = MatchSuccess | MatchError;

export function matchRoute(
  pathname: string,
  routes: Route[],
  method: HttpMethod,
): MatchResult {
  let methodMismatch = false;

  for (const route of routes) {
    const match = pathname.match(route.regex);
    if (!match) continue;

    if (route.method !== method) {
      methodMismatch = true;
      continue;
    }

    const params = Object.fromEntries(
      route.paramNames.map((name, i) => [name, match[i + 1]]),
    );
    return { success: true, route, params };
  }

  return methodMismatch
    ? { success: false, error: 'Method Not Allowed', code: 405 }
    : { success: false, error: 'Not Found', code: 404 };
}
