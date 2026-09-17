/**
 * jev-memory deliberately does not implement AI Gateway auth itself -- the
 * `ai` package already knows how to authenticate a Jev call two ways (see
 * README "Auth"). This module only checks, before spending a round trip,
 * that one of those two paths is configured, and fails with a clear message
 * if not.
 */
export function assertAuthConfigured(): void {
  if (process.env.AI_GATEWAY_API_KEY) return;
  if (process.env.VERCEL_OIDC_TOKEN) return;

  throw new Error(
    'jev-memory: no AI Gateway credentials found. The Vercel AI SDK needs one of:\n' +
      '  1. AI_GATEWAY_API_KEY set in the environment (create one at https://vercel.com/dashboard -> AI Gateway), or\n' +
      '  2. VERCEL_OIDC_TOKEN set (populated by running `vercel env pull` inside a Vercel-linked project; ' +
      'this token is short-lived, about 12h, and needs to be refreshed the same way).\n' +
      'jev-memory does not manage credentials itself -- it only verifies the AI SDK has what it needs before calling evaluate().',
  );
}
