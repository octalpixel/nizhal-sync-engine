import type { NizhalAuthConfig } from "./types.js";

export interface BlobStore {
  put(clientMutationId: string, blob: Blob): Promise<void>;
  get(clientMutationId: string): Promise<Blob | undefined>;
  delete(clientMutationId: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface NizhalBlobs {
  presign(input: {
    key: string;
    mime: string;
    maxBytes?: number;
    expiresInSec?: number;
    bucket?: string;
  }): Promise<{ url: string; method: string; headers?: Record<string, string>; key: string }>;
  upload(input: {
    file: Blob;
    clientMutationId: string;
    bucket?: string;
    pushReference: (args: { key: string; status: "pending" | "synced" }) => Promise<void>;
  }): Promise<{ key: string; clientMutationId: string; status: "pending" | "synced" }>;
  urlFor(ref: { key: string }): Promise<{ url: string }>;
  flushPending(
    pushReference: (args: {
      key: string;
      status: "pending" | "synced";
    }) => Promise<void>,
  ): Promise<void>;
}

export interface CreateNizhalBlobsOptions {
  server: string;
  auth?: NizhalAuthConfig;
  store: BlobStore;
  online?: () => boolean;
}

export function createNizhalBlobs(options: CreateNizhalBlobsOptions): NizhalBlobs {
  const server = options.server.replace(/\/$/, "");
  const store = options.store;
  const online = options.online ?? (() => true);

  async function fetchPresign(input: {
    key: string;
    mime: string;
    maxBytes?: number;
    expiresInSec?: number;
    bucket?: string;
  }): Promise<{ url: string; method: string; headers?: Record<string, string>; key: string }> {
    const response = await fetch(`${server}/nizhal/blob/presign-upload`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(options.auth),
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error(`presign failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as {
      url: string;
      method: string;
      headers?: Record<string, string>;
      key: string;
    };
  }

  async function uploadBytes(key: string, file: Blob): Promise<void> {
    const presign = await fetchPresign({
      key,
      mime: file.type || "application/octet-stream",
      maxBytes: file.size,
    });
    const response = await fetch(presign.url, {
      method: presign.method,
      headers: presign.headers,
      body: file,
    });
    if (!response.ok) {
      throw new Error(`blob upload failed: ${response.status} ${await response.text()}`);
    }
  }

  return {
    presign: fetchPresign,
    async upload(input) {
      const key = await keyForBlob(input.file);
      if (!online()) {
        await store.put(input.clientMutationId, input.file);
        await input.pushReference({ key, status: "pending" });
        return { key, clientMutationId: input.clientMutationId, status: "pending" };
      }
      await uploadBytes(key, input.file);
      await input.pushReference({ key, status: "synced" });
      return { key, clientMutationId: input.clientMutationId, status: "synced" };
    },
    async urlFor(ref) {
      const response = await fetch(`${server}/nizhal/blob/${encodeURIComponent(ref.key)}/url`, {
        headers: authHeaders(options.auth),
      });
      if (!response.ok) {
        throw new Error(`download url failed: ${response.status} ${await response.text()}`);
      }
      return (await response.json()) as { url: string };
    },
    async flushPending(pushReference) {
      const ids = await store.list();
      for (const clientMutationId of ids) {
        const file = await store.get(clientMutationId);
        if (!file) continue;
        const key = await keyForBlob(file);
        await uploadBytes(key, file);
        await pushReference({ key, status: "synced" });
        await store.delete(clientMutationId);
      }
    },
  };
}

export function memoryBlobStore(): BlobStore {
  const blobs = new Map<string, Blob>();
  return {
    async put(clientMutationId, blob) {
      blobs.set(clientMutationId, blob);
    },
    async get(clientMutationId) {
      return blobs.get(clientMutationId);
    },
    async delete(clientMutationId) {
      blobs.delete(clientMutationId);
    },
    async list() {
      return Array.from(blobs.keys());
    },
  };
}

export async function keyForBlob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function authHeaders(auth: NizhalAuthConfig | undefined): Record<string, string> {
  return auth?.headers ?? {};
}
