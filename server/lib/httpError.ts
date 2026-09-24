// An error whose message is written for the user and is safe to return as-is; anything else is reported generically.
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
