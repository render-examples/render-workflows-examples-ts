import { randomUUID } from "node:crypto";

// Sessions carry the user's session version. Resetting a password bumps the
// version, which signs out every session created before the reset.

export function login(user, sessions) {
  const session = { id: randomUUID(), userId: user.id, version: 0 };
  sessions.set(session.id, session);
  return session;
}

export function resetPassword(user) {
  user.sessionVersion += 1;
}

export function validateSession(sessionId, users, sessions) {
  const session = sessions.get(sessionId);
  if (!session) return { valid: false, reason: "unknown session" };
  const user = users.get(session.userId);
  if (session.version !== user.sessionVersion) {
    return { valid: false, reason: "session invalid" };
  }
  return { valid: true, user };
}
