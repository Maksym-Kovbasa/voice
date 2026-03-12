import { llm } from '@livekit/agents';
import { Pool } from 'pg';

type StoredMessage = {
  role: llm.ChatRole;
  content: string;
  createdAt: number;
};

export type StoredUserProfile = {
  userId: string;
  fields: Record<string, string[]>;
};

const NEON_DATABASE_URL = process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL;
const NEON_MEMORY_TABLE = process.env.NEON_MEMORY_TABLE ?? 'conversation_memory';
const NEON_PROFILE_TABLE = process.env.NEON_PROFILE_TABLE ?? 'user_profile_memory';
const MEMORY_MAX_ITEMS = Number.parseInt(process.env.MEMORY_MAX_ITEMS ?? '40', 10);

let pool: Pool | null = null;
let initPromise: Promise<void> | null = null;
let memoryDisabled = false;
let warnedMissingUrl = false;
let warnedLoadError = false;
let warnedSaveError = false;

function sanitizeTableName(input: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input)) {
    throw new Error(`Invalid NEON_MEMORY_TABLE: ${input}`);
  }
  return input;
}

const tableName = sanitizeTableName(NEON_MEMORY_TABLE);
const profileTableName = sanitizeTableName(NEON_PROFILE_TABLE);

async function disableMemory(): Promise<void> {
  memoryDisabled = true;
  initPromise = null;

  if (pool) {
    try {
      await pool.end();
    } catch {
      // ignore pool close errors
    }
  }

  pool = null;
}

