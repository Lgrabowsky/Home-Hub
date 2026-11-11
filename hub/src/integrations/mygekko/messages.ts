import { DeviceHttpError } from '../../util/http.ts';
import { isGekkoError, type GekkoError } from './client.ts';

/** German texts for the health line, the connection test and command errors. */

export type GekkoMode = 'local' | 'cloud';

/** `14:32` in the hub's time zone. */
export function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/** The German reason the HTTP client gives for a network problem ("Verbindung abgelehnt (…)"). */
function networkDetail(err: GekkoError): string | null {
  return err.cause instanceof DeviceHttpError ? err.cause.message : null;
}

/** Why the controller cannot be read right now — one short sentence for the user. */
export function describeFailure(err: unknown, mode: GekkoMode): string {
  if (!isGekkoError(err)) return 'Die Antwort des myGEKKO konnte nicht ausgewertet werden.';
  const who = mode === 'cloud' ? 'Die myGEKKO-Cloud' : 'Der myGEKKO';
  switch (err.kind) {
    case 'auth':
      return mode === 'cloud'
        ? 'Die myGEKKO-Cloud lehnt die Anmeldung ab. Bitte Benutzername, API-Schlüssel und myGEKKO-ID prüfen.'
        : 'Der myGEKKO lehnt die Anmeldung ab. Bitte Benutzername und Passwort prüfen.';
    case 'rate_limit':
      return `${who} meldet zu viele Anfragen. Der Hub macht ein paar Minuten Pause.`;
    case 'gone':
      return 'Der myGEKKO ist über die Cloud nicht erreichbar (ausgeschaltet, ohne Internet oder falsche myGEKKO-ID).';
    case 'not_found':
      return mode === 'cloud' ? 'Die myGEKKO-Cloud kennt diesen myGEKKO nicht.' : 'Unter dieser Adresse antwortet kein myGEKKO.';
    case 'protocol':
      return mode === 'cloud' ? 'Die Antwort der myGEKKO-Cloud ist nicht lesbar.' : 'Unter dieser Adresse antwortet kein myGEKKO (die Antwort ist nicht lesbar).';
    case 'timeout':
    case 'network': {
      const detail = networkDetail(err);
      return detail ? `${who} ist nicht erreichbar: ${detail}.` : `${who} ist nicht erreichbar.`;
    }
    case 'config':
      return mode === 'cloud' ? 'Die myGEKKO-ID fehlt.' : 'Die Adresse des myGEKKO fehlt oder ist ungültig.';
    case 'aborted':
      return 'Die Anfrage wurde abgebrochen.';
    default:
      return `${who} antwortet mit einem Fehler${err.status ? ` (HTTP ${err.status})` : ''}.`;
  }
}

/** What is missing before a connection can even be tried; null when the settings are complete. */
export function missingSetting(settings: { mode: GekkoMode; host: string; username: string; password: string; gekkoId: string }): string | null {
  if (settings.mode === 'local' && !settings.host.trim()) return 'Die Adresse des myGEKKO fehlt.';
  if (settings.mode === 'cloud' && !settings.gekkoId.trim()) return 'Die myGEKKO-ID fehlt.';
  if (!settings.username.trim()) return 'Der Benutzername für den myGEKKO fehlt.';
  if (!settings.password) return settings.mode === 'cloud' ? 'Der API-Schlüssel für die myGEKKO-Cloud fehlt.' : 'Das Passwort für den myGEKKO fehlt.';
  return null;
}
