import http from 'node:http';
import {
  compilePath,
  detectContentType,
  matchRoute,
  safeWrite,
  validateJson,
  validateStatus,
} from './utils/index.js';
import { logger } from './utils/logger.js';
import {
  BodyPayload,
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
  if (!input) return this;
  const type = detectContentType(input, this.req);
  this.setHeader('content-type', type);
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

  constructor() {
    this.server = http.createServer(this.handleRequest.bind(this));
    this.routes = [];
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
          } catch (e) {
            return reject(new SyntaxError('Invalid JSON body'));
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

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const startTime = performance.now();

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    req.query = Object.fromEntries(url.searchParams);
    req.body = await this.parseBody(req);
    const pathname = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase() as HttpMethod;

    res.on('finish', () => {
      const duration = performance.now() - startTime;
      logger.request(method, pathname, res.statusCode, duration);
    });

    const match = matchRoute(pathname, this.routes, method);
    if (!match.success) {
      return res.status(match.code).json({ error: match.error });
    }
    req.params = match.params;
    const handler = match.route.handler;
    try {
      await handler(req, res);
      if (!res.writableEnded) res.end();
    } catch (e) {
      logger.error(e);
      if (!res.writableEnded) {
        res.status(500).json({ error: 'Internal Server Error' });
      }
    }
  }

  private pushRoute<Params extends string>(
    path: string,
    method: HttpMethod,
    handler: RouteHandler<Params>,
  ) {
    const { regex, paramNames } = compilePath<Params>(path);
    this.routes.push({
      method,
      pattern: path,
      regex,
      paramNames,
      handler,
    });
  }

  get<Path extends string>(
    path: Path,
    handler: RouteHandler<ExtractParams<Path>, 'GET'>,
  ) {
    this.pushRoute<ExtractParams<Path>>(path, 'GET', handler);
    return this;
  }
  post<Path extends string>(
    path: Path,
    handler: RouteHandler<ExtractParams<Path>, 'POST'>,
  ) {
    this.pushRoute(path, 'POST', handler);
    return this;
  }
  patch<Path extends string>(
    path: Path,
    handler: RouteHandler<ExtractParams<Path>, 'PATCH'>,
  ) {
    this.pushRoute(path, 'PATCH', handler);
    return this;
  }
  put<Path extends string>(
    path: Path,
    handler: RouteHandler<ExtractParams<Path>, 'PUT'>,
  ) {
    this.pushRoute(path, 'PUT', handler);
    return this;
  }
  delete<Path extends string>(
    path: Path,
    handler: RouteHandler<ExtractParams<Path>, 'DELETE'>,
  ) {
    this.pushRoute(path, 'DELETE', handler);
    return this;
  }

  listen(port = 8000, host = '127.0.0.1', callback?: () => void) {
    this.server.listen(port, host, callback);
  }
}
