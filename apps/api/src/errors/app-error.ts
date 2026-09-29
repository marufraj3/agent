export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 500,
    public readonly code = 'INTERNAL_ERROR',
    public readonly expose = statusCode < 500,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request', code = 'VALIDATION_ERROR') { super(message, 400, code); }
}
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', code = 'NOT_FOUND') { super(message, 404, code); }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', code = 'UNAUTHORIZED') { super(message, 401, code); }
}
export class RateLimitError extends AppError {
  constructor(message = 'Too many requests') { super(message, 429, 'RATE_LIMITED'); }
}
export class ExternalApiError extends AppError {
  constructor(message = 'External service request failed', code = 'EXTERNAL_API_ERROR', public readonly retryable = false) {
    super(message, 502, code, true);
  }
}
export class AIServiceError extends ExternalApiError {
  constructor(message = 'AI service is temporarily unavailable', code = 'AI_SERVICE_ERROR', retryable = true) {
    super(message, code, retryable);
  }
}
