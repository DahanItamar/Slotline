import type { ApiErrorBody, ErrorCode } from '@slotline/shared';

/**
 * The only place the app talks to the server. Errors arrive as a typed `code` — callers
 * switch on that, never on the message, which is display text and may be reworded.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message);
    this.name = 'ApiError';
    this.code = body.error.code;
    this.status = status;
    this.details = body.error.details;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
};

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    // Same origin in dev (via the Vite proxy) and in production, so the session cookie
    // rides along without any CORS credential handling.
    credentials: 'same-origin',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    if (payload && typeof payload === 'object' && 'error' in payload) {
      throw new ApiError(response.status, payload as ApiErrorBody);
    }
    throw new ApiError(response.status, {
      error: { code: 'INTERNAL', message: 'The server did not respond properly.' },
    });
  }

  return payload as T;
}
