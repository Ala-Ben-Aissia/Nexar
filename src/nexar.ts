import http from 'node:http';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

declare module 'node:http' {
  interface ServerResponse {
    status: (code: number) => this;
    json: (body: unknown) => this;
  }
}

type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void | Promise<void>;

type MethodHandlerMap = Partial<Record<HttpMethod, RouteHandler>>;

type PathRouter = Map<string, MethodHandlerMap>;

const proto = http.ServerResponse.prototype;

proto.json = function (data: unknown) {
  this.setHeader('Content-Type', 'application/json; charset=utf-8');
  this.end(JSON.stringify(data));
  return this;
};

proto.status = function (code: number) {
  this.statusCode = code;
  return this;
};

export default class Nexar {
  private server: http.Server;
  private routes: PathRouter;

  constructor() {
    this.server = http.createServer(this.handleRequest.bind(this));
    this.routes = new Map();
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
      console.log(
        `${method} ${pathname} ${res.statusCode} ${duration.toFixed()}ms`,
      );
    });

    const route = this.routes.get(pathname);
    if (!route) return res.status(404).json({ error: 'Not Found' });
    if (!route[method]) {
      const allowedMethods = Object.keys(route);
      res.setHeader('Allow', allowedMethods.join(', '));
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    try {
      await route[method]?.(req, res);
      if (!res.writableEnded) res.end();
    } catch (e) {
      if (e instanceof Error) console.log(e.message);
      if (!res.writableEnded) {
        res.status(500).json({ error: 'Internal Server Error' });
      }
    }
  }

  private handleMethodCall(path: string, mapper: MethodHandlerMap) {
    const existing = this.routes.get(path) ?? {};
    this.routes.set(path, { ...existing, ...mapper });
    return this;
  }

  get(path: string, handler: RouteHandler) {
    return this.handleMethodCall(path, { GET: handler });
  }
  post(path: string, handler: RouteHandler) {
    return this.handleMethodCall(path, { POST: handler });
  }
  patch(path: string, handler: RouteHandler) {
    return this.handleMethodCall(path, { PATCH: handler });
  }
  put(path: string, handler: RouteHandler) {
    return this.handleMethodCall(path, { PUT: handler });
  }
  delete(path: string, handler: RouteHandler) {
    return this.handleMethodCall(path, { DELETE: handler });
  }

  listen(port = 8000, host = '127.0.0.1', callback?: () => void) {
    this.server.listen(port, host, callback);
  }
}
