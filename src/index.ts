import 'dotenv/config';
import { createServer } from './alert-receiver/index.js';

// LangSmith auto-configured via environment variables:
// LANGSMITH_API_KEY, LANGSMITH_PROJECT, LANGSMITH_TRACING
if (process.env.LANGSMITH_TRACING === 'true') {
  console.log(`LangSmith tracing enabled for project: ${process.env.LANGSMITH_PROJECT}`);
}

const PORT = process.env.PORT || 3000;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || 'mock';

// Vendor URL map - TODO: Load from config or database
const VENDOR_URL_MAP: Record<string, string> = {
  'vendor-sample': 'https://example.com',
  'vendor-timeout': 'https://httpstat.us/524?sleep=35000',
  'vendor-error': 'https://httpstat.us/503',
  'vendor-success': 'https://httpstat.us/200',
};

const app = createServer({
  slackWebhookUrl: SLACK_WEBHOOK_URL,
  vendorUrlMap: VENDOR_URL_MAP,
});

app.listen(PORT, () => {
  console.log(`Web Analysis Agent running on port ${PORT}`);
  console.log(`Slack mode: ${SLACK_WEBHOOK_URL === 'mock' ? 'MOCK (console output)' : 'LIVE'}`);
});
