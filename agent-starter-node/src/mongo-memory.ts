import { llm } from '@livekit/agents';
import { Pool } from 'pg';

type StoredMessage = {
  role: llm.ChatRole;
  content: string;
  createdAt: number;
};

const NEON_DATABASE_URL = process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL;
const NEON_MEMORY_TABLE = process.env.NEON_MEMORY_TABLE ?? 'conversation_memory';
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

export async function closeMongo(): Promise<void> {
  await disableMemory();
}
