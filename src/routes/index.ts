/**
 * Route Index
 *
 * Re-exports all route modules for easy importing in server.ts
 */

export { default as healthRouter } from './health.js';
export { default as emailWebhookRouter } from './emailWebhook.js';
export { default as slackEventsRouter } from './slackEvents.js';
export { default as mondayWebhookRouter } from './mondayWebhook.js';
export { default as relayEventsRouter } from './relayEvents.js';
export { default as triageRouter } from './triageApi.js';

// Re-export middleware for use in routes that remain in server.ts
export { slackUrlEncodedWithRawBody, verifySlackSignature, type SlackRequest } from './middleware.js';
