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
  interface IncomingMessage<Params extends string = never> {
    params: Record<Params, string>;
    query: URL['searchParams'];
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

export type RouteHandler<Params extends string = never> = (
  req: http.IncomingMessage &
    ([Params] extends [never]
      ? { params: never }
      : { params: Record<Params, string> }),
  res: http.ServerResponse,
) => void | Promise<void> | http.ServerResponse;

export type MethodHandlerMap<Params extends string> = Partial<
  Record<HttpMethod, RouteHandler<Params>>
>;

export type Route<Path extends string = string> = {
  method: HttpMethod;
  pattern: Path; // '/users/:id'
  regex: RegExp; // /^\/users\/([^/]+)\/?$/
  paramNames: string[]; // ['id']
  handler: RouteHandler<any>;
};

export type ExtractParams<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | ExtractParams<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;
