import { expect, spyOn, test } from 'bun:test';
import { runWithContext } from '../../../src/application/observability/context';
import { JsonLogger } from '../../../src/infrastructure/observability/json-logger';

test('JSON log contains trace identifiers and does not serialize error payloads', () => {
  const write = spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    runWithContext({ correlationId: 'trace', messageId: 'message', transactionId: 'tx', walletId: 'wallet', providerId: 'provider' }, () => {
      new JsonLogger('test').log({ money: { amount: '987.65', currency: 'BRL' } });
    });
    const line = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({ correlationId: 'trace', messageId: 'message', transactionId: 'tx', walletId: 'wallet', providerId: 'provider' });
    expect(line).not.toContain('987.65');
  } finally {
    write.mockRestore();
  }
});
