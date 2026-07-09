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
