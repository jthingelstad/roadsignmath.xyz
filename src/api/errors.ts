import { ERRORS, type ErrorCode } from './contract.ts';

export const STATUS: Record<ErrorCode, 400 | 401 | 404 | 429 | 500> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  rate_limited: 429,
  internal: 500
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
