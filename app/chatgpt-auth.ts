import { headers } from 'next/headers';

export type ChatGPTUser = { userId: string; email: string; displayName: string };

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  const userId = requestHeaders.get('oai-authenticated-user-id');
  const email = requestHeaders.get('oai-authenticated-user-email');
  if (!userId || !email) return null;

  const encodedName = requestHeaders.get('oai-authenticated-user-full-name');
  const fullName =
    encodedName &&
    requestHeaders.get('oai-authenticated-user-full-name-encoding') === 'percent-encoded-utf-8'
      ? safeDecode(encodedName)
      : null;

  return { userId, email, displayName: fullName ?? email };
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
