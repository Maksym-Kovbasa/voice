# Voice Agent Backend

Node.js/TypeScript backend for voice assistant application.
Runs as LiveKit agent with persistent memory via Neon Postgres.

## Stack
- LiveKit Agents SDK (TypeScript)
- Neon Postgres for user profile storage
- Docker for deployment

## Environment Variables
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
NEON_DATABASE_URL=

## Run locally
pnpm install
pnpm run dev

## Run with Docker
docker build -t voice-agent .
docker run --env-file .env voice-agent

## RPC Actions (for Frontend)
- profile_sync — full profile synchronization
- field_updated — update a single field
- memory_cleared — clear user memory
