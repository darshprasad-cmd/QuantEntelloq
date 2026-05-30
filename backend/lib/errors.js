/**
 * Custom error classes with HTTP status mapping.
 *
 * Throw these anywhere; the global error middleware (middleware/error.js)
 * will translate them to JSON: { error: code, message, ... }.
 */

export class AppError extends Error {
  constructor(message, { status = 500, code = 'internal_error', details = null, cause = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
    if (cause) this.cause = cause;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid input', details = null) {
    super(message, { status: 400, code: 'validation_error', details });
  }
}

export class AuthError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, { status: 401, code: 'auth_required' });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, { status: 403, code: 'forbidden' });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, { status: 404, code: 'not_found' });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, { status: 409, code: 'conflict' });
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Rate limited', retryAfter = 60) {
    super(message, { status: 429, code: 'rate_limited', details: { retryAfter } });
  }
}

export class UpstreamError extends AppError {
  constructor(message = 'Upstream service failed', cause = null) {
    super(message, { status: 502, code: 'upstream_error', cause });
  }
}

export class PaymentError extends AppError {
  constructor(message = 'Payment required') {
    super(message, { status: 402, code: 'payment_required' });
  }
}
