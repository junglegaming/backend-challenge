resource "aws_scheduler_schedule_group" "load" {

  name = local.name

}
resource "aws_iam_role" "stop" {

  name = "${local.name}-automatic-stop"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "scheduler.amazonaws.com"
        }, Action = "sts:AssumeRole", Condition = {
        StringEquals = {
          "aws:SourceAccount" = var.account_id
          }, ArnEquals = {
          "aws:SourceArn" = aws_scheduler_schedule_group.load.arn
        }
      }
    }]
  })

}
resource "aws_iam_role_policy" "stop" {

  role = aws_iam_role.stop.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = ["ecs:UpdateService"], Resource = [for service in aws_ecs_service.load : service.id]
      },
      {
        Effect = "Allow", Action = ["rds:StopDBInstance"], Resource = aws_db_instance.load.arn
      },
      {
        Effect = "Allow", Action = ["ec2:StopInstances"], Resource = aws_instance.runner.arn
      }
    ]
  })

}
locals {

  stop_targets = merge(
    {
      for role, service in aws_ecs_service.load : role => {
        arn = "arn:aws:scheduler:::aws-sdk:ecs:updateService", input = jsonencode({
          Cluster = aws_ecs_cluster.load.arn, Service = service.id, DesiredCount = 0
        })
      }
    },
    {
      database = {
        arn = "arn:aws:scheduler:::aws-sdk:rds:stopDBInstance", input = jsonencode({
          DbInstanceIdentifier = aws_db_instance.load.identifier
        })
      },
      runner = {
        arn = "arn:aws:scheduler:::aws-sdk:ec2:stopInstances", input = jsonencode({
          InstanceIds = [aws_instance.runner.id]
        })
      }
    }
  )

}
resource "aws_scheduler_schedule" "stop" {

  for_each                     = local.stop_targets
  name                         = "stop-${each.key}"
  group_name                   = aws_scheduler_schedule_group.load.name
  schedule_expression          = "at(${trimsuffix(var.stop_at, "Z")})"
  schedule_expression_timezone = "UTC"
  state                        = "ENABLED"
  action_after_completion      = "NONE"
  flexible_time_window {
    mode = "OFF"
  }
  target {

    arn      = each.value.arn
    role_arn = aws_iam_role.stop.arn
    input    = each.value.input
    retry_policy {
      maximum_event_age_in_seconds = 3600
      maximum_retry_attempts       = 3
    }

  }
  depends_on = [aws_iam_role_policy.stop]

}

