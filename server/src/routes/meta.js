const express = require('express');
const cfg = require('../config');

const r = express.Router();

r.get('/openapi.json', (_req, res) => res.json(spec()));
r.get('/health', (_req, res) => res.json({ ok: true, version: '2.0.0', uptime: process.uptime() }));

function spec() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Ad Injection API',
      version: '2.0.0',
      description: 'Multi-tenant live-stream ad injection. Use API keys (`Authorization: Bearer adi_...`) for programmatic access, or session tokens for dashboard actions. WebSocket viewer endpoint is `/ws?channel=<slug>&token=<viewer_jwt>`.',
    },
    servers: [{ url: cfg.publicUrl }],
    components: {
      securitySchemes: {
        ApiKey: { type: 'http', scheme: 'bearer', description: 'API key: `adi_<prefix>_<secret>`' },
        Session: { type: 'http', scheme: 'bearer', description: 'Session JWT from `/v1/auth/login`' },
      },
    },
    security: [{ ApiKey: [] }, { Session: [] }],
    paths: {
      '/v1/auth/register': { post: { summary: 'Create tenant account', responses: { '201': { description: 'Created' } } } },
      '/v1/auth/login':    { post: { summary: 'Login → session JWT',   responses: { '200': { description: 'OK' } } } },
      '/v1/auth/me':       { get:  { summary: 'Current tenant',        security: [{ Session: [] }] },
                             patch:{ summary: 'Update tenant',         security: [{ Session: [] }] } },
      '/v1/auth/keys':     { get:  { summary: 'List API keys',         security: [{ Session: [] }] },
                             post: { summary: 'Create API key',        security: [{ Session: [] }] } },
      '/v1/auth/keys/{id}':{ delete:{ summary: 'Revoke API key',       security: [{ Session: [] }] } },

      '/v1/channels':      { get:  { summary: 'List channels' }, post: { summary: 'Create channel' } },
      '/v1/channels/{id}': { get:  { summary: 'Get channel' },   patch:{ summary: 'Update' }, delete:{ summary: 'Delete' } },
      '/v1/channels/{id}/viewer-token': { post: { summary: 'Issue viewer JWT (short-lived)' } },
      '/v1/channels/{id}/state':        { get:  { summary: 'Current live/ad state + viewer count' } },
      '/v1/channels/{id}/trigger':      { post: { summary: 'Trigger ad on channel' } },
      '/v1/channels/{id}/resume':       { post: { summary: 'Force resume live' } },
      '/v1/channels/{id}/triggers':     { get:  { summary: 'Trigger history' } },

      '/v1/ads':                { get: { summary: 'List ads' }, post: { summary: 'Create ad from URL' } },
      '/v1/ads/upload':         { post: { summary: 'Upload ad file (multipart/form-data)' } },
      '/v1/ads/{id}':           { get: { summary: 'Get ad' }, delete: { summary: 'Delete ad' } },
      '/v1/ads/{id}/signed-url':{ get: { summary: 'Get playable signed URL for the asset' } },

      '/v1/analytics/overview':   { get: { summary: 'Tenant-level analytics' } },
      '/v1/analytics/channels/{id}': { get: { summary: 'Per-channel analytics' } },
      '/v1/analytics/events':     { get: { summary: 'Raw event stream' } },

      '/v1/webhooks/test':        { post: { summary: 'Fire a synthetic test event to your webhook_url' } },

      '/v1/admin/tenants':        { get: { summary: 'Platform-admin: list all tenants' } },
      '/v1/admin/tenants/{id}':   { get: { summary: 'Platform-admin: tenant detail' },
                                    patch: { summary: 'Platform-admin: update plan/disabled/name' },
                                    delete:{ summary: 'Platform-admin: delete tenant' } },
      '/v1/admin/tenants/{id}/impersonate': { post: { summary: 'Platform-admin: mint a session token as this tenant' } },
      '/v1/admin/stats':          { get: { summary: 'Platform-admin: cross-tenant totals' } },
      '/v1/admin/audit':          { get: { summary: 'Platform-admin: audit log' } },

      '/health':          { get: { summary: 'Liveness' } },
      '/openapi.json':    { get: { summary: 'This spec' } },
    },
  };
}

module.exports = r;