async function getPool(): Promise<Pool | null> {
  if (memoryDisabled) return null;

  if (!NEON_DATABASE_URL) {
    if (!warnedMissingUrl) {
      console.warn('NEON_DATABASE_URL is not set. Conversation memory persistence is disabled.');
      warnedMissingUrl = true;
    }
    return null;
  }

  if (!pool) {
    pool = new Pool({
      connectionString: NEON_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }

  if (!initPromise) {
    initPromise = (async () => {
      await pool!.query(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id TEXT PRIMARY KEY,
          room_name TEXT NOT NULL,
          participant_identity TEXT,
          messages JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pool!.query(`
        CREATE TABLE IF NOT EXISTS ${profileTableName} (
          user_id TEXT PRIMARY KEY,
          fields JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      console.log('NeonDB connected');
    })().catch(async (error) => {
      console.error('NeonDB connection failed:', error);
      await disableMemory();
      throw error;
    });
  }

  await initPromise;
  return pool;
}

function toStoredMessages(chatCtx: llm.ChatContext): StoredMessage[] {
  const messages: StoredMessage[] = [];

  for (const item of chatCtx.items) {
    if (item.type !== 'message') continue;

    const text = item.textContent?.trim();
    if (!text) continue;

    messages.push({
      role: item.role,
      content: text,
      createdAt: item.createdAt,
    });
  }

  return messages.slice(-MEMORY_MAX_ITEMS);
}

export function buildConversationId({
  roomName,
  participantIdentity,
  stableUserId,
}: {
  roomName: string;
  participantIdentity?: string | null;
  stableUserId?: string | null;
}): string {
  if (stableUserId) return `user:${stableUserId}`;
  if (participantIdentity) return `participant:${participantIdentity}`;
  return `room:${roomName}`;
}

export async function loadChatMemory({
  conversationId,
}: {
  conversationId: string;
}): Promise<llm.ChatContext> {
  try {
    const db = await getPool();
    if (!db) return llm.ChatContext.empty();

    const result = await db.query<{ messages: StoredMessage[] | null }>(
      `SELECT messages FROM ${tableName} WHERE id = $1 LIMIT 1`,
      [conversationId],
    );

    const chatCtx = llm.ChatContext.empty();
    const messages = result.rows[0]?.messages ?? [];

    for (const message of messages) {
      chatCtx.addMessage({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      });
    }

    return chatCtx;
  } catch (error) {
    if (!warnedLoadError) {
      warnedLoadError = true;
      console.error('Failed to load Neon memory. Continuing without memory.', error);
    }
    await disableMemory();
    return llm.ChatContext.empty();
  }
}

export async function saveChatMemory({
  conversationId,
  roomName,
  participantIdentity,
  chatCtx,
}: {
  conversationId: string;
  roomName: string;
  participantIdentity?: string | null;
  chatCtx: llm.ChatContext;
}): Promise<void> {
  try {
    const db = await getPool();
    if (!db) return;

    const messages = JSON.stringify(toStoredMessages(chatCtx));

    await db.query(
      `
      INSERT INTO ${tableName} (id, room_name, participant_identity, messages, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        room_name = EXCLUDED.room_name,
        participant_identity = EXCLUDED.participant_identity,
        messages = EXCLUDED.messages,
        updated_at = NOW()
      `,
      [conversationId, roomName, participantIdentity ?? null, messages],
    );
  } catch (error) {
    if (!warnedSaveError) {
      warnedSaveError = true;
      console.error('Failed to save Neon memory. Continuing without persistence.', error);
    }
    await disableMemory();
  }
}

function sanitizeFieldKey(field: string): string {
  const normalized = field
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'general';
}

function normalizeRecommendedLinkValue(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) return cleaned;
  if (cleaned.includes('|||')) return cleaned;
  const match = /^(.*?)(?:,|\-|—)?\s*link\s+(.+)$/i.exec(cleaned);
  if (match) {
    const rawTitle = (match[1] ?? '').trim();
    const url = (match[2] ?? '').trim();
    if (!url) return cleaned;
    const normalizedTitle = rawTitle.replace(/^(movie|show|track|album)\s+/i, '').trim();
    return normalizedTitle ? `${normalizedTitle} ||| ${url}` : url;
  }
  return cleaned;
}
function normalizeFieldValues(value: string): string[] {
  const parts = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const source = parts.length > 0 ? parts : [value.trim()];
  const deduped = new Set<string>();
  const result: string[] = [];
  for (const item of source) {
    if (!item) continue;
    const key = item.toLowerCase();
    if (deduped.has(key)) continue;
    deduped.add(key);
    result.push(item);
  }
  return result;
}

function mergeProfileField(
  fields: Record<string, string[]>,
  field: string,
  value: string,
): Record<string, string[]> {
  const key = sanitizeFieldKey(field);
  const nextValues = field === 'recommended_links' ? normalizeFieldValues(normalizeRecommendedLinkValue(value)) : normalizeFieldValues(value);
  if (nextValues.length === 0) return fields;

  const current = fields[key] ?? [];
  const seen = new Set(current.map((item) => item.toLowerCase()));
  const merged = [...current];
  for (const candidate of nextValues) {
    const lower = candidate.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    merged.push(candidate);
  }
  return {
    ...fields,
    [key]: merged.slice(0, 30),
  };
}

function extractStoredLinkValue(value: string): string {
  const cleaned = value.trim();
  if (!cleaned.includes('|||')) return cleaned;
  const parts = cleaned.split('|||');
  if (parts.length < 2) return cleaned;
  return parts.slice(1).join('|||').trim();
}
function buildRemovalCandidates(value: string): string[] {
  const cleaned = value.trim();
  if (!cleaned) return [];
  const candidates = new Set<string>();
  candidates.add(cleaned);
  const lower = cleaned.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    const withoutScheme = cleaned.replace(/^(http|https):\/\//i, '');
    candidates.add(withoutScheme);
  } else {
    candidates.add(`https://${cleaned}`);
    candidates.add(cleaned.replace(/^\/\//, ''));
  }
  return Array.from(candidates).filter((item) => item.trim().length > 0);
}

export function removeProfileFieldValue(
  fields: Record<string, string[]>,
  field: string,
  value: string,
): Record<string, string[]> {
  const key = sanitizeFieldKey(field);
  const current = fields[key] ?? [];
  if (current.length === 0) return fields;

  const candidates = buildRemovalCandidates(value).map((item) => item.toLowerCase());
  if (candidates.length === 0) return fields;

  const filtered = current.filter((item) => {
    const storedValue = item.trim();
    const storedLink = extractStoredLinkValue(storedValue);
    const normalized = storedValue.toLowerCase();
    const normalizedLink = storedLink.trim().toLowerCase();
    if (candidates.includes(normalized)) return false;
    const withoutScheme = normalized.replace(/^(http|https):\/\//i, '');
    if (candidates.includes(withoutScheme)) return false;
    if (normalizedLink.length > 0) {
      if (candidates.includes(normalizedLink)) return false;
      const linkWithoutScheme = normalizedLink.replace(/^(http|https):\/\//i, '');
      if (candidates.includes(linkWithoutScheme)) return false;
    }
    return true;
  });

  if (filtered.length === current.length) {
    return fields;
  }

  const next = { ...fields };
  if (filtered.length === 0) {
    delete next[key];
  } else {
    next[key] = filtered;
  }
  return next;
}

export async function removeUserProfileFieldValue({
  userId,
  field,
  value,
}: {
  userId: string;
  field: string;
  value: string;
}): Promise<StoredUserProfile> {
  const loaded = await loadUserProfile({ userId });
  const fields = removeProfileFieldValue(loaded.fields, field, value);

  try {
    const db = await getPool();
    if (!db) {
      return { userId, fields };
    }
    await db.query(
      `
      INSERT INTO ${profileTableName} (user_id, fields, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        fields = EXCLUDED.fields,
        updated_at = NOW()
      `,
      [userId, JSON.stringify(fields)],
    );
  } catch (error) {
    console.error('Failed to remove user profile field in Neon. Continuing with in-memory value.', error);
  }

  return { userId, fields };
}

function enrichRecommendedLinkValue(
  fields: Record<string, string[]>,
  value: string,
): string {
  const normalized = normalizeRecommendedLinkValue(value);
  if (normalized.includes('|||')) {
    return normalized;
  }
  const items = fields.recommended_items ?? [];
  if (items.length === 0) {
    return normalized;
  }
  const title = items[items.length - 1]?.trim();
  if (!title) {
    return normalized;
  }
  return `${title} ||| ${normalized}`;
}
export async function loadUserProfile({
  userId,
}: {
  userId: string;
}): Promise<StoredUserProfile> {
  try {
    const db = await getPool();
    if (!db) {
      return { userId, fields: {} };
    }
    const result = await db.query<{ fields: Record<string, string[]> | null }>(
      `SELECT fields FROM ${profileTableName} WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    return {
      userId,
      fields: result.rows[0]?.fields ?? {},
    };
  } catch (error) {
    console.error('Failed to load user profile from Neon. Continuing with empty profile.', error);
    return { userId, fields: {} };
  }
}

export async function updateUserProfileField({
  userId,
  field,
  value,
}: {
  userId: string;
  field: string;
  value: string;
}): Promise<StoredUserProfile> {
  const loaded = await loadUserProfile({ userId });
  const nextValue = field === 'recommended_links' ? normalizeRecommendedLinkValue(value) : value;
  const fields = mergeProfileField(loaded.fields, field, nextValue);

  try {
    const db = await getPool();
    if (!db) {
      return { userId, fields };
    }
    await db.query(
      `
      INSERT INTO ${profileTableName} (user_id, fields, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        fields = EXCLUDED.fields,
        updated_at = NOW()
      `,
      [userId, JSON.stringify(fields)],
    );
  } catch (error) {
    console.error('Failed to update user profile in Neon. Continuing with in-memory value.', error);
  }

  return { userId, fields };
}

export async function clearUserMemory({
  userId,
}: {
  userId: string;
}): Promise<void> {
  try {
    const db = await getPool();
    if (!db) return;
    await db.query(`DELETE FROM ${profileTableName} WHERE user_id = $1`, [userId]);
    await db.query(`DELETE FROM ${tableName} WHERE id = $1`, [`user:${userId}`]);
  } catch (error) {
    console.error('Failed to clear user memory in Neon.', error);
  }
}

export async function closeMongo(): Promise<void> {
  await disableMemory();
}






