// MongoDB client
// Used exclusively for the raw partner payload staging layer.
// Clean canonical data lives in PostgreSQL — never in MongoDB.

import { MongoClient, Collection, Db } from 'mongodb';
import { RawPartnerPayload } from '../types';

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const DB_NAME     = 'hs_institution';

let client:   MongoClient | null = null;
let database: Db | null = null;

async function getDb(): Promise<Db> {
  if (!database) {
    client   = new MongoClient(MONGODB_URI);
    await client.connect();
    database = client.db(DB_NAME);
  }
  return database;
}

// ---------------------------------------------------------------------------
// RAW PARTNER PAYLOADS collection
// Documents are stored exactly as received from partners.
// Schema is intentionally flexible — partners send different shapes.
// ---------------------------------------------------------------------------

export async function getRawPayloadsCollection(): Promise<Collection<RawPartnerPayload>> {
  const db = await getDb();
  return db.collection<RawPartnerPayload>('raw_partner_payloads');
}

export async function closeMongoConnection(): Promise<void> {
  if (client) {
    await client.close();
    client   = null;
    database = null;
  }
}
