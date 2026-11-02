# Mock provider only: these checks never contact AWS or create billable resources.
mock_provider "aws" {
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::123456789012:role/wagering-load-test01-fixture" } }
  mock_resource "aws_lb" { defaults = { arn = "arn:aws:elasticloadbalancing:us-east-2:123456789012:loadbalancer/app/wagering-load-test01/1234567890123456" } }
  mock_resource "aws_lb_target_group" { defaults = { arn = "arn:aws:elasticloadbalancing:us-east-2:123456789012:targetgroup/wagering-load-test01/1234567890123456" } }
  mock_resource "aws_lb_listener" { defaults = { arn = "arn:aws:elasticloadbalancing:us-east-2:123456789012:listener/app/wagering-load-test01/1234567890123456/1234567890123456" } }
  mock_resource "aws_ecs_cluster" { defaults = { arn = "arn:aws:ecs:us-east-2:123456789012:cluster/wagering-load-test01", id = "arn:aws:ecs:us-east-2:123456789012:cluster/wagering-load-test01" } }
  mock_resource "aws_ecs_service" { defaults = { id = "arn:aws:ecs:us-east-2:123456789012:service/wagering-load-test01/fixture" } }
  mock_resource "aws_ecs_task_definition" { defaults = { arn = "arn:aws:ecs:us-east-2:123456789012:task-definition/wagering-load-test01:1" } }
  mock_resource "aws_service_discovery_service" { defaults = { arn = "arn:aws:servicediscovery:us-east-2:123456789012:service/srv-fixture" } }
  mock_resource "aws_db_instance" {
    defaults = { address = "database.internal", master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:us-east-2:123456789012:secret:fixture", kms_key_id = "fixture", secret_status = "active" }] }
  }
}

variables {
  account_id         = "123456789012"
  session_id         = "test01"
  primary_az         = "us-east-2a"
  secondary_az       = "us-east-2b"
  runner_ami         = "ami-00000000000000000"
  database_version   = "17.11"
  source_commit      = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  session_started_at = "2026-11-01T00:00:00Z"
  stop_at            = "2026-11-01T03:00:00Z"
  client_secrets     = { PROVIDER_A_SECRET = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", PROVIDER_B_SECRET = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", OPERATOR_SECRET = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }
}

run "private_and_stopped_until_verified" {
  command = apply
  assert {
    condition     = aws_lb.load.internal && !aws_db_instance.load.publicly_accessible && !aws_db_instance.load.multi_az && !aws_instance.runner.associate_public_ip_address && alltrue([for subnet in aws_subnet.private : !subnet.map_public_ip_on_launch]) && alltrue([for service in aws_ecs_service.load : service.desired_count == 0 && !service.network_configuration[0].assign_public_ip])
    error_message = "All traffic must remain private and services must start at zero."
  }
  assert {
    condition     = aws_db_instance.load.instance_class == "db.m7g.2xlarge" && aws_instance.runner.instance_type == "c7i.2xlarge" && alltrue([for task in aws_ecs_task_definition.load : task.cpu == "1024" && task.memory == "2048"])
    error_message = "Sizes must stay within D26."
  }
  assert {
    condition     = length(aws_vpc_endpoint.interface) == 8 && length(aws_scheduler_schedule.stop) == 6 && alltrue([for schedule in aws_scheduler_schedule.stop : schedule.schedule_expression == "at(2026-11-01T03:00:00)" && schedule.state == "ENABLED"])
    error_message = "Eight private endpoints and all six fixed-deadline stops are mandatory."
  }
  assert {
    condition     = aws_scheduler_schedule.stop["database"].target[0].arn == "arn:aws:scheduler:::aws-sdk:rds:stopDBInstance" && toset(keys(jsondecode(aws_scheduler_schedule.stop["database"].target[0].input))) == toset(["DbInstanceIdentifier"]) && jsondecode(aws_scheduler_schedule.stop["database"].target[0].input).DbInstanceIdentifier == aws_db_instance.load.identifier
    error_message = "The RDS universal target must use its exact SDK input key."
  }
  assert {
    condition     = aws_sqs_queue.events.deduplication_scope == "messageGroup" && aws_sqs_queue.events.fifo_throughput_limit == "perMessageGroupId"
    error_message = "The events FIFO queue must retain the observed high-throughput configuration."
  }
  assert {
    condition     = aws_sqs_queue.requests.deduplication_scope == "messageGroup" && aws_sqs_queue.requests.fifo_throughput_limit == "perMessageGroupId"
    error_message = "The requests FIFO queue must explicitly support the remote backlog workload."
  }
  assert {
    condition     = toset(jsondecode(aws_iam_role_policy.task["api"].policy).Statement[0].Action) == toset(["sqs:GetQueueUrl", "sqs:GetQueueAttributes"]) && length(jsondecode(aws_iam_role_policy.task["api"].policy).Statement) == 1 && toset(jsondecode(aws_iam_role_policy.task["api"].policy).Statement[0].Resource) == toset(local.queue_arns)
    error_message = "API permissions must remain metadata-only."
  }
  assert {
    condition     = length([for statement in jsondecode(aws_iam_role_policy.runner.policy).Statement : statement if contains(statement.Action, "sqs:SendMessage")]) == 1 && one([for statement in jsondecode(aws_iam_role_policy.runner.policy).Statement : statement.Resource if contains(statement.Action, "sqs:SendMessage")]) == aws_sqs_queue.requests.arn
    error_message = "The runner must not retain the temporary events SendMessage grant."
  }
  assert {
    condition     = aws_lb_listener.http.default_action[0].type == "fixed-response" && alltrue([for rule in aws_lb_listener_rule.business : !contains(one(rule.condition).path_pattern[0].values, "/metrics")])
    error_message = "The internal ALB must not expose metrics."
  }
}

run "refuse_unverified_start" {
  command = plan
  variables { start_services = true }
  expect_failures = [var.start_services]
}

run "refuse_negative_previous_runtime" {
  command = plan
  variables { previous_runtime_seconds = -1 }
  expect_failures = [var.previous_runtime_seconds]
}

run "accept_three_hour_session_with_complete_history" {
  command = plan
  variables {
    session_started_at       = "2026-11-02T09:00:00Z"
    previous_runtime_seconds = 23356
    stop_at                  = "2026-11-02T12:00:00Z"
  }
}

run "refuse_three_hour_session_plus_one_second" {
  command = plan
  variables {
    session_started_at       = "2026-11-02T09:00:00Z"
    previous_runtime_seconds = 23356
    stop_at                  = "2026-11-02T12:00:01Z"
  }
  expect_failures = [var.stop_at]
}

run "verified_replica_counts" {
  command = apply
  variables {
    start_services      = true
    migration_verified  = true
    guardrails_verified = true
    image_digests       = { app = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", keycloak = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", k6 = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", prometheus = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" }
  }
  assert {
    condition     = aws_ecs_service.load["api"].desired_count == 3 && aws_ecs_service.load["consumer"].desired_count == 3 && aws_ecs_service.load["worker"].desired_count == 2 && aws_ecs_service.load["keycloak"].desired_count == 1
    error_message = "Steady topology must match 3/3/2 plus Keycloak."
  }
}
