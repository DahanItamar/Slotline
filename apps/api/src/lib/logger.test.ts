import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACTED_PATHS } from './logger.js';

/**
 * Redaction is the kind of control that silently stops working — a renamed field, a new
 * nesting level — and nothing fails until a log is read by someone who should not have
 * seen it. So it is asserted against a real pino instance rather than reviewed by eye.
 */
function capture(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  const stream = {
    write(line: string) {
      lines.push(line);
    },
  };
  const logger = pino({ redact: { paths: REDACTED_PATHS, censor: '[redacted]' } }, stream);
  logger.info(payload, 'test');
  return lines.join('');
}

describe('log redaction', () => {
  it('never writes a session cookie', () => {
    const output = capture({
      req: { headers: { cookie: 'slotline_session=super-secret-token' } },
    });
    expect(output).not.toContain('super-secret-token');
    expect(output).toContain('[redacted]');
  });

  it('never writes an Authorization header', () => {
    const output = capture({ req: { headers: { authorization: 'Bearer abc123' } } });
    expect(output).not.toContain('abc123');
  });

  it('never writes a Set-Cookie response header', () => {
    const output = capture({
      res: { headers: { 'set-cookie': 'slotline_session=issued-token; HttpOnly' } },
    });
    expect(output).not.toContain('issued-token');
  });

  it('never writes a password from a request body', () => {
    const output = capture({ password: 'correct-horse-battery' });
    expect(output).not.toContain('correct-horse-battery');
  });

  it('never writes a password nested one level down', () => {
    const output = capture({ body: { password: 'correct-horse-battery' } });
    expect(output).not.toContain('correct-horse-battery');
  });

  it('never writes a stored password hash', () => {
    const output = capture({ user: { passwordHash: '$argon2id$v=19$m=19456' } });
    expect(output).not.toContain('argon2id');
  });

  it('never writes an issued temporary password', () => {
    const output = capture({ temporaryPassword: 'q945-i6wu-q8mp-te6k' });
    expect(output).not.toContain('q945-i6wu');
  });

  it('still writes the fields that make a log useful', () => {
    const output = capture({ tenantId: 'tenant-1', userId: 'user-1', status: 200 });
    expect(output).toContain('tenant-1');
    expect(output).toContain('user-1');
  });
});
