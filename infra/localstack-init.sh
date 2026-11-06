#!/bin/sh
awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true,ContentBasedDeduplication=true
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"true"}'
awslocal sqs set-queue-attributes --queue-url http://localhost:4566/000000000000/wager-transactions.fifo --attributes '{"RedrivePolicy":"{\"deadLetterTargetArn\":\"arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo\",\"maxReceiveCount\":\"5\"}"}'
awslocal sqs create-queue --queue-name wager-events.fifo --attributes FifoQueue=true,ContentBasedDeduplication=true
