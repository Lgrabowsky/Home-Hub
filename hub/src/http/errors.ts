/** An error that is safe to show to the client as-is (German message). */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const unauthorized = () => new HttpError(401, 'unauthorized', 'Bitte melde dich an.');
export const forbidden = (message = 'Dafür fehlt dir die Berechtigung.') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Nicht gefunden.') => new HttpError(404, 'not_found', message);
export const badRequest = (message = 'Ungültige Anfrage.') => new HttpError(400, 'bad_request', message);
export const unavailable = (message: string) => new HttpError(503, 'unavailable', message);
