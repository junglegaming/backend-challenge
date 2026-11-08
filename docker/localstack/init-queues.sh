#!/bin/bash
# Runs inside LocalStack when it reaches the "ready" stage.
set -e
awslocal sqs create-queue --queue-name wager-transactions.fifo 
--attributes FifoQueue=true,ContentBasedDeduplication=true

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

awslocal sqs create-queue --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

awslocal sqs create-queue --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,VisibilityTimeout=30

echo "SQS queues ready"
