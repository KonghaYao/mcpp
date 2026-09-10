/**
 * Shared Hono environment.
 *
 * `requestId` is set by the assembly middleware for every request and is the
 * only value routes read out of the context; keeping it in one declaration
 * avoids each router inventing its own variable map.
 */

export type AppEnv = {
  Variables: {
    requestId: string;
  };
};
