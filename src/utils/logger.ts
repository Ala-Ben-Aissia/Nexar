import { IncomingMessage } from 'node:http';
import { HttpMethod } from './types.js';

export const color = {
  // modifiers
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,

  // semantic
  green: (s: string) => `\x1b[32m${s}\x1b[0m`, // 2xx
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, // 3xx
  red: (s: string) => `\x1b[31m${s}\x1b[0m`, // 4xx / 5xx
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`, // duration, meta

  // accent
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`, // GET
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`, // POST
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`, // PUT / PATCH / server url
} as const;

const METHOD_COLORS: Record<string, (s: string) => string> = {
  GET: color.blue, // safe, read-only → calm blue
  POST: color.green, // creating something → green
  PUT: color.yellow, // replacing, caution → yellow
  PATCH: color.magenta, // partial change → magenta
  DELETE: color.red, // destructive → red
};

export function colorMethod(method: string): string {
  return (METHOD_COLORS[method] ?? color.gray)(method);
}

export function extractRequestInfo(req: IncomingMessage) {
  const method = (req.method ?? 'GET').toUpperCase() as HttpMethod;
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams);

  return { method, pathname, query };
}

function colorStatus(code: number): string {
  if (code < 300) return color.green(String(code));
  if (code < 400) return color.cyan(String(code));
  if (code < 500) return color.yellow(String(code));
  return color.red(String(code));
}

export const logger = {
  /**
   * Log an incoming request after it finishes.
   *
   * @example
   * res.on('finish', () => logger.request(method, pathname, res.statusCode, duration));
   */
  request(
    method: string,
    pathname: string,
    status: number,
    durationMs: number,
  ) {
    console.log(
      `${colorMethod(method)} ${pathname} ${colorStatus(status)} ${color.gray(durationMs.toFixed() + 'ms')}`,
    );
  },

  /**
   * Log server start.
   *
   * @example
   * app.listen(port, host, () => logger.start(host, port));
   */
  start(host: string, port: number) {
    console.log(
      color.green('✓ Server started') +
        color.gray(' listening at ') +
        color.cyan(`http://${host}:${port}`),
    );
  },

  /**
   * Log a caught error.
   *
   * @example
   * catch (e) { logger.error(e) }
   */
  error(e: unknown) {
    const isError = e instanceof Error;
    const message = isError ? e.message : String(e);
    const name = isError ? e.name : 'Error';
    const stack =
      isError && e.stack
        ? color.gray('\n' + e.stack.split('\n').slice(1).join('\n'))
        : '';
    const cause =
      isError && e.cause !== undefined
        ? color.gray('\nCaused by: ') + String(e.cause)
        : '';

    console.error(
      color.red(color.bold(`✗ ${name}`)) + ' ' + message + cause + stack,
    );
  },
};
