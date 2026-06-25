export type SmsSender = {
  sendPhoneCode(input: { phoneE164: string; code: string }): Promise<void>;
};

export class InMemorySmsSender implements SmsSender {
  readonly messages: Array<{ phoneE164: string; code: string }> = [];

  async sendPhoneCode(input: { phoneE164: string; code: string }): Promise<void> {
    this.messages.push(input);
  }
}

export type MunjanaraSmsSenderConfig = {
  endpoint: string;
  userId: string;
  apiKey: string;
  senderId: string;
  fetchImpl?: typeof fetch;
};

export class MunjanaraSmsSender implements SmsSender {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: MunjanaraSmsSenderConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async sendPhoneCode(input: { phoneE164: string; code: string }): Promise<void> {
    const response = await this.fetchImpl(this.config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        userid: this.config.userId,
        passwd: this.config.apiKey,
        sender: this.config.senderId,
        receiver: this.toNationalPhone(input.phoneE164),
        msg: `[채티] 인증번호는 ${input.code}입니다. 5분 안에 입력해주세요.`,
      }),
    });

    if (!response.ok) {
      throw new Error("SMS_SEND_FAILED");
    }
  }

  private toNationalPhone(phoneE164: string): string {
    if (!phoneE164.startsWith("+82")) {
      throw new Error("SMS_PHONE_UNSUPPORTED");
    }

    return `0${phoneE164.slice(3)}`;
  }
}
