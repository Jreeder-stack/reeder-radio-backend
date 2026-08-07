import crypto from 'crypto';

const CORRELATION_PREFIX = 'v3';

export function createV3CorrelationId(runtimeId = null) {
  const runtime = sanitizeSegment(runtimeId) || 'runtime';
  return `${CORRELATION_PREFIX}-${runtime}-${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

export function ensureV3CorrelationId(value, runtimeId = null) {
  const supplied = String(value ?? '').trim();
  return supplied || createV3CorrelationId(runtimeId);
}

export function childV3CorrelationId(parentId, label = 'step') {
  const parent = String(parentId ?? '').trim();
  if (!parent) return createV3CorrelationId(label);
  return `${parent}.${sanitizeSegment(label) || 'step'}.${crypto.randomUUID().slice(0, 8)}`;
}

function sanitizeSegment(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
