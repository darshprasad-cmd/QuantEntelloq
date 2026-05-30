/**
 * Custom error class behavior.
 */

import { describe, it, expect } from 'vitest';
import {
  AppError,
  ValidationError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  UpstreamError,
  PaymentError,
} from '../lib/errors.js';

describe('error classes', () => {
  it('AppError defaults', () => {
    const e = new AppError('boom');
    expect(e.status).toBe(500);
    expect(e.code).toBe('internal_error');
    expect(e.message).toBe('boom');
  });

  it('ValidationError is 400', () => {
    const e = new ValidationError('bad email', [{ path: 'email' }]);
    expect(e.status).toBe(400);
    expect(e.code).toBe('validation_error');
    expect(e.details).toHaveLength(1);
  });

  it('AuthError is 401', () => {
    expect(new AuthError().status).toBe(401);
  });

  it('ForbiddenError is 403', () => {
    expect(new ForbiddenError().status).toBe(403);
  });

  it('NotFoundError formats message', () => {
    const e = new NotFoundError('Portfolio');
    expect(e.status).toBe(404);
    expect(e.message).toBe('Portfolio not found');
  });

  it('ConflictError is 409', () => {
    expect(new ConflictError().status).toBe(409);
  });

  it('RateLimitError includes retryAfter', () => {
    const e = new RateLimitError('slow down', 30);
    expect(e.status).toBe(429);
    expect(e.details.retryAfter).toBe(30);
  });

  it('UpstreamError is 502', () => {
    expect(new UpstreamError().status).toBe(502);
  });

  it('PaymentError is 402', () => {
    expect(new PaymentError().status).toBe(402);
  });
});
