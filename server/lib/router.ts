import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

// Express 4 drops a rejected promise from an async handler, which on Node 15+ crashes the whole process; this forwards it to the error middleware instead.
export function wrapAsync(handler: RequestHandler): RequestHandler {
  if (handler.length === 4) return handler;
  return function wrapped(req: Request, res: Response, next: NextFunction) {
    try {
      const result = handler(req, res, next) as unknown;
      if (result && typeof (result as Promise<unknown>).catch === 'function') (result as Promise<unknown>).catch(next);
    } catch (err) {
      next(err);
    }
  };
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'] as const;

// Drop-in replacement for express.Router() whose route handlers are all wrapped by wrapAsync.
export function Router(): express.Router {
  const router = express.Router();
  for (const method of METHODS) {
    const original = router[method].bind(router) as (...args: unknown[]) => express.Router;
    (router as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
      original(...args.map((arg) => (typeof arg === 'function' ? wrapAsync(arg as RequestHandler) : arg)));
  }
  return router;
}
