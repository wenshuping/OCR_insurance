import { ApiError } from '../api/client';

export function createCodedError(message: string, code: string) {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

export function getErrorCode(error: unknown) {
  if (error instanceof ApiError) return error.code || 'API_ERROR';
  return String((error as { code?: string } | null)?.code || 'CLIENT_ERROR');
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || '未知错误');
}
