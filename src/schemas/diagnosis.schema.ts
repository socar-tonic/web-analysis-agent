import { z } from 'zod';

export const DiagnosisTypeSchema = z.enum([
  'SERVER_OR_FIREWALL',
  'SIGNATURE_CHANGED',
  'INTERNAL_ERROR',
  'DATA_ERROR',
  'UNKNOWN',
]);
export type DiagnosisType = z.infer<typeof DiagnosisTypeSchema>;

export const DiagnosisSchema = z.object({
  vendorId: z.string().min(1),
  diagnosis: DiagnosisTypeSchema,
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  details: z.string().optional(),
  suggestedFix: z.string().optional(),
  timestamp: z.string().datetime(),
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;
