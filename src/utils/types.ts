import http from 'node:http';

declare module 'node:http' {
  interface ServerResponse {
    status: (code: number) => this;
    json: (input: unknown) => this;
    send: (
      input: unknown,
      { contentType }?: { contentType: ContentType },
    ) => this;
  }
  interface IncomingMessage {
    params: Record<string, string>;
  }
}

export type ContentType =
  | 'text/plain'
  | 'text/html'
  | 'text/css'
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'image/svg+xml'
  | 'application/json'
  | 'application/octet-stream';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void | Promise<void> | http.ServerResponse;

export type MethodHandlerMap = Partial<Record<HttpMethod, RouteHandler>>;

export type Route = {
  method: HttpMethod;
  pattern: string; // '/users/:id'
  regex: RegExp; // /^\/users\/([^/]+)\/?$/
  paramNames: string[]; // ['id']
  handler: RouteHandler;
};
