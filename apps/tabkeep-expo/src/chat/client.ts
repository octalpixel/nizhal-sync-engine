import {
  type NizhalCollection,
  createNizhalMutators,
  manualOnlineDetector,
  nizhalCollectionOptions,
} from "@nizhal/db-collection";
import { createNizhalNitroClient, reactNativeOnlineDetector } from "@nizhal/react-native";
import { createCollection } from "@tanstack/db";
import {
  type ChannelMemberRow,
  type ChannelRow,
  type MessageRow,
  type ReactionRow,
  chatMutators,
} from "./domain";
import { openChatPersistence } from "./persistence";

export interface ChatExpoClientOptions {
  server: string;
  realtimeHost?: string;
  token?: string;
  userId: string;
  workspaceId: string;
  channelIds: string[];
  refreshToken?: () => Promise<string>;
}

// Native chat client: nitro transport (native WS realtime via the CF Worker on a serverless server) +
// op-sqlite durable replica. Same engine + two-bucket chat domain as the web client — only the local
// store + transport differ. op-sqlite persistence is what makes messages survive an app restart.
export async function createChatExpoClient(options: ChatExpoClientOptions) {
  const store = await openChatPersistence();
  const echo = createNizhalNitroClient({
    server: options.server,
    token: options.token,
    realtimeHost: options.realtimeHost,
    auth: options.token
      ? {
          headers: { authorization: `Bearer ${options.token}` },
          refresh: options.refreshToken
            ? async () => ({ authorization: `Bearer ${await options.refreshToken?.()}` })
            : undefined,
        }
      : undefined,
    bucketsForSyncRule: (rule) =>
      rule === "workspace" ? [options.workspaceId] : rule === "channel" ? options.channelIds : [],
  });
  const persistence = store?.persistence;
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

  const onlineDetector = manualOnlineDetector(reactNativeOnlineDetector());
  const mutators = createNizhalMutators({
    collections: { channels, channel_members: channelMembers, messages, reactions } as Record<
      string,
      NizhalCollection<object>
    >,
    echo,
    actor: { userId: options.userId, ownerId: options.workspaceId },
    mutators: chatMutators,
    outboxStorage: store?.outboxStorage,
    mutationIdStorage: store?.metaStorage,
    deadLetterStorage: store?.deadLetterStorage,
    clientID: store?.clientId,
    onlineDetector,
  });
  await mutators.executor.waitForInit();

  return {
    channels,
    channelMembers,
    messages,
    reactions,
    mutate: mutators.mutate,
    onlineDetector,
    deadLetter: mutators.deadLetter,
    retryDeadLetter: mutators.retryDeadLetter,
    onDeadLetterChange: mutators.onDeadLetterChange,
    dispose: mutators.dispose,
    user: options.userId,
    channelId: options.channelIds[0] as string,
  };
}

export type ChatExpoClient = Awaited<ReturnType<typeof createChatExpoClient>>;
