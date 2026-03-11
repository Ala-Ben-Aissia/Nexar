import http from 'node:http';
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

function sniffImageMagicBytes(bytes: Buffer | Uint8Array) {
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';

  // PNG: 89 50 4E 47
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return 'image/png';

  // GIF: 47 49 46
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return 'image/gif';

  // WEBP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
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

  // BMP: 42 4D
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';

  // TIFF: 49 49 2A 00 (little-endian) or 4D 4D 00 2A (big-endian)
  if (
    (bytes[0] === 0x49 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x2a &&
      bytes[3] === 0x00) ||
    (bytes[0] === 0x4d &&
      bytes[1] === 0x4d &&
      bytes[2] === 0x00 &&
      bytes[3] === 0x2a)
  )
    return 'image/tiff';

  // ISOBMFF container (AVIF, HEIC, HEIF) — check 'ftyp' box at offset 4
  // offset 4-7 must be 'ftyp': 66 74 79 70
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    // major brand at offset 8-11
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'heic' || brand === 'heix') return 'image/heic';
    if (brand === 'heif' || brand === 'mif1') return 'image/heif';
  }

  return null;
}

export function detectContentType(input: unknown, req?: http.IncomingMessage) {
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
    if (input.trimStart().startsWith('<svg')) return 'image/svg+xml';
  }

  // ── Object → JSON ─────────────────────────────────────────────────────────
  if (input !== null && typeof input === 'object') {
    return 'application/json';
  }

  // ── Fallback: trust request header, otherwise plain text ──────────────────
  const fromHeader = req?.headers['content-type']?.split(';')[0]?.trim();
  return fromHeader ?? 'text/plain';
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

export class NexarError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NexarError';
  }
}
