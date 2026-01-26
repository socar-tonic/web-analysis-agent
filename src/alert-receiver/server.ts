import express, { Request, Response, Express } from 'express';
import { FailureAlertSchema } from '../schemas/index.js';
import { createWorkflow } from '../graph/index.js';

interface ServerConfig {
  slackWebhookUrl: string;
  vendorUrlMap: Record<string, string>;
}

export function createServer(config: ServerConfig): Express {
  const app = express();
  app.use(express.json());

  const workflow = createWorkflow({
    slackWebhookUrl: config.slackWebhookUrl,
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  app.post('/webhook/alert', async (req: Request, res: Response) => {
    try {
      const parseResult = FailureAlertSchema.safeParse({
        ...req.body,
        timestamp: req.body.timestamp || new Date().toISOString(),
      });

      if (!parseResult.success) {
        res.status(400).json({
          error: `Invalid alert: vendorId is required`,
        });
        return;
      }

      const alert = parseResult.data;
      const vendorUrl = config.vendorUrlMap[alert.vendorId];

      if (!vendorUrl) {
        res.status(404).json({ error: `Unknown vendor: ${alert.vendorId}` });
        return;
      }

      console.log(`[Alert Receiver] Processing alert for vendor: ${alert.vendorId}`);

      const result = await workflow.invoke({
        vendorId: alert.vendorId,
        vendorUrl,
      });

      res.json({
        success: true,
        vendorId: alert.vendorId,
        diagnosis: result.diagnosis?.diagnosis,
        summary: result.diagnosis?.summary,
        agentResults: result.agentResults?.map(r => ({
          agent: r.agent,
          diagnosis: r.diagnosis,
          confidence: r.confidence,
        })),
        notificationSent: result.notificationSent,
      });
    } catch (error) {
      console.error('[Alert Receiver] Error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  });

  return app;
}
