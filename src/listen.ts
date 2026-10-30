// An ordinary Node HTTP server, as the live Lambda Web Function runs it: the platform names the
// address to listen on in AWS_LAMBDA_HTTP_ENDPOINT and sends SIGTERM before it stops an
// environment, which drains the requests in flight and exits.

import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';

/** `host:port` or `[v6]:port`, as the platform gives it. */
export function httpEndpoint(value = process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? '127.0.0.1:8787') {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(value);
  if (!match) throw new Error('Invalid HTTP endpoint');
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new Error('Invalid HTTP port');
  return { hostname: match[1]!.replace(/^\[|\]$/g, ''), port };
}

export function listen(app: Hono, value?: string, graceMs = 10_000): Server {
  const server = serve({ fetch: app.fetch, ...httpEndpoint(value) }) as Server;
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, graceMs);
    server.close(() => {
      clearTimeout(timer);
      process.exit(0);
    });
  };
  // A request that finishes after close() began leaves an idle keep-alive connection; close it.
  server.on('request', (_request, response) => {
    response.once('finish', () => {
      if (closing) setImmediate(() => server.closeIdleConnections());
    });
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}
