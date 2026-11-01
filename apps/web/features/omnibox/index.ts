/**
 * Barrel exports for `features/omnibox` (Task 13 + Task 18a).
 */

export {
  ERR_HINT_INVALID,
  ERR_NAME_INVALID,
  ERR_TAG_DISPLAY_INVALID,
  HINT_MAX_RUNES,
  NAME_MAX_RUNES,
  NAME_MIN_RUNES,
  QUERY_MAX_RUNES,
  TAG_MAX_RUNES,
  TAG_MIN_RUNES,
  TAG_QUERY_MAX_RUNES,
  TextNormError,
  countRunes,
  decodeUtf8StrictForNormalize,
  hasForbiddenRune,
  isForbiddenRune,
  isUnicodeWhiteSpace,
  normalize,
  normalizeLookupName,
  normalizeName,
  normalizeQuery,
  normalizeTag,
  normalizeTagQuery,
  toLowerRuneGo,
  trimUnicodeWhiteSpace,
  validateHint,
  type NormalizeBothResult,
  type NormalizeErrorCode,
  type NormalizeSingleResult,
  type ValidateHintResult,
} from './normalize';

export {
  QUICK_ADD_MAX_TAGS,
  QUICK_ADD_SEARCHABLE_MAX_RUNES,
  findQuickAddSeparatorColon,
  parseQuickAdd,
  type QuickAddErrorCode,
  type QuickAddMode,
  type QuickAddParseResult,
} from './quick-add-parse';

export {
  filterCachedTagsByPrefix,
  normalizeForPrefixMatch,
  parseTagFilterInput,
  splitMarkedPrefix,
  type ParsedTagFilterInput,
  type PrefixMarkSegments,
} from './search-helpers';
