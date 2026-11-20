export interface AuthUser {
  email: string;
}

export class AuthRequestError extends Error {
  constructor(readonly status: number) {
    super(`Auth API returned ${status}`);
  }
}

function postJson(path: string, body: object) {
  return fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readUser(response: Response): Promise<AuthUser> {
  if (!response.ok) {
    throw new AuthRequestError(response.status);
  }
  return response.json();
}

export async function getSession(signal: AbortSignal) {
  const response = await fetch('/api/auth/session', { signal, cache: 'no-store' });
  return response.status === 401 ? null : readUser(response);
}

export async function login(email: string, password: string) {
  return readUser(await postJson('login', { email, password }));
}

export async function logout() {
  const response = await postJson('logout', {});
  if (!response.ok) {
    throw new AuthRequestError(response.status);
  }
}
