import { ERRORS, type ErrorCode } from './contract.ts';

export const STATUS: Record<ErrorCode, 400 | 401 | 404 | 409 | 413 | 422 | 429 | 500 | 503> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  refused: 422,
  rate_limited: 429,
  internal: 500,
  unavailable: 503
};

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
  }
}

export const fail = (code: ErrorCode, message: string): never => {
  throw new ApiError(code, message);
};

export const errorCodes = Object.keys(ERRORS) as ErrorCode[];
