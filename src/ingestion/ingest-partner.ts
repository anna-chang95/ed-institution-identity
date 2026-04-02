// Partner payload ingestion
// Receives raw data from a partner and writes it to MongoDB staging.
// No normalization or validation happens here — raw data is preserved exactly.
// The pipeline (normalize → match → resolve) runs separately.

import { getRawPayloadsCollection } from '../lib/mongo';
import { RawPartnerPayload } from '../types';

// ---------------------------------------------------------------------------
// ingestPartnerPayload
// Entry point for all incoming partner data.
// Writes the raw payload to MongoDB and returns the inserted document ID.
// ---------------------------------------------------------------------------

export async function ingestPartnerPayload(
  payload: Omit<RawPartnerPayload, 'receivedAt'>
): Promise<string> {
  const collection = await getRawPayloadsCollection();

  const document: RawPartnerPayload = {
    ...payload,
    receivedAt: new Date(),
  };

  const result = await collection.insertOne(document);
  return result.insertedId.toString();
}

// ---------------------------------------------------------------------------
// getPendingPayloads
// Fetches raw payloads that have not yet been processed by the pipeline.
// In production this would be driven by a queue or a scheduled job.
// ---------------------------------------------------------------------------

export async function getPendingPayloads(
  limit: number = 100
): Promise<RawPartnerPayload[]> {
  const collection = await getRawPayloadsCollection();

  return collection
    .find({ processed: { $exists: false } })
    .limit(limit)
    .toArray() as unknown as RawPartnerPayload[];
}

// ---------------------------------------------------------------------------
// markPayloadProcessed
// Called after the pipeline successfully resolves a payload.
// Stamps the document with processedAt so it is not re-processed.
// ---------------------------------------------------------------------------

export async function markPayloadProcessed(
  partnerId: string,
  partnerKey: string,
  institutionId: string
): Promise<void> {
  const collection = await getRawPayloadsCollection();

  await collection.updateOne(
    { partnerId, partnerKey },
    {
      $set: {
        processed:      true,
        processedAt:    new Date(),
        institutionId,  // resolved canonical ID stored back for reference
      },
    }
  );
}
