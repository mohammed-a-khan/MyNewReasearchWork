/** How EZTest finds the results-server token. */

/**
 * The results-server token: `server.token` (a literal or a secret:// reference, resolved through the configured
 * secret stores), else the EZTEST_SERVER_TOKEN environment variable read as it is. The variable is not looked up
 * through the env secret store, whose prefix (EZTEST_SECRET_ by default) would turn it into another name.
 */
export async function resolveServerToken(
  server: { token?: string } | undefined,
  resolveSecret: (ref: string) => Promise<string>,
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  if (server?.token) return server.token.startsWith('secret://') ? resolveSecret(server.token) : server.token;
  return env.EZTEST_SERVER_TOKEN || undefined;
}
