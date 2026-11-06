export interface AppConfig {
  port: number;
  databaseUrl: string;
  aws: { region: string; endpoint?: string };
  sqs: { queueUrl: string; dlqUrl: string };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing required env var ${key}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const endpoint = env.SQS_ENDPOINT;
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: required(env, 'DATABASE_URL'),
    aws: { region: env.AWS_REGION ?? 'us-east-1', ...(endpoint ? { endpoint } : {}) },
    sqs: { queueUrl: required(env, 'SQS_QUEUE_URL'), dlqUrl: required(env, 'SQS_DLQ_URL') },
  };
}
