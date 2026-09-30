import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

// Tighter limiter for authentication endpoints (login, register, refresh) to
// slow down credential-stuffing and brute-force attempts.
//
// skipSuccessfulRequests: only FAILED attempts count. Every full page load performs a silent
// /auth/refresh, so counting successes locked real users out after ~10 page loads per 15 minutes
// (returning from Stripe Checkout is a full page load too), and offices behind one IP shared the budget.
export const authRateLimiter = rateLimit({
  windowMs: env.authRateLimitWindowMs,
  max: env.authRateLimitMax,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again later.' },
});

// General-purpose limiter for the rest of the API.
export const generalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});

// Stricter limiter for the payment-creation endpoint specifically.
export const paymentRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many payment attempts. Please wait a moment.' },
});

// Registration creates records, so successes must count here (unlike login/refresh above).
export const registerRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many accounts created from this address. Please try again later.' },
});
