import { describe, expect, test } from 'bun:test';
import { HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { AppController } from '../src/app.controller';
import { AppService } from '../src/app.service';

describe('HTTP error mapping', () => {
  test('maps transient database connection failures to 503', async () => {
    const service = {
      submit: async () => {
        throw Object.assign(new Error('database unavailable'), { code: 'ECONNREFUSED' });
      },
    } as unknown as AppService;
    const controller = new AppController(service);
    const response = { status: () => response } as unknown as Response;
    let thrown: unknown;
    try {
      await controller.submit({}, 'test-key', response);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(503);
  });
});
