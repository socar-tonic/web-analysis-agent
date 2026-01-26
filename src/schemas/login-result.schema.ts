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

  // 변경 감지 (기존 Spec과 비교)
  changes: z.object({
    hasChanges: z.boolean(),
    formChanges: z.array(z.string()).optional(),  // ['usernameSelector changed', ...]
    apiChanges: z.array(z.string()).optional(),   // ['endpoint changed', ...]
  }).optional(),

  timestamp: z.string().datetime(),
});

export type LoginResult = z.infer<typeof LoginResultSchema>;
