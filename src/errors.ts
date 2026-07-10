export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

export class InvalidStateError extends AgentError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateError';
  }
}

export class WriteValidationError extends AgentError {
  readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = 'WriteValidationError';
    this.issues = issues;
  }
}

export interface LlmToolCallRejectedErrorOptions {
  providerCode?: string;
  providerMessage?: string;
}

export class LlmToolCallRejectedError extends AgentError {
  readonly providerCode?: string;
  readonly providerMessage?: string;

  constructor(message: string, options: LlmToolCallRejectedErrorOptions = {}) {
    super(message);
    this.name = 'LlmToolCallRejectedError';
    this.providerCode = options.providerCode;
    this.providerMessage = options.providerMessage;
  }
}
