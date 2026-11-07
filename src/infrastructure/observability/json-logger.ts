import type { LoggerService } from '@nestjs/common';
import { currentContext } from '../../application/observability/context';

/** Never serialize arbitrary errors or objects, which can contain SQL parameters or message bodies. */
export class JsonLogger implements LoggerService {
  constructor(private readonly scope = 'Application') {}

  log(message: unknown): void { this.write('info', message); }
  error(message: unknown): void { this.write('error', message); }
  warn(message: unknown): void { this.write('warn', message); }
  debug(message: unknown): void { this.write('debug', message); }
  verbose(message: unknown): void { this.write('debug', message); }

  private write(level: string, message: unknown): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      scope: this.scope,
      ...currentContext(),
      message: typeof message === 'string' ? message : 'Non-string log message',
    };
    const line = JSON.stringify(entry);
    if (level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
}
