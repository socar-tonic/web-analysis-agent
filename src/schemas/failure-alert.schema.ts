import { z } from 'zod';

export const FailedStepSchema = z.enum(['login', 'search', 'apply', 'verify']);
export type FailedStep = z.infer<typeof FailedStepSchema>;

export const FailureAlertSchema = z.object({
  vendorId: z.string().min(1),
  vehicleNumber: z.string().optional(),
  failedStep: FailedStepSchema.optional(),
  errorMessage: z.string().optional(),
  timestamp: z.string().datetime(),
});

export type FailureAlert = z.infer<typeof FailureAlertSchema>;
