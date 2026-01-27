import { z } from 'zod';

// 로그인 폼 셀렉터 정보
export const LoginFormSpecSchema = z.object({
  usernameSelector: z.string(),
  passwordSelector: z.string(),
  submitSelector: z.string(),
  // 추가 필드 (OTP, 캡챠 등)
  additionalFields: z.array(z.object({
    name: z.string(),
    selector: z.string(),
    type: z.string(),
  })).optional(),
});

// 로그인 API 엔드포인트 정보
export const LoginApiSpecSchema = z.object({
  endpoint: z.string(),
  method: z.enum(['GET', 'POST', 'PUT']),
  contentType: z.enum(['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data']),
  requestFields: z.array(z.string()), // ['username', 'password', 'rememberMe']
  responseFields: z.array(z.string()), // ['token', 'refreshToken', 'user']
});

// 벤더별 힌트 (특이한 구조 처리용)
export const VendorHintsSchema = z.object({
  login: z.object({
    usernameSelector: z.string().optional(),
    passwordSelector: z.string().optional(),
    submitSelector: z.string().optional(),
    failureTexts: z.array(z.string()).optional(),
  }).optional(),

  search: z.object({
    description: z.string().optional(),
    inputMethod: z.enum(['text', 'keypad']).optional(),
    inputSelector: z.string().optional(),
    keypadButtons: z.array(z.string()).optional(),
    searchButtonText: z.string().optional(),
    vehicleNumberSlice: z.tuple([z.number(), z.number().nullable()]).optional(),
    resultRowSelector: z.string().optional(),
    fallbackSelectors: z.array(z.string()).optional(),
  }).optional(),

  quirks: z.object({
    dismissAlerts: z.boolean().optional(),
    preSubmitDelay: z.number().optional(),
    specialCases: z.array(z.string()).optional(),
  }).optional(),
});

export type VendorHints = z.infer<typeof VendorHintsSchema>;

// 전체 로그인 Spec
export const LoginSpecSchema = z.object({
  systemCode: z.string(),
  url: z.string(),
  capturedAt: z.string().datetime(),

  // 로그인 방식
  loginType: z.enum(['dom', 'api', 'hybrid']),

  // DOM 기반 로그인 정보
  form: LoginFormSpecSchema.optional(),

  // API 기반 로그인 정보
  api: LoginApiSpecSchema.optional(),

  // 로그인 성공 판별 조건
  successIndicators: z.object({
    urlPattern: z.string().optional(),       // 로그인 후 URL 패턴
    elementSelector: z.string().optional(),  // 로그인 후 나타나는 요소
    cookieName: z.string().optional(),       // 설정되는 쿠키 이름
  }),

  // 벤더 힌트 (선택)
  hints: VendorHintsSchema.optional(),

  // 메타데이터
  version: z.number().default(1),
});

export type LoginSpec = z.infer<typeof LoginSpecSchema>;
export type LoginFormSpec = z.infer<typeof LoginFormSpecSchema>;
export type LoginApiSpec = z.infer<typeof LoginApiSpecSchema>;
