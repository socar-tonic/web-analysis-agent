import { z } from 'zod';

export const ConnectionStatusSchema = z.enum(['success', 'timeout', 'error']);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const NetworkLogSchema = z.object({
  url: z.string(),
  method: z.string(),
  status: z.number(),
  responseType: z.string(),
});
export type NetworkLog = z.infer<typeof NetworkLogSchema>;

export const ScreenshotSchema = z.object({
  step: z.string(),
  base64: z.string(),
});
export type Screenshot = z.infer<typeof ScreenshotSchema>;

export const DOMSnapshotSchema = z.object({
  loginForm: z.string().optional(),
  searchForm: z.string().optional(),
  applyButton: z.string().optional(),
  resultArea: z.string().optional(),
});
export type DOMSnapshot = z.infer<typeof DOMSnapshotSchema>;

export const SiteAnalysisSchema = z.object({
  vendorId: z.string().min(1),
  timestamp: z.string().datetime(),
  connectionStatus: ConnectionStatusSchema,
  httpStatus: z.number().optional(),
  domSnapshot: DOMSnapshotSchema.optional(),
  networkLogs: z.array(NetworkLogSchema).optional(),
  screenshots: z.array(ScreenshotSchema).optional(),
});

export type SiteAnalysis = z.infer<typeof SiteAnalysisSchema>;
