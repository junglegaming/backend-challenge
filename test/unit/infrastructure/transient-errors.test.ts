import { describe, expect, test } from 'bun:test';
import { isTransientDatabaseError } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-enums';
import { statusFor } from '../../../src/interfaces/http/wagering.controller';

describe('isTransientDatabaseError', () => {
  test.each(['40001', '40P01', '55P03', '57014', '57P01', '08006', '53300', 'ECONNREFUSED', 'ECONNRESET'])(
    '%s is transient',
    (code) => expect(isTransientDatabaseError({ code })).toBe(true),
  );

  test.each(['23505', '23514', '23503', '22P02', '42P01'])('%s is not transient (retrying cannot help)', (code) =>
    expect(isTransientDatabaseError({ code })).toBe(false),
  );

  test('driver-level connection failures without a code', () => {
    expect(isTransientDatabaseError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientDatabaseError(new Error('boom'))).toBe(false);
    expect(isTransientDatabaseError(undefined)).toBe(false);
  });
});

describe('HTTP status per business outcome', () => {
  test('is distinct for processed, pending, rejected and failed', () => {
    expect(statusFor(WagerTransactionStatus.Processed)).toBe(200);
    expect(statusFor(WagerTransactionStatus.PendingReference)).toBe(202);
    expect(statusFor(WagerTransactionStatus.Rejected)).toBe(422);
    expect(statusFor(WagerTransactionStatus.Failed)).toBe(500);
  });
});
