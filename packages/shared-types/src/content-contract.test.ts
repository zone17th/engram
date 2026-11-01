import { describe, expectTypeOf, it } from 'vitest';
import type { components, paths } from './api';

type S = components['schemas'];

// Ghim kiểu mà các lane web P04 dựa vào (CFE1-12). Sai kiểu làm `pnpm -r typecheck` đỏ.
describe('P04 content contract types', () => {
  it('mảng bắt buộc không bao giờ null', () => {
    expectTypeOf<S['ItemSummary']['tags']>().toEqualTypeOf<S['TagRef'][]>();
    expectTypeOf<S['ItemList']['items']>().toEqualTypeOf<S['ItemSummary'][]>();
    expectTypeOf<S['ItemLookupResult']['items']>().toEqualTypeOf<S['ItemSummary'][]>();
    expectTypeOf<S['EntryChangesPage']['changes']>().toEqualTypeOf<S['EntryChange'][]>();
  });

  it('field nullable đúng chỗ', () => {
    expectTypeOf<S['ItemSummary']['hint']>().toEqualTypeOf<string | null>();
    expectTypeOf<S['ItemList']['next_cursor']>().toEqualTypeOf<string | null>();
    expectTypeOf<S['EntryChange']['deleted_at']>().toEqualTypeOf<string | null>();
    expectTypeOf<S['EntryChangesPage']['watermark']>().toEqualTypeOf<string>();
  });

  it('metadata entry không mang envelope/ciphertext', () => {
    expectTypeOf<S['EntryMeta']>().not.toHaveProperty('ciphertext');
    expectTypeOf<S['EntryMeta']>().not.toHaveProperty('envelope');
    expectTypeOf<S['EntryChange']>().not.toHaveProperty('ciphertext');
    expectTypeOf<S['EntryImportJsonRequest']>().not.toHaveProperty('filename');
  });

  it('header và tham số theo operation', () => {
    type ItemUpdateHeader = paths['/items/{id}']['patch']['parameters']['header'];
    expectTypeOf<ItemUpdateHeader>().toHaveProperty('If-Match');
    expectTypeOf<ItemUpdateHeader>().toHaveProperty('Idempotency-Key');
    type ChangesQuery = NonNullable<paths['/entries/changes']['get']['parameters']['query']>;
    expectTypeOf<ChangesQuery['since']>().toEqualTypeOf<string | undefined>();
    // Restore bắt buộc body `{}` để client luôn gửi Content-Type JSON (CFE2-2).
    type RestoreBody = { content: { 'application/json': S['EmptyObject'] } };
    expectTypeOf<paths['/items/{id}/restore']['post']['requestBody']>().toEqualTypeOf<RestoreBody>();
    expectTypeOf<paths['/tags/{id}/restore']['post']['requestBody']>().toEqualTypeOf<RestoreBody>();
    expectTypeOf<paths['/entries/{id}/restore']['post']['requestBody']>().toEqualTypeOf<RestoreBody>();
    type TagUpsert = paths['/tags']['post']['responses'];
    expectTypeOf<TagUpsert>().toHaveProperty(200);
    expectTypeOf<TagUpsert>().toHaveProperty(201);
  });
});
