/**
 * Test stand-in for the admin listener: the same `request(path, init)` shape
 * the Hono app used to offer, backed by {@link handleAdminRequest}.
 */
import { handleAdminRequest } from './admin-surface.js';
import type { AdminSurfaceDeps } from './admin-surface.js';

export interface AdminTestApp {
  request(
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string }
  ): Promise<Response>;
}

export function adminTestApp(deps: AdminSurfaceDeps): AdminTestApp {
  return {
    async request(path, init = {}) {
      const headers = Object.fromEntries(
        Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
      );
      const answer = await handleAdminRequest(
        {
          method: init.method ?? 'GET',
          path: path.split('?')[0] ?? path,
          header: (name) => headers[name.toLowerCase()],
          json: async () => {
            if (init.body === undefined) throw new Error('no body');
            return JSON.parse(init.body) as unknown;
          },
        },
        deps
      );
      if (!answer)
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
        });
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}
