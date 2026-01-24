import { chromium, Browser } from 'playwright';
import { SiteAnalysis, NetworkLog, Screenshot } from '../schemas/index.js';

export class Analyzer {
  private timeout = 30000;

  async analyzeSite(vendorId: string, url: string): Promise<SiteAnalysis> {
    const timestamp = new Date().toISOString();
    let browser: Browser | null = null;

    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();

      const networkLogs: NetworkLog[] = [];
      page.on('response', (response) => {
        networkLogs.push({
          url: response.url(),
          method: response.request().method(),
          status: response.status(),
          responseType: response.headers()['content-type'] || 'unknown',
        });
      });

      const response = await page.goto(url, {
        timeout: this.timeout,
        waitUntil: 'domcontentloaded',
      });

      const httpStatus = response?.status() ?? 0;
      const screenshots: Screenshot[] = [];

      try {
        const screenshotBuffer = await page.screenshot();
        screenshots.push({
          step: 'initial',
          base64: screenshotBuffer.toString('base64'),
        });
      } catch {
        // Screenshot failed, continue without it
      }

      await page.close();

      return {
        vendorId,
        timestamp,
        connectionStatus: 'success',
        httpStatus,
        networkLogs,
        screenshots,
      };
    } catch (error) {
      const isTimeout =
        error instanceof Error &&
        (error.message.includes('timeout') || error.message.includes('Timeout'));

      return {
        vendorId,
        timestamp,
        connectionStatus: isTimeout ? 'timeout' : 'error',
      };
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
}
