import { Migration } from '@mikro-orm/migrations';

export class Migration20261106000005_inbox_outbox extends Migration {
  override up(): void {
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint inbox_messages_pk primary key (consumer_name, message_id)
      );
    `);
    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null default now(),
        published_at timestamptz,
        constraint outbox_messages_attempts_ck check (attempts >= 0)
      );
    `);
    this.addSql(`
      create index outbox_messages_pending_idx
        on outbox_messages (next_attempt_at) where published_at is null;
    `);
  }

  override down(): void {
    this.addSql('drop table if exists outbox_messages;');
    this.addSql('drop table if exists inbox_messages;');
  }
}
