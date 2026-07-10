import { describe, test, expect } from 'bun:test';
import { AgentError, InvalidStateError, WriteValidationError, LlmToolCallRejectedError } from '../src/errors';

describe('error types', () => {
  test('InvalidStateError is an AgentError and an Error', () => {
    const err = new InvalidStateError('bad state');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toBeInstanceOf(InvalidStateError);
    expect(err.name).toBe('InvalidStateError');
    expect(err.message).toBe('bad state');
  });

  test('WriteValidationError carries an issues array', () => {
    const err = new WriteValidationError('invalid write', ['unknown field: foo', 'missing key']);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.issues).toEqual(['unknown field: foo', 'missing key']);
  });

  test('a plain AgentError is not an InvalidStateError', () => {
    const err = new AgentError('generic failure');
    expect(err).toBeInstanceOf(AgentError);
    expect(err).not.toBeInstanceOf(InvalidStateError);
  });

  test('LlmToolCallRejectedError is an AgentError and carries provider details', () => {
    const err = new LlmToolCallRejectedError('rejected', { providerCode: 'tool_use_failed', providerMessage: 'bad op' });
    expect(err).toBeInstanceOf(AgentError);
    expect(err.name).toBe('LlmToolCallRejectedError');
    expect(err.providerCode).toBe('tool_use_failed');
    expect(err.providerMessage).toBe('bad op');
  });
});
