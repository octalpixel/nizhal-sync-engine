---
title: Auth
description: bearerTokenAuth and issueBearerToken for sync endpoints.
---

```ts
import { bearerTokenAuth, issueBearerToken } from "@nizhal/server";

const auth = bearerTokenAuth({ secret: process.env.JWT_SECRET! });

const token = issueBearerToken({
  userId: "user-1",
  ownerId: "owner-1",
  shopId: "shop-1", // optional extra claims → actor.*
  secret: process.env.JWT_SECRET!,
});
```

## NizhalAuth

`auth.resolve(req)` returns `{ userId, ownerId, ...claims }` or `null`. Unauthenticated pull/push/stream requests receive 401.

Pass resolved `actor` into mutator context and sync-rule parameter evaluation.

## Client wiring

```ts
createNizhalClient({
  auth: {
    getHeaders: () => ({ Authorization: `Bearer ${token}` }),
    refresh: async () => { /* rotate token */ },
  },
});
```

`refresh` runs on 401 so long-lived sessions can recover without wedging the outbox.

## WebSocket auth

The browser's native `WebSocket` can't set upgrade headers, so it sends the bearer token on the `?token=` query string. React Native uses `nitroWebSocketSource({ token })` for true `Authorization`-header auth on the upgrade (with `?token=` fallback).

## Admin stats

`GET /nizhal/stats` accepts `Authorization: Bearer <ADMIN_PASSWORD>` when `adminPassword()` env is set.
