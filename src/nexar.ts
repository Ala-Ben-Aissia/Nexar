import http from 'node:http';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

declare module 'node:http' {
  interface ServerResponse {
    status: (code: number) => this;
    json: (body: unknown) => this;
    send: (body: any) => this;
  }
}

type Route = {
  method: HttpMethod;
  path: string;
  handler: Handler;
};

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => any;

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

export class Nexar {
  private server: http.Server;
  private routes: Route[];

  constructor() {
    this.server = http.createServer(this.handleRequest.bind(this));
    this.routes = [];
  }

  private findRoute(pathname: string) {
    return this.routes.find((r) => r.path === pathname);
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

    const route = this.findRoute(pathname);

    if (!route) return res.status(404).json({ error: 'Not Found' });
    if (route.method !== method)
      return res.status(405).json({ error: 'Method Not Allowed' });

    try {
      await route.handler(req, res);
      if (!res.writableEnded) res.end();
    } catch (e) {
      console.log(e);
      if (!res.writableEnded) {
        res.status(500).json({ error: 'Internal Server Error' });
      }
    }
  }

  private handleMethodCall(route: Route) {
    this.routes.push(route);
    return this;
  }

  get(path: string, handler: Handler) {
    return this.handleMethodCall({ method: 'GET', path, handler });
  }
  post(path: string, handler: Handler) {
    return this.handleMethodCall({ method: 'POST', path, handler });
  }
  patch(path: string, handler: Handler) {
    return this.handleMethodCall({ method: 'PATCH', path, handler });
  }
  put(path: string, handler: Handler) {
    return this.handleMethodCall({ method: 'PUT', path, handler });
  }
  delete(path: string, handler: Handler) {
    return this.handleMethodCall({ method: 'DELETE', path, handler });
  }

  listen(port = 8000, host = '127.0.0.1', callback?: () => void) {
    this.server.listen(port, host, callback);
  }
}
