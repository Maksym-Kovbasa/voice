import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  metrics,
  voice,
} from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { Agent } from './agent';
import { buildConversationId, loadChatMemory, saveChatMemory } from './mongo-memory';
import { closeMongo } from './mongo-memory';

// Load environment variables from a local file.
// Make sure to set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET
// when running locally or self-hosting your agent server.
dotenv.config({ path: '.env.local' });

process.on('SIGINT', async () => {
  await closeMongo();
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  // LiveKit may emit a disconnect-time rejection with `undefined` reason.
  // Ignore this specific case to avoid noisy false-positive error logs.
  if (reason === undefined) {
    return;
  }

  const trace = new Error('Unhandled rejection trace');
  console.error('UNHANDLED_REJECTION:', {
    reason,
    promise,
    trace: trace.stack,
  });
});

process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT_EXCEPTION:', error);
});

function extractStableUserId(participant: {
  identity?: string;
  metadata?: string;
  attributes?: Record<string, string>;
}): string | null {
  const keys = ['user_id', 'userId', 'uid', 'id', 'sub'];
  const attrs = participant.attributes ?? {};

  for (const key of keys) {
    const value = attrs[key];
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }

  const metadata = participant.metadata?.trim();
  if (!metadata) {
    return participant.identity?.trim() ?? null;
  }

  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
  } catch {
    // Metadata is plain text, not JSON. Use directly.
    return metadata;
  }

  return null;
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const participant = await ctx.waitForParticipant();
    const roomName = ctx.room.name || 'default-room';
    const participantIdentity = participant.identity;
    const fallbackUserId = process.env.MEMORY_FALLBACK_USER_ID?.trim() || null;
    const stableUserId = extractStableUserId({
      identity: participant.identity,
      metadata: participant.metadata,
      attributes: participant.attributes as Record<string, string> | undefined,
    }) ?? fallbackUserId;
    const conversationId = buildConversationId({
      roomName,
      participantIdentity,
      stableUserId,
    });
    console.log('Using conversation memory key:', conversationId);
    const initialChatCtx = await loadChatMemory({ conversationId });

    // Set up a voice AI pipeline using OpenAI, Cartesia, Deepgram, and the LiveKit turn detector
    const session = new voice.AgentSession({
      // Speech-to-text (STT) is your agent's ears, turning the user's speech into text that the LLM can understand
      // See all available models at https://docs.livekit.io/agents/models/stt/
      stt: new inference.STT({
        model: 'deepgram/nova-3',
        language: 'multi',
      }),

      // A Large Language Model (LLM) is your agent's brain, processing user input and generating a response
      // See all providers at https://docs.livekit.io/agents/models/llm/
      llm: new inference.LLM({
        model: 'openai/gpt-4.1-mini',
      }),

      // Text-to-speech (TTS) is your agent's voice, turning the LLM's text into speech that the user can hear
      // See all available models as well as voice selections at https://docs.livekit.io/agents/models/tts/
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),

      // VAD and turn detection are used to determine when the user is speaking and when the agent should respond
      // See more at https://docs.livekit.io/agents/build/turns
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      vad: ctx.proc.userData.vad! as silero.VAD,
      voiceOptions: {
        // Allow the LLM to generate a response while waiting for the end of turn
        preemptiveGeneration: true,
      },
    });

    // To use a realtime model instead of a voice pipeline, use the following session setup instead.
    // (Note: This is for the OpenAI Realtime API. For other providers, see https://docs.livekit.io/agents/models/realtime/))
    // 1. Install '@livekit/agents-plugin-openai'
    // 2. Set OPENAI_API_KEY in .env.local
    // 3. Add import `import * as openai from '@livekit/agents-plugin-openai'` to the top of this file
    // 4. Use the following session setup instead of the version above
    // const session = new voice.AgentSession({
    //   llm: new openai.realtime.RealtimeModel({ voice: 'marin' }),
    // });

    // Metrics collection, to measure pipeline performance
    // For more information, see https://docs.livekit.io/agents/build/metrics/
    const usageCollector = new metrics.UsageCollector();
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
      usageCollector.collect(ev.metrics);
    });

    const logUsage = async () => {
      const summary = usageCollector.getSummary();
      console.log(`Usage: ${JSON.stringify(summary)}`);
    };

    ctx.addShutdownCallback(logUsage);

    let persistQueue: Promise<void> = Promise.resolve();
    const queuePersist = () => {
      persistQueue = persistQueue
        .then(() =>
          saveChatMemory({
            conversationId,
            roomName,
            participantIdentity,
            chatCtx: session.history,
          }),
        )
        .catch((error) => {
          console.error('Failed to persist conversation memory:', error);
        });
      return persistQueue;
    };

    // Start the session, which initializes the voice pipeline and warms up the models
    await session.start({
      agent: new Agent({ chatCtx: initialChatCtx }),
      room: ctx.room,
      inputOptions: {
        // LiveKit Cloud enhanced noise cancellation
        // - If self-hosting, omit this parameter
        // - For telephony applications, use `BackgroundVoiceCancellationTelephony` for best results
        noiseCancellation: BackgroundVoiceCancellation(),
        // Keep session alive when client temporarily disconnects, so reconnect is seamless.
        closeOnDisconnect: false,
      },
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, () => {
      void queuePersist();
    });
    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, () => {
      void queuePersist();
    });
    ctx.addShutdownCallback(async () => {
      await queuePersist();
    });

    session.generateReply({
      instructions: 'Start the conversation exactly according to your rules.',
    });

    let participantTemporarilyDisconnected = false;
    ctx.room.on('participantDisconnected', (p) => {
      if (p.identity === participantIdentity) {
        participantTemporarilyDisconnected = true;
      }
    });
    ctx.room.on('participantConnected', (p) => {
      if (p.identity === participantIdentity && participantTemporarilyDisconnected) {
        participantTemporarilyDisconnected = false;
        session.generateReply({
          instructions: 'Welcome the user back briefly and continue the conversation naturally.',
        });
      }
    });
  },
});

// Run the agent server
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'my-agent',
  }),
);
