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
  this.setHeader('content-type', 'application/json');
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
    this.setHeader('content-type', 'application/json');
    this.statusCode = 400;
    return this.end(stringifyError(error));
  }
  this.statusCode = code;
  return this;
};

proto.send = function (input: any) {
  if (input === undefined) return this;
  if (!this.getHeader('content-type')) {
    // detect from output shape — trust request header as fallback for untagged binary
    const type = detectContentType(input, this.req);
    this.setHeader('content-type', type);
  }
  const body =
    typeof input === 'string' || Buffer.isBuffer(input)
      ? input
      : JSON.stringify(input);
  if (!body) return this;
  safeWrite(this.req, this, body);
  return this.end();
};

export default class Nexar {
  private server: http.Server;
  private routes: Route[];
  private middlewares: MiddlewareStack;

  private errorHandler: ErrorHandler = (err, _req, res) => {
    const status = err instanceof NexarError ? err.status : 500;
    const message =
      err instanceof NexarError ? err.message : 'Internal Server Error';
    if (!res.writableEnded) res.status(status).json({ error: message });
  };

  constructor() {
    this.server = http.createServer(this.handleRequest.bind(this));
    this.routes = [];
    this.middlewares = [];
  }

  private parseBody(req: http.IncomingMessage) {
    return new Promise<BodyPayload>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
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
    let i = 0;
    const next = async () => {
      if (res.writableEnded) return;
      if (i < stack.length) {
        const handler = stack[i++];
        await handler(req, res, next);
      }
    };
    await next();
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const startTime = performance.now();

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const pathname = url.pathname;
    req.query = Object.fromEntries(url.searchParams);

    res.on('finish', () => {
      const duration = performance.now() - startTime;
      logger.request(method, pathname, res.statusCode, duration);
    });

    // global middleware
    try {
      const middlewares = this.middlewares
        .filter((m) => pathname.startsWith(m.prefix))
        .map((m) => m.handler);
      await this.runStack(req, res, middlewares);
    } catch (e) {
      const err =
        e instanceof NexarError
          ? e
          : new NexarError(500, 'Internal Server Error', e);
      logger.error(err.cause ?? err);
      this.errorHandler(err, req, res);
      return;
    }
    if (res.writableEnded) return;

    const method = (req.method ?? 'GET').toUpperCase() as HttpMethod;

    // body parsing — skip for methods that don't carry a body
    if (!['GET', 'DELETE', 'HEAD'].includes(method)) {
      try {
        req.body = await this.parseBody(req);
      } catch (e) {
        const err =
          e instanceof NexarError
            ? e
            : new NexarError(400, 'Invalid request body', e);
        logger.error(err.cause ?? err);
        this.errorHandler(err, req, res);
        return;
      }
    }

    const match = matchRoute(pathname, this.routes, method);
    if (!match.success) {
      return res.status(match.code).json({ error: match.error });
    }

    req.params = match.params;

    // per-route handlers + middleware
    try {
      await this.runStack(req, res, match.route.handlers);
      if (!res.writableEnded) res.end();
    } catch (e) {
      const err =
        e instanceof NexarError
          ? e
          : new NexarError(500, 'Internal Server Error', e);
      logger.error(err.cause ?? err);
      this.errorHandler(err, req, res);
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  use(handler: Middleware): this;
  use(prefix: `/${string}`, handler: Middleware): this;
  use(
    pathOrHandler: `/${string}` | Middleware,
    handler: Middleware = () => {},
  ) {
    if (typeof pathOrHandler === 'function') {
      this.middlewares.push({ prefix: '/', handler: pathOrHandler });
    } else {
      this.middlewares.push({ prefix: pathOrHandler, handler });
    }
    return this;
  }

  onError(handler: ErrorHandler) {
    this.errorHandler = handler;
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
