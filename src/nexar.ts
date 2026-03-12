import http from 'node:http';
import {
  compilePath,
  detectContentType,
  matchRoute,
  NexarError,
  safeWrite,
  validateJson,
  validateStatus,
} from './utils/index.js';
import { logger } from './utils/logger.js';
import {
  BodyPayload,
  ErrorHandler,
  Middleware,
  MiddlewareStack,
  type ExtractParams,
  type HttpMethod,
  type Route,
  type RouteHandler,
} from './utils/types.js';

function stringifyError(error: Error) {
  const { message, name, cause, stack } = error;
  return JSON.stringify({ message, name, cause, stack });
}

const proto: http.ServerResponse = http.ServerResponse.prototype;

proto.json = function (input: unknown) {
  if (this.writableEnded) return this;
  this.setHeader('content-type', 'application/json; charset=utf-8');
  if (input === undefined) return this.end();
  const { error, data } = validateJson(input);
  if (error) {
    logger.error(error);
    return this.status(400).end(stringifyError(error));
  }
  safeWrite(this.req, this, data);
  return this.end();
};

proto.status = function (code: number) {
  const { error } = validateStatus(code);
  if (error) {
    logger.error(error);
    this.statusCode = 400;
    this.setHeader('content-type', 'application/json; charset=utf-8');
    return this.end(stringifyError(error));
  }
  this.statusCode = code;
  return this;
};

proto.send = function (input: any) {
  if (input === undefined) return this;
  if (this.writableEnded) return this;

  if (!this.getHeader('content-type')) {
    const type = detectContentType(input, this.req);
    this.setHeader('content-type', type);
  }

  const body =
    input instanceof ArrayBuffer
      ? Buffer.from(input)
      : input instanceof Uint8Array
        ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
        : typeof input === 'string' || Buffer.isBuffer(input)
          ? input
          : JSON.stringify(input);

  const length = Buffer.byteLength(body);
  this.setHeader('content-length', length);
  if (this.req.method === 'HEAD') return this.end();
  safeWrite(this.req, this, body);
  return this.end();
};

export default class Nexar {
  private server: http.Server;
  private routes: Route[];
  private middlewares: MiddlewareStack;

  constructor() {
    this.server = http.createServer(this.handleRequest.bind(this));
    this.routes = [];
    this.middlewares = [];
  }

