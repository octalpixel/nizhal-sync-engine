---
title: Blob storage
description: BlobAdapter, presigned URLs, and client blob helpers.
---

Large binaries sync via **reference rows** + presigned upload/download — not inline in pull payloads.

## Server adapters

```ts
import { localFsBlobStore, s3BlobStore, r2BlobStore, blobDb } from "@nizhal/server/adapters";

const blob = localFsBlobStore({ root: "./uploads" });
// or s3BlobStore({ bucket, region, ... })
// or r2BlobStore({ accountId, bucket, ... })

createNizhalServer({ ..., blob, storage });
```

`BlobAdapter` provides presigned upload/download URLs. Reference metadata rows sync through normal `postgresStorage` pull; use `blobDb(storage)` for Drizzle access to blob tables.

## Client

```ts
import { createNizhalBlobs, memoryBlobStore, keyForBlob } from "@nizhal/db-collection";

const blobs = createNizhalBlobs({ echo, store: memoryBlobStore() });
```

Upload flow: presign → PUT bytes → mutator records reference row → peers pull reference → presigned GET.
