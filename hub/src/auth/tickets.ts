import { randomToken, sha256Hex } from '../security/crypto.ts';

/**
 * One-time tickets for opening WebSockets.
 *
 * Browsers cannot attach an Authorization header to a WebSocket, so the app
 * first asks for a ticket over the authenticated API and presents it in the
 * URL. A ticket is valid for a few seconds and can be used exactly once, so it
 * is worthless if it ever shows up in a proxy log.
 */

interface Ticket {
  sessionId: string;
  scope: string;
  expiresAt: number;
}

const TTL_MS = 30_000;

export class TicketStore {
  private readonly tickets = new Map<string, Ticket>();

  issue(sessionId: string, scope: string): string {
    this.sweep();
    const ticket = randomToken(24);
    this.tickets.set(sha256Hex(ticket), { sessionId, scope, expiresAt: Date.now() + TTL_MS });
    return ticket;
  }

  /** Returns the session id the ticket was issued for, or null. */
  redeem(ticket: string, scope: string): string | null {
    if (!ticket || ticket.length > 100) return null;
    const key = sha256Hex(ticket);
    const entry = this.tickets.get(key);
    if (!entry) return null;
    this.tickets.delete(key);
    if (entry.expiresAt < Date.now() || entry.scope !== scope) return null;
    return entry.sessionId;
  }

  private sweep(): void {
    if (this.tickets.size < 200) return;
    const now = Date.now();
    for (const [key, entry] of this.tickets) if (entry.expiresAt < now) this.tickets.delete(key);
  }
}
