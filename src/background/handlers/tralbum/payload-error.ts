import { asRecord } from '@/background/handlers/tralbum/identity';

export function readErrorFromPayload(payload: unknown): string {
  const record = asRecord(payload);
  if (!record) {
    return '';
  }

  const errorRaw = record['error'];
  const messageRaw = record['error_message'] ?? record['errorMessage'];
  const error =
    typeof errorRaw === 'string'
      ? errorRaw.trim()
      : errorRaw === true
        ? 'true'
        : '';
  const message = typeof messageRaw === 'string' ? messageRaw.trim() : '';

  return [error, message].filter(Boolean).join(': ');
}
