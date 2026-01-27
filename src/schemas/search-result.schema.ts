import { z } from 'zod';

export const SearchResultSchema = z.object({
  status: z.enum([
    'SUCCESS',           // 차량 검색 성공
    'NOT_FOUND',         // 차량 없음 (정상 케이스)
    'FORM_CHANGED',      // 검색 폼 구조 변경 감지
    'API_CHANGED',       // 검색 API 변경 감지
    'SESSION_EXPIRED',   // 세션 만료
    'UNKNOWN_ERROR',     // 알 수 없는 에러
  ]),
  confidence: z.number().min(0).max(1),
  details: z.object({
    vehicleFound: z.boolean(),
    searchMethod: z.enum(['dom', 'api', 'hybrid']),
    resultCount: z.number().int().min(0),
    errorMessage: z.string().optional(),
  }),
  vehicle: z.object({
    id: z.string(),
    plateNumber: z.string(),
    inTime: z.string(),
    outTime: z.string().optional(),
    lastOrderId: z.string().optional(),
  }).optional(),
  changes: z.object({
    hasChanges: z.boolean(),
    codeWillBreak: z.boolean().optional(),
    breakingChanges: z.array(z.string()).optional(),
    summary: z.string().optional(),
  }).optional(),
  timestamp: z.string().datetime(),
});

export type SearchResult = z.infer<typeof SearchResultSchema>;
