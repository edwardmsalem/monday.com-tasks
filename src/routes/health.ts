/**
 * Health Check Route
 *
 * Comprehensive endpoint for monitoring service health,
 * external API connectivity, and system status.
 */

import { Router, type Request, type Response } from 'express';
import { checkHealth } from '../services/healthCheck.js';

const router = Router();

/**
 * GET /health
 *
 * Returns comprehensive health check including:
 * - Service status (Monday, Slack, Gmail, ConvertAPI)
 * - Circuit breaker states
 * - Job queue stats
 * - Server uptime
 *
 * Query params:
 * - refresh=true: Bypass cache and perform fresh checks
 *
 * Response codes:
 * - 200: healthy or degraded
 * - 503: unhealthy (core services down)
 */
router.get('/health', async (req: Request, res: Response) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const health = await checkHealth(forceRefresh);

    // Return 200 for healthy/degraded, 503 for unhealthy
    const statusCode = health.status === 'unhealthy' ? 503 : 200;

    res.status(statusCode).json(health);
  } catch (error) {
    console.error('Health check error:', error);
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date(),
      error: error instanceof Error ? error.message : 'Health check failed',
    });
  }
});

export default router;
