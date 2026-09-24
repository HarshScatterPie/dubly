// Firestore's hard limit on one document's stored size.
export const FIRESTORE_MAX_DOCUMENT_BYTES = 1_048_576;

// Stored size per Firestore's documented rules: strings UTF-8 + 1, numbers 8, booleans/null 1, maps keys + values, arrays their values.
export function firestoreValueSize(value: unknown): number {
  if (value === undefined) return 0;
  if (value === null || typeof value === 'boolean') return 1;
  if (typeof value === 'number') return 8;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8') + 1;
  if (value instanceof Date) return 8;
  if (Array.isArray(value)) return value.reduce((sum: number, v) => sum + firestoreValueSize(v), 0);
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).reduce(
      (sum, [key, v]) => (v === undefined ? sum : sum + Buffer.byteLength(key, 'utf8') + 1 + firestoreValueSize(v)),
      0
    );
  }
  return 0;
}

// Whole-document size: the document name (each path segment as a string, plus 16 bytes) + its fields + 32 bytes of overhead.
export function firestoreDocumentSize(documentPath: string, data: Record<string, unknown>): number {
  const nameSize = documentPath.split('/').reduce((sum, part) => sum + Buffer.byteLength(part, 'utf8') + 1, 0) + 16;
  return nameSize + firestoreValueSize(data) + 32;
}
