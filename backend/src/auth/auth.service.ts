import { randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { verifyPassword } from './password.js';

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly account: { email: string; passwordHash: string };
  private readonly sessions = new Map<string, number>();

  constructor() {
    const email = process.env.AUTH_EMAIL?.trim().toLowerCase();
    const passwordHash = process.env.AUTH_PASSWORD_HASH;

    if (!email || !isEmail(email) || email.length > 254 ||
        !passwordHash || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash)) {
      throw new Error('Set a valid AUTH_EMAIL and AUTH_PASSWORD_HASH in backend/.env.');
    }

    this.account = { email, passwordHash };
  }

  async login(email: string, password: string, previousToken?: string) {
    const validPassword = await verifyPassword(password, this.account.passwordHash);
    if (!validPassword || email.toLowerCase() !== this.account.email) {
      throw new UnauthorizedException();
    }

    const now = Date.now();
    for (const [token, expiresAt] of this.sessions) {
      if (expiresAt <= now) {
        this.sessions.delete(token);
      }
    }

    const token = randomBytes(32).toString('base64url');
    this.revokeSession(previousToken);
    this.sessions.set(token, now + SESSION_TTL_MS);

    return { token, user: { email: this.account.email } };
  }

  getUser(token?: string) {
    const expiresAt = token && this.sessions.get(token);
    if (!expiresAt || expiresAt <= Date.now()) {
      this.revokeSession(token);
      throw new UnauthorizedException();
    }

    return { email: this.account.email };
  }

  revokeSession(token?: string) {
    if (token) {
      this.sessions.delete(token);
    }
  }
}
