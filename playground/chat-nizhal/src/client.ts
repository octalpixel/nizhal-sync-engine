import {
  type NizhalCollection,
  type NizhalSQLitePersistence,
  createCloudflareSubscribeSource,
  createNizhalClient,
  createNizhalMutators,
  manualOnlineDetector,
  nizhalCollectionOptions,
} from "@nizhal/db-collection";
import { createCollection } from "@tanstack/db";
import {
  type ChannelMemberRow,
  type ChannelRow,
  type MessageRow,
  type ReactionRow,
  chatMutators,
} from "./domain.js";

export interface ChatClientOptions {
  server?: string;
  token?: string;
  userId: string;
  /** The user's workspace (actor.ownerId). Channel authz is per-channel membership, not this. */
  workspaceId: string;
  /** Channel buckets to sync — must be channels the user is a member of (server enforces). */
  channelIds: string[];
  refreshToken?: () => Promise<string>;
  persistence?: NizhalSQLitePersistence;
  subscribeSource?: Parameters<typeof createNizhalClient>[0]["subscribeSource"];
  /** CF Worker host for edge realtime (e.g. nizhal-chat-realtime.you.workers.dev). REQUIRED for a
   *  serverless server (Vercel) — the function has no long-lived /sync/stream, so realtime must go
   *  through the Worker's per-bucket Durable Object. */
  realtimeHost?: string;
  /** Poll fallback for convergence (belt-and-suspenders alongside Worker realtime). */
  pullIntervalMs?: number;
}

export async function createChatClient(options: ChatClientOptions) {
  const echo = createNizhalClient({
    server: options.server,
    auth: options.token
      ? {
          headers: { authorization: `Bearer ${options.token}` },
          refresh: options.refreshToken
            ? async () => ({ authorization: `Bearer ${await options.refreshToken?.()}` })
            : undefined,
        }
      : undefined,
    subscribeSource:
      options.subscribeSource ??
      (options.realtimeHost
        ? createCloudflareSubscribeSource(options.realtimeHost, async () =>
            options.refreshToken ? await options.refreshToken() : (options.token ?? ""),
          )
        : undefined),
    ...(options.pullIntervalMs ? { pull: { intervalMs: options.pullIntervalMs } } : {}),
    // Workspace bucket → the channel directory + member list; channel buckets → one DO per room.
    bucketsForSyncRule: (rule) =>
      rule === "workspace" ? [options.workspaceId] : rule === "channel" ? options.channelIds : [],
  });
  const persistence = options.persistence?.persistence;

  const channels = createCollection(
    nizhalCollectionOptions<ChannelRow>({
      name: "channels",
      syncRule: "workspace",
      echo,
      bucketField: "workspace_id",
      getKey: (r) => r.id,
      persistence,
    }),
  ) as NizhalCollection<ChannelRow>;
  const channelMembers = createCollection(
    nizhalCollectionOptions<ChannelMemberRow>({
      name: "channel_members",
      syncRule: "workspace",
      echo,
      bucketField: "workspace_id",
      getKey: (r) => r.id,
      persistence,
    }),
  ) as NizhalCollection<ChannelMemberRow>;
  const messages = createCollection(
    nizhalCollectionOptions<MessageRow>({
      name: "messages",
      syncRule: "channel",
      echo,
      bucketField: "channel_id",
      getKey: (r) => r.id,
      persistence,
    }),
  ) as NizhalCollection<MessageRow>;
  const reactions = createCollection(
    nizhalCollectionOptions<ReactionRow>({
      name: "reactions",
      syncRule: "channel",
      echo,
      bucketField: "channel_id",
      getKey: (r) => r.id,
      persistence,
    }),
  ) as NizhalCollection<ReactionRow>;

  await Promise.all([
    channels.preload(),
    channelMembers.preload(),
    messages.preload(),
    reactions.preload(),
  ]);

  // Manual detector so the UI can force offline deterministically (no network surgery): setOnline(false)
  // holds the durable outbox; setOnline(true) flushes it. This is the genuine offline-first toggle.
  const onlineDetector = manualOnlineDetector();
  const mutators = createNizhalMutators({
    collections: { channels, channel_members: channelMembers, messages, reactions } as Record<
      string,
      NizhalCollection<object>
    >,
    echo,
    actor: { userId: options.userId, ownerId: options.workspaceId },
    mutators: chatMutators,
    outboxStorage: options.persistence?.outboxStorage,
    mutationIdStorage: options.persistence?.metaStorage, // sequence-hardening contract
    deadLetterStorage: options.persistence?.deadLetterStorage,
    clientID: options.persistence?.clientId,
    onlineDetector,
  });
  await mutators.executor.waitForInit();

  return {
    channels,
    channelMembers,
    messages,
    reactions,
    onlineDetector,
    echo,
    mutate: mutators.mutate,
    deadLetter: mutators.deadLetter,
    retryDeadLetter: mutators.retryDeadLetter,
    onDeadLetterChange: mutators.onDeadLetterChange,
    waitForIdle: mutators.waitForIdle,
    dispose: mutators.dispose,
  };
}

export type ChatClient = Awaited<ReturnType<typeof createChatClient>>;
