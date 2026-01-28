import { Diagnosis, DiagnosisType } from '../schemas/index.js';

export type NotificationType =
  | 'SERVER_DOWN'
  | 'PR_CREATED'
  | 'SIGNATURE_CHANGED'
  | 'ANALYSIS_COMPLETE';

export interface NotificationPayload {
  type: NotificationType;
  systemCode: string;
  message?: string;
  prUrl?: string;
  prNumber?: number;
  changes?: string[];
  error?: string;
}

const EMOJI_MAP: Record<DiagnosisType, string> = {
  SERVER_OR_FIREWALL: ':rotating_light:',
  SIGNATURE_CHANGED: ':warning:',
  INTERNAL_ERROR: ':x:',
  DATA_ERROR: ':question:',
  UNKNOWN: ':mag:',
};

const LABEL_MAP: Record<DiagnosisType, string> = {
  SERVER_OR_FIREWALL: '서버/방화벽 문제',
  SIGNATURE_CHANGED: 'UI/API 시그니처 변경',
  INTERNAL_ERROR: '내부 오류',
  DATA_ERROR: '데이터 오류',
  UNKNOWN: '수동 확인 필요',
};

export class SlackDispatcher {
  private isMock: boolean;

  constructor(private webhookUrl: string) {
    this.isMock = webhookUrl === 'mock';
  }

  async sendDiagnosis(diagnosis: Diagnosis): Promise<void> {
    const emoji = EMOJI_MAP[diagnosis.diagnosis];
    const label = LABEL_MAP[diagnosis.diagnosis];

    const messageText = `${emoji} *[${diagnosis.vendorId}]* ${label}\n> ${diagnosis.summary}\n_신뢰도: ${Math.round(diagnosis.confidence * 100)}%_`;

    if (this.isMock) {
      console.log(`[MOCK SLACK] ${messageText}`);
      return;
    }

    const message = { text: messageText };

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.status}`);
    }
  }

  /**
   * 범용 알림 메서드 - 다양한 상황에서 재사용
   */
  async notify(payload: NotificationPayload): Promise<void> {
    let messageText: string;

    switch (payload.type) {
      case 'SERVER_DOWN':
        messageText = `:rotating_light: *[${payload.systemCode}]* 서버 접속 불가\n` +
          `> ${payload.message || '서버 또는 방화벽 문제'}`;
        break;

      case 'PR_CREATED':
        messageText = `:rocket: *[${payload.systemCode}]* Draft PR 생성됨\n` +
          `> ${payload.changes?.join(', ') || '시그니처 변경 감지'}\n` +
          `:link: <${payload.prUrl}|PR #${payload.prNumber} 바로가기>`;
        break;

      case 'SIGNATURE_CHANGED':
        messageText = `:warning: *[${payload.systemCode}]* 시그니처 변경 감지\n` +
          `> ${payload.changes?.map(c => `• ${c}`).join('\n') || '변경 사항 있음'}\n` +
          (payload.error ? `_자동 PR 생성 실패: ${payload.error}_` : '_수동 확인 필요_');
        break;

      case 'ANALYSIS_COMPLETE':
        messageText = `:white_check_mark: *[${payload.systemCode}]* 분석 완료\n` +
          `> ${payload.message || '정상'}`;
        break;

      default:
        messageText = `*[${payload.systemCode}]* ${payload.message || '알림'}`;
    }

    if (this.isMock) {
      console.log(`[MOCK SLACK] ${messageText}`);
      return;
    }

    const message = { text: messageText };

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.status}`);
    }
  }
}
