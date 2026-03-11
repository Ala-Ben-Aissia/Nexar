import http from 'node:http';

export type BodyPayload =
  | Record<string, unknown> // application/json
  | Record<string, string> // application/x-www-form-urlencoded
  | string // text/*
  | Buffer; // binary / unknown

declare module 'node:http' {
  interface IncomingMessage {
    params: Record<string, string>;
    query: Record<string, string>;
    body: BodyPayload;
  }
  interface ServerResponse {
    status: (code: number) => this;
    json: (input: unknown) => this;
    send: (input: unknown) => this;
  }
}

export type HttpMethod = 'HEAD' | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type RouteHandler<
  Params extends string = never,
  Method extends HttpMethod = HttpMethod,
> = (
  req: http.IncomingMessage &
    ([Params] extends [never]
      ? { params: never }
      : { params: Record<Params, string> }) &
    ([Method] extends ['GET' | 'DELETE']
      ? { body: never }
      : { body: BodyPayload }),
  res: http.ServerResponse,
  next: () => void | Promise<void>,
) => void | Promise<void> | http.ServerResponse;

export type Route<Path extends string = string> = {
  method: HttpMethod;
  pattern: Path; // '/users/:id'
  regex: RegExp; // /^\/users\/([^/]+)\/?$/
  paramNames: string[]; // ['id']
  handlers: Array<RouteHandler<any>>;
};

export type ExtractParams<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | ExtractParams<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;

export type Middleware = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: () => void | Promise<void>,
) => void | Promise<void>;

type StoredMiddleware = {
  prefix: string;
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    next: () => void | Promise<void>,
  ) => void | Promise<void>;
};

export type MiddlewareStack = Array<StoredMiddleware>;

export type ErrorHandler = (
  err: unknown,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void;
