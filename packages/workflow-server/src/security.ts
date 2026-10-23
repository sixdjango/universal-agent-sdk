import type { FastifyInstance } from 'fastify';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function hostnameOf(hostHeader: string): string {
  // Keep the brackets of IPv6 literals ("[::1]:4317" -> "[::1]").
  return hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0]!;
}

/**
 * The server can drive agents that write files, so it guards against other web pages:
 * - `allowedHosts` rejects unexpected Host headers (DNS-rebinding to localhost);
 * - state-changing requests must come from this server's own origin (no cross-site POSTs).
 */
export function registerRequestGuards(
  app: FastifyInstance,
  options: { allowedHosts: readonly string[] | 'any' }
): void {
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host ?? '';
    if (options.allowedHosts !== 'any' && !options.allowedHosts.includes(hostnameOf(host))) {
      return reply.code(403).send({ error: `Host "${host}" is not allowed` });
    }
    if (!SAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== 'null') {
        let originHost: string | undefined;
        let originHostname: string | undefined;
        try {
          const parsed = new URL(origin);
          originHost = parsed.host;
          originHostname = parsed.hostname;
        } catch {
          originHost = undefined;
          originHostname = undefined;
        }
        const isAllowedOrigin =
          originHost === host ||
          (originHostname !== undefined &&
            options.allowedHosts !== 'any' &&
            options.allowedHosts.includes(originHostname));
        if (!isAllowedOrigin) {
          return reply.code(403).send({ error: 'Cross-origin requests are not allowed' });
        }
      } else if (origin === 'null') {
        return reply.code(403).send({ error: 'Cross-origin requests are not allowed' });
      }
    }
    return undefined;
  });
}
