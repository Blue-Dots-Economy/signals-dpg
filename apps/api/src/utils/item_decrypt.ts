import { decryptPiiBlob, getPiiKey } from '@dpg/auth';
import { mergeItemStateWithPrivate } from '@dpg/schemas';

type JsonRecord = Record<string, unknown>;

export interface DecryptItemPrivateInput {
  item_state: JsonRecord;
  item_private_state: string;
}

export function decryptItemPrivate(
  row: DecryptItemPrivateInput
): { mergedState: JsonRecord } {
  if (!row.item_private_state) {
    return { mergedState: row.item_state };
  }
  const decryptedJson = decryptPiiBlob(row.item_private_state, getPiiKey());
  const decrypted = JSON.parse(decryptedJson) as JsonRecord;
  return { mergedState: mergeItemStateWithPrivate(row.item_state, decrypted) };
}
