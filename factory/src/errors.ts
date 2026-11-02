// Errors that tools return as {code, message}. Messages never contain absolute host paths,
// only workspace names, tickets and checkout-relative paths.
export class FactoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FactoryError';
    this.code = code;
  }
}
