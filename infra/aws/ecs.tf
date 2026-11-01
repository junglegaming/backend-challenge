resource "aws_ecs_cluster" "load" {

  name = local.name

}
resource "aws_iam_role" "execution" {

  for_each = local.roles
  name     = "${local.name}-${each.key}-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "ecs-tasks.amazonaws.com"
        }, Action = "sts:AssumeRole", Condition = {
        StringEquals = {
          "aws:SourceAccount" = var.account_id
          }, ArnLike = {
          "aws:SourceArn" = "arn:aws:ecs:us-east-2:${var.account_id}:*"
        }
      }
    }]
  })

}
resource "aws_iam_role" "task" {

  for_each           = local.roles
  name               = "${local.name}-${each.key}-task"
  assume_role_policy = aws_iam_role.execution[each.key].assume_role_policy

}
resource "aws_iam_role_policy" "execution" {

  for_each = local.roles
  role     = aws_iam_role.execution[each.key].id
  policy = jsonencode({
    Version = "2012-10-17", Statement = concat([
      {
        Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*"
      },
      {
        Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], Resource = aws_ecr_repository.image[each.key == "keycloak" ? "keycloak" : "app"].arn
      },
      {
        Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.service[each.key].arn}:*"
      }
      ], [{
        Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = each.key == "keycloak" ? [for secret in aws_secretsmanager_secret.client : secret.arn] : [aws_db_instance.load.master_user_secret[0].secret_arn]
    }])
  })

}
resource "aws_iam_role_policy" "task" {

  for_each = toset(["api", "consumer", "worker"])
  role     = aws_iam_role.task[each.key].id
  policy = jsonencode({
    Version = "2012-10-17", Statement = concat([
      {
        Effect = "Allow", Action = ["sqs:GetQueueUrl", "sqs:GetQueueAttributes"], Resource = local.queue_arns
      }
      ], each.key == "consumer" ? [
      {
        Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"], Resource = [aws_sqs_queue.requests.arn]
      },
      {
        Effect = "Allow", Action = ["sqs:SendMessage"], Resource = [aws_sqs_queue.dead_letters.arn]
      }
      ] : each.key == "worker" ? [
      {
        Effect = "Allow", Action = ["sqs:SendMessage"], Resource = [aws_sqs_queue.events.arn]
      }
    ] : [])
  })

}
locals {

  issuer = "http://keycloak.${aws_service_discovery_private_dns_namespace.load.name}:8080/realms/wagering"
  app_environment = {

    NODE_ENV                = "production", TZ = "UTC", PORT = "3000",
    BUN_CONFIG_NO_ENV_FILE  = "true", BUN_CONFIG_NO_AUTO_INSTALL = "true",
    DB_HOST                 = aws_db_instance.load.address, DB_PORT = "5432", DB_NAME = var.run_database_name,
    DB_USER                 = "wagering", DB_SSL_CA_FILE = "/app/docker/aws/us-east-2-bundle.crt",
    SQS_ENDPOINT            = "https://sqs.us-east-2.amazonaws.com", AWS_REGION = "us-east-2",
    AUTH_ISSUER             = local.issuer, AUTH_JWKS_URL = "${local.issuer}/protocol/openid-connect/certs",
    BOOTSTRAP_CREATE_QUEUES = "false", TEST_SYNC_POINTS = "", TEST_SYNC_MATCH = "",
    SQS_WAIT_SECONDS        = "20", SQS_VISIBILITY_SECONDS = "30", SQS_MAX_RECEIVES = "5",
    SQS_RETRY_BASE_SECONDS  = "2", SQS_RETRY_MAX_SECONDS = "30", CONSUMER_CONCURRENCY = "10",
    SQS_BATCH_SIZE          = "10", SHUTDOWN_DRAIN_MS = "25000", OUTBOX_LEASE_MS = "15000",
    OUTBOX_RETRY_MAX_MS     = "300000", REFERENCE_TTL_MS = "86400000"

  }

}
resource "aws_ecs_task_definition" "load" {

  for_each                 = local.roles
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  skip_destroy             = false
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{

    name        = each.key, image = local.images[each.key == "keycloak" ? "keycloak" : "app"], essential = true,
    stopTimeout = 30,
    portMappings = each.key == "migration" ? [] : [{
      containerPort = each.key == "keycloak" ? 8080 : 3000, protocol = "tcp"
    }],
    command = each.key == "keycloak" ? ["start-dev", "--import-realm"] : ["bun", "--no-env-file", each.key == "migration" ? "src/cli/bootstrap.ts" : "src/main.ts"],
    environment = each.key == "keycloak" ? [
      {
        name = "KC_HOSTNAME", value = "http://keycloak.${aws_service_discovery_private_dns_namespace.load.name}:8080"
      },
      {
        name = "KC_HTTP_ENABLED", value = "true"
        }, {
        name = "TZ", value = "UTC"
      }
      ] : [for name, value in merge(local.app_environment, {
        APP_ROLE = each.key == "migration" ? "api" : each.key
        }) : {
        name = name, value = value
    }],
    secrets = each.key == "keycloak" ? [for name, secret in aws_secretsmanager_secret.client : {
      name = name, valueFrom = secret.arn
      }] : [
      {
        name = "DB_PASSWORD", valueFrom = "${aws_db_instance.load.master_user_secret[0].secret_arn}:password::"
      }
    ],
    logConfiguration = {
      logDriver = "awslogs", options = {
        awslogs-group = aws_cloudwatch_log_group.service[each.key].name, awslogs-region = "us-east-2", awslogs-stream-prefix = each.key, mode = "non-blocking", max-buffer-size = "4m"
      }
    }

  }])
  depends_on = [aws_iam_role_policy.execution, aws_iam_role_policy.task, aws_secretsmanager_secret_version.client]

}
resource "aws_ecs_service" "load" {

  for_each                           = local.counts
  name                               = "${local.name}-${each.key}"
  cluster                            = aws_ecs_cluster.load.id
  task_definition                    = aws_ecs_task_definition.load[each.key].arn
  desired_count                      = var.start_services ? each.value : 0
  launch_type                        = "FARGATE"
  platform_version                   = "1.4.0"
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  deployment_circuit_breaker {
    enable   = true
    rollback = false
  }
  network_configuration {

    subnets          = [aws_subnet.private["primary"].id]
    security_groups  = [aws_security_group.load[each.key].id]
    assign_public_ip = false

  }
  service_registries {
    registry_arn = aws_service_discovery_service.load[each.key].arn
  }
  dynamic "load_balancer" {

    for_each = each.key == "api" ? [true] : []
    content {
      target_group_arn = aws_lb_target_group.api.arn
      container_name   = "api"
      container_port   = 3000
    }

  }
  depends_on = [aws_lb_listener_rule.business, aws_vpc_endpoint.interface, aws_vpc_endpoint.s3]

}

