import { z } from 'zod';

export const LoginResultSchema = z.object({
  status: z.enum([
    'SUCCESS',              // 로그인 성공
    'INVALID_CREDENTIALS',  // id/pwd 틀림
    'FORM_CHANGED',         // 로그인 폼 구조 변경
    'API_CHANGED',          // 로그인 API 변경
    'CONNECTION_ERROR',     // 접속 실패
    'UNKNOWN_ERROR',        // 알 수 없는 에러
  ]),
  confidence: z.number().min(0).max(1),

  // 상세 정보
  details: z.object({
    urlBefore: z.string(),
    urlAfter: z.string(),
    urlChanged: z.boolean(),
    errorMessage: z.string().optional(),
  }),

  // 변경 감지 (기존 코드가 깨지는지 검증)
  changes: z.object({
    hasChanges: z.boolean(),
    codeWillBreak: z.boolean().optional(),
    breakingChanges: z.array(z.string()).optional(),
    summary: z.string().optional(),
  }).optional(),

  // 세션 정보 (다음 에이전트가 사용)
  session: z.object({
    type: z.enum(['jwt', 'cookie', 'session', 'mixed']).optional(),
    accessToken: z.string().optional(),
    cookies: z.array(z.string()).optional(),
    localStorage: z.record(z.string(), z.string()).optional(),
    sessionStorage: z.record(z.string(), z.string()).optional(),
  }).optional(),

  timestamp: z.string().datetime(),
});

export type LoginResult = z.infer<typeof LoginResultSchema>;
