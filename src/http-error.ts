// Error with an HTTP status; the JSON error handler in server.ts turns it into a response
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