  private parseBody(req: http.IncomingMessage) {
    const MAX_BODY = 1_000_000; // 1MB
    let size = 0;
    return new Promise<BodyPayload>((resolve, reject) => {
      let resolved = false;
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          return reject(new NexarError(413, 'Payload too large'));
        }
        chunks.push(chunk);
      });
      req.on('close', () => {
        if (!resolved && req.readableAborted)
          return reject(new NexarError(400, 'Request aborted'));
      });
      req.on('end', () => {
        resolved = true;
        const raw = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] ?? '';
        if (contentType.includes('application/json')) {
          try {
            return resolve(JSON.parse(raw.toString('utf-8')));
          } catch {
            return reject(new NexarError(400, 'Invalid JSON body'));
          }
        }
        if (contentType.includes('application/x-www-form-urlencoded')) {
          return resolve(
            Object.fromEntries(new URLSearchParams(raw.toString('utf-8'))),
          );
        }
        if (contentType.includes('text/')) {
          return resolve(raw.toString('utf-8'));
        }
        return resolve(raw);
      });
      req.on('error', (err) => {
        logger.error(err);
        reject(err);
      });
    });
  }

  private async runStack(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    stack: RouteHandler<any>[],
  ) {
    let index = -1;
    const dispatch = async (i: number) => {
      if (i <= index) {
        throw new NexarError(
          500,
          `next() called multiple times in handler at position ${index}`,
        );
      }
      index = i;
      if (i === stack.length) return;
      await stack[i](req, res, () => dispatch(i + 1));
    };
    await dispatch(0);
  }

  private errorHandler: ErrorHandler = (err, _req, res) => {
    if (!res.writableEnded) res.status(err.status).json({ error: err.message });
  };

  private handleError(
    e: unknown,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    status = 500,
    message = 'Internal Server Error',
  ) {
    const err =
      e instanceof NexarError ? e : new NexarError(status, message, e);
    logger.error(err.cause ?? err);
    this.errorHandler(err, req, res);
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const startTime = performance.now();

    const method = (req.method ?? 'GET').toUpperCase() as HttpMethod;
    const host = req.headers.host ?? 'localhost';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const pathname = url.pathname;

    req.query = Object.fromEntries(url.searchParams);

    res.on('finish', () => {
      const duration = performance.now() - startTime;
      logger.request(method, pathname, res.statusCode, duration);
    });

    if (method === 'OPTIONS') {
      const allowed = this.routes
        .filter((r) => r.regex.test(pathname))
        .map((r) => r.method);
      res.setHeader('Allow', [...new Set(allowed)].join(', '));
      return res.status(204).end();
    }

    // global middleware
    let stack: RouteHandler[] = [];

    for (const mw of this.middlewares) {
      if (pathname.startsWith(mw.prefix)) {
        stack.push(mw.handler);
      }
    }
    try {
      await this.runStack(req, res, stack);
    } catch (e) {
      this.handleError(e, req, res);
      return;
    }
    if (res.writableEnded) return;

    // body parsing — skip for methods that don't carry a body
    if (!['GET', 'DELETE', 'HEAD'].includes(method)) {
      try {
        req.body = await this.parseBody(req);
      } catch (e) {
        this.handleError(e, req, res, 400, 'Invalid request body');
        return;
      }
    }

    const matchMethod = method === 'HEAD' ? 'GET' : method;

    const match = matchRoute(pathname, this.routes, matchMethod);
    if (!match.success) {
      return res.status(match.code).json({ error: match.error });
    }

    req.params = match.params;

    // per-route handlers + middleware
    try {
      await this.runStack(req, res, match.route.handlers);
      if (!res.writableEnded) res.end();
    } catch (e) {
      this.handleError(e, req, res);
    }
  }

  use(handler: Middleware): this;
  use(prefix: `/${string}`, handler: Middleware): this;
  use(pathOrHandler: `/${string}` | Middleware, handler?: Middleware) {
    if (typeof pathOrHandler === 'function') {
      this.middlewares.push({ prefix: '/', handler: pathOrHandler });
    } else {
      if (!handler)
        throw new TypeError(
          'use() requires a handler when a prefix is provided',
        );
      this.middlewares.push({ prefix: pathOrHandler, handler });
    }
    return this;
  }

  private pushRoute<Params extends string>(
    path: string,
    method: HttpMethod,
    handlers: RouteHandler<Params>[],
  ) {
    const { regex, paramNames } = compilePath<Params>(path);
    this.routes.push({ method, pattern: path, regex, paramNames, handlers });
  }

  get<Path extends string>(
    path: Path,
    ...handlers: Array<RouteHandler<ExtractParams<Path>, 'GET'>>
  ) {
    this.pushRoute<ExtractParams<Path>>(path, 'GET', handlers);
    return this;
  }
  post<Path extends string>(
    path: Path,
    ...handlers: Array<RouteHandler<ExtractParams<Path>, 'POST'>>
  ) {
    this.pushRoute<ExtractParams<Path>>(path, 'POST', handlers);
    return this;
  }
  patch<Path extends string>(
    path: Path,
    ...handlers: Array<RouteHandler<ExtractParams<Path>, 'PATCH'>>
  ) {
    this.pushRoute<ExtractParams<Path>>(path, 'PATCH', handlers);
    return this;
  }
  put<Path extends string>(
    path: Path,
    ...handlers: Array<RouteHandler<ExtractParams<Path>, 'PUT'>>
  ) {
    this.pushRoute<ExtractParams<Path>>(path, 'PUT', handlers);
    return this;
  }
  delete<Path extends string>(
    path: Path,
    ...handlers: Array<RouteHandler<ExtractParams<Path>, 'DELETE'>>
  ) {
    this.pushRoute<ExtractParams<Path>>(path, 'DELETE', handlers);
    return this;
  }

  listen(port = 8000, host = '127.0.0.1', callback?: () => void) {
    this.server.listen(port, host, callback);
  }
}
