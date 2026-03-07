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
import type {
  ContentType,
  HttpMethod,
  Route,
  RouteHandler,
} from './utils/types.js';

function stringifyError(error: Error) {
  const { message, name, cause, stack } = error;
  return JSON.stringify({ message, name, cause, stack });
}

const proto: http.ServerResponse = http.ServerResponse.prototype;

proto.json = function (input: unknown) {
  if (this.writableEnded) return this;
  this.setHeader('content-type', 'application/json');
  if (!input) return this;
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

proto.send = function (
  input: any,
  { contentType }: { contentType?: ContentType } = {},
) {
  if (!input) return this;
  const type = detectContentType(input);
  this.setHeader('content-type', contentType ?? type);
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

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const startTime = performance.now();

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
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
      await handler?.(req, res);
      if (!res.writableEnded) res.end();
    } catch (e) {
      logger.error(e);
      if (!res.writableEnded) {
        res.status(500).json({ error: 'Internal Server Error' });
      }
    }
  }

  get(path: string, handler: RouteHandler) {
    const { regex, paramNames } = compilePath(path);
    this.routes.push({
      method: 'GET',
      pattern: path,
      regex,
      paramNames,
      handler,
    });
    return this;
  }
  post(path: string, handler: RouteHandler) {
    const { regex, paramNames } = compilePath(path);
    this.routes.push({
      method: 'POST',
      pattern: path,
      regex,
      paramNames,
      handler,
    });
    return this;
  }
  patch(path: string, handler: RouteHandler) {
    const { regex, paramNames } = compilePath(path);
    this.routes.push({
      method: 'PATCH',
      pattern: path,
      regex,
      paramNames,
      handler,
    });
    return this;
  }
  put(path: string, handler: RouteHandler) {
    const { regex, paramNames } = compilePath(path);
    this.routes.push({
      method: 'PUT',
      pattern: path,
      regex,
      paramNames,
      handler,
    });
    return this;
  }
  delete(path: string, handler: RouteHandler) {
    const { regex, paramNames } = compilePath(path);
    this.routes.push({
      method: 'DELETE',
      pattern: path,
      regex,
      paramNames,
      handler,
    });
    return this;
  }

  listen(port = 8000, host = '127.0.0.1', callback?: () => void) {
    this.server.listen(port, host, callback);
  }
}
