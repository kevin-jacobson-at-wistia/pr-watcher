// Thin wrapper around the Shortcut REST API v3.
// Auth: SHORTCUT_API_TOKEN env var (https://app.shortcut.com/settings/account/api-tokens).
// Returns parsed JSON. Throws on non-2xx with the response body in the message.

const BASE = 'https://api.app.shortcut.com/api/v3';

export function makeShortcut({ token = process.env.SHORTCUT_API_TOKEN } = {}) {
  if (!token) return null;
  return async function shortcut(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Shortcut-Token': token,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`shortcut ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : null;
  };
}

export async function getCurrentMember(shortcut) {
  return shortcut('/member');
}

export async function listActiveIterations(shortcut) {
  // /iterations returns all iterations; filter to status=started client-side.
  const all = await shortcut('/iterations');
  return all.filter((it) => it.status === 'started');
}

export async function listStoriesInIteration(shortcut, iterationId) {
  return shortcut(`/iterations/${iterationId}/stories`);
}
