export { FIELD_RULES } from './dictionary';
export type { FieldType, FieldRule } from './dictionary';

export {
  buildFingerprint,
  serializeFingerprint,
  enumerateFillable,
  normalize,
} from './fingerprint';
export type { FieldFingerprint, FillableElement } from './fingerprint';

export { scoreField, HIGH_THRESHOLD, MEDIUM_THRESHOLD } from './scorer';
export type { ScoredMatch } from './scorer';
