export class GenosisError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number = 0, code: string = 'UNKNOWN') {
    super(message);
    this.name = 'GenosisError';
    this.status = status;
    this.code = code;
  }

  static fromStatus(status: number, message: string, code: string): GenosisError {
    switch (status) {
      case 400: return new BadRequestError(message, code);
      case 401: return new AuthenticationError(message, code);
      case 403: return new PermissionDeniedError(message, code);
      case 404: return new NotFoundError(message, code);
      case 409: return new ConflictError(message, code);
      case 422: return new UnprocessableEntityError(message, code);
      case 429: return new RateLimitError(message, code);
      default:
        if (status >= 500) return new InternalServerError(message, code);
        return new GenosisError(message, status, code);
    }
  }
}

export class BadRequestError extends GenosisError {
  constructor(message: string, code: string = 'BAD_REQUEST') { super(message, 400, code); this.name = 'BadRequestError'; }
}
export class AuthenticationError extends GenosisError {
  constructor(message: string, code: string = 'UNAUTHORIZED') { super(message, 401, code); this.name = 'AuthenticationError'; }
}
export class PermissionDeniedError extends GenosisError {
  constructor(message: string, code: string = 'FORBIDDEN') { super(message, 403, code); this.name = 'PermissionDeniedError'; }
}
export class NotFoundError extends GenosisError {
  constructor(message: string, code: string = 'NOT_FOUND') { super(message, 404, code); this.name = 'NotFoundError'; }
}
export class ConflictError extends GenosisError {
  constructor(message: string, code: string = 'CONFLICT') { super(message, 409, code); this.name = 'ConflictError'; }
}
export class UnprocessableEntityError extends GenosisError {
  constructor(message: string, code: string = 'UNPROCESSABLE') { super(message, 422, code); this.name = 'UnprocessableEntityError'; }
}
export class RateLimitError extends GenosisError {
  constructor(message: string, code: string = 'RATE_LIMITED') { super(message, 429, code); this.name = 'RateLimitError'; }
}
export class InternalServerError extends GenosisError {
  constructor(message: string, code: string = 'INTERNAL') { super(message, 500, code); this.name = 'InternalServerError'; }
}
export class ConnectionError extends GenosisError {
  constructor(message: string) { super(message, 0, 'CONNECTION_ERROR'); this.name = 'ConnectionError'; }
}
export class TimeoutError extends GenosisError {
  constructor(message: string) { super(message, 0, 'TIMEOUT'); this.name = 'TimeoutError'; }
}
