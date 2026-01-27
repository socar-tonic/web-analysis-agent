import { z } from 'zod';

export const SearchFormSpecSchema = z.object({
  searchInputSelector: z.string(),
  searchButtonSelector: z.string(),
  resultTableSelector: z.string().optional(),
  resultRowSelector: z.string().optional(),
});

export const SearchApiSpecSchema = z.object({
  endpoint: z.string(),
  method: z.enum(['GET', 'POST']),
  params: z.array(z.string()).optional(),
  requestFields: z.record(z.string(), z.string()).optional(),
  responseFields: z.array(z.string()),
});

export const SearchSpecSchema = z.object({
  systemCode: z.string(),
  url: z.string(),
  capturedAt: z.string().datetime(),
  searchType: z.enum(['dom', 'api', 'hybrid']),
  form: SearchFormSpecSchema.optional(),
  api: SearchApiSpecSchema.optional(),
  resultIndicators: z.object({
    successField: z.string().optional(),
    successValue: z.string().optional(),
    noResultText: z.string().optional(),
    rowSelector: z.string().optional(),
  }),
  version: z.number().default(1),
});

export type SearchSpec = z.infer<typeof SearchSpecSchema>;
export type SearchFormSpec = z.infer<typeof SearchFormSpecSchema>;
export type SearchApiSpec = z.infer<typeof SearchApiSpecSchema>;
