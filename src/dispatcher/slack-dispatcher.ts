import { Diagnosis, DiagnosisType } from '../schemas/index.js';

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
}
