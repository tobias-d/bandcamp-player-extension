function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

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
