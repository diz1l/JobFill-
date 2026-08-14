export { FIELD_RULES } from './dictionary';
export type { FieldType, FieldRule } from './dictionary';

export {
  buildFingerprint,
  buildClassificationBatch,
  serializeFingerprint,
  enumerateFillable,
  extractSemanticName,
  normalize,
} from './fingerprint';
export type { ClassificationBatch, FieldFingerprint, FillableElement } from './fingerprint';

export { scoreField, HIGH_THRESHOLD, MEDIUM_THRESHOLD, MIN_MARGIN } from './scorer';
export type { ScoredMatch, ExtendedFieldType } from './scorer';
