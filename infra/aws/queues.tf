resource "aws_sqs_queue" "dead_letters" {

  name                        = "wager-transactions-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = false

}
resource "aws_sqs_queue" "requests" {

  name                        = "wager-transactions.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  deduplication_scope         = "messageGroup"
  fifo_throughput_limit       = "perMessageGroupId"
  visibility_timeout_seconds  = 30
  receive_wait_time_seconds   = 20
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letters.arn, maxReceiveCount = 5
  })

}
resource "aws_sqs_queue" "events" {

  name                        = "wagering-events.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  deduplication_scope         = "messageGroup"
  fifo_throughput_limit       = "perMessageGroupId"

}
locals {

  queue_arns = [aws_sqs_queue.requests.arn, aws_sqs_queue.events.arn, aws_sqs_queue.dead_letters.arn]

}

