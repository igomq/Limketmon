// Stands in for next/headers so the route handlers can run outside a Next request scope.
// Tests set the signed-in identity the same way the Sites middleware would.
let current = null;

export function headers() {
  return {
    get(name) {
      return current?.[name] ?? null;
    }
  };
}

export function setAuthenticatedUser(userId, email, displayName) {
  current = userId
    ? {
        'oai-authenticated-user-id': userId,
        'oai-authenticated-user-email': email ?? `${userId}@local.invalid`,
        'oai-authenticated-user-full-name': displayName ? encodeURIComponent(displayName) : null,
        'oai-authenticated-user-full-name-encoding': displayName ? 'percent-encoded-utf-8' : null
      }
    : null;
}
