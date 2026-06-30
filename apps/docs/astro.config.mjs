import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

export default defineConfig({
  site: 'https://nizhal.dev',
  integrations: [
    starlight({
      title: 'Nizhal',
      description:
        'Self-host, no-WAL offline-first sync engine — a sync API embedded in your own backend on any Postgres.',
      logo: { src: './src/assets/logo.svg' },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/docs-theme.css'],
      head: [
        {
          tag: 'script',
          content:
            "document.documentElement.setAttribute('data-theme','dark');try{localStorage.setItem('starlight-theme','dark')}catch(e){}",
        },
      ],
      components: {
        PageTitle: './src/components/PageTitle.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
      },
      plugins: [
        starlightLlmsTxt({
          projectName: 'Nizhal',
          description:
            'Nizhal is a self-host, replication-free offline sync engine: @nizhal/server on any Postgres (cursor pull + idempotent push + tombstones, no WAL) plus @nizhal/db-collection as a TanStack DB SyncConfig adapter with durable outbox.',
          details:
            'Not a hosted sync service — a sync API you embed in your backend. Declarative sync rules, server-side mutators, bucket-scoped realtime pings, and TanStack DB for local store + live queries + offline writes.',
        }),
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/octalpixel/nizhal',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/octalpixel/nizhal/edit/main/apps/docs/',
      },
      sidebar: [
        {
          label: 'Introduction',
          items: [{ slug: 'introduction' }, { slug: 'compare', label: 'Compare' }],
        },
        {
          label: 'Getting Started',
          items: [
            { slug: 'getting-started/quickstart' },
            { slug: 'getting-started/agent-setup' },
            { slug: 'getting-started/first-app' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { slug: 'concepts/how-sync-works' },
            { slug: 'concepts/sync-modes' },
            { slug: 'concepts/conflict-resolution' },
            { slug: 'concepts/sync-rules-and-buckets' },
            { slug: 'concepts/realtime' },
            { slug: 'concepts/offline-and-persistence' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { slug: 'guides/build-a-ledger-app' },
            { slug: 'guides/build-an-offline-web-app' },
            { slug: 'guides/build-an-offline-rn-app' },
            { slug: 'guides/add-offline-to-an-existing-postgres-app' },
            { slug: 'guides/bring-your-own-backend' },
            { slug: 'guides/build-offline-first-app' },
            { slug: 'guides/multi-device-sync' },
            { slug: 'guides/deploy-to-production' },
            { slug: 'guides/choosing-conflict-strategy' },
          ],
        },
        {
          label: 'Server',
          items: [
            { slug: 'server/create-nizhal-server' },
            { slug: 'server/storage' },
            { slug: 'server/realtime' },
            { slug: 'server/auth' },
            { slug: 'server/blob' },
            { slug: 'server/observability' },
            { slug: 'server/audit-log' },
            { slug: 'server/jobs' },
          ],
        },
        {
          label: 'Client',
          items: [
            { slug: 'client/create-nizhal-client' },
            { slug: 'client/collection-options' },
            { slug: 'client/mutators' },
            { slug: 'client/persistence' },
            { slug: 'client/presence' },
          ],
        },
        {
          label: 'React Native',
          items: [{ slug: 'react-native' }],
        },
        {
          label: 'Reference',
          items: [
            { slug: 'reference/api' },
            { slug: 'reference/cli' },
            { slug: 'reference/contract' },
          ],
        },
        {
          label: 'Self-hosting',
          items: [
            { slug: 'self-hosting/node' },
            { slug: 'self-hosting/bun' },
            { slug: 'self-hosting/cloudflare' },
            { slug: 'self-hosting/vercel' },
            { slug: 'self-hosting/managed-postgres' },
            { slug: 'self-hosting/turso-libsql' },
          ],
        },
        {
          label: 'Production',
          items: [
            { slug: 'production/deployment' },
            { slug: 'production/scaling' },
            { slug: 'production/scaling-cloudflare' },
            { slug: 'production/validation' },
          ],
        },
      ],
    }),
  ],
});
