# This allowlist contains identifiers/endpoints only. Never output secrets or state values.
output "inventory" {

  value = {

    session = var.session_id, commit = var.source_commit, region = local.region,
    vpc = aws_vpc.load.id, subnets = {
      for name, subnet in aws_subnet.private : name => subnet.id
    },
    security_groups = {
      for name, group in aws_security_group.load : name => group.id
    },
    endpoints = [for endpoint in aws_vpc_endpoint.interface : endpoint.id], s3_endpoint = aws_vpc_endpoint.s3.id,
    runner    = aws_instance.runner.id, runner_volume = aws_instance.runner.root_block_device[0].volume_id,
    cluster = aws_ecs_cluster.load.arn, services = {
      for name, service in aws_ecs_service.load : name => service.id
    },
    task_definitions = {
      for name, task in aws_ecs_task_definition.load : name => task.arn
    },
    roles                 = concat([for role in aws_iam_role.execution : role.name], [for role in aws_iam_role.task : role.name], [aws_iam_role.runner.name, aws_iam_role.stop.name]),
    instance_profile      = aws_iam_instance_profile.runner.name,
    database              = aws_db_instance.load.identifier, database_host = aws_db_instance.load.address,
    database_secret_arn   = aws_db_instance.load.master_user_secret[0].secret_arn,
    database_subnet_group = aws_db_subnet_group.load.name, database_parameter_group = aws_db_parameter_group.load.name,
    queue_urls            = [aws_sqs_queue.requests.url, aws_sqs_queue.events.url, aws_sqs_queue.dead_letters.url],
    client_secret_arns = {
      for name, secret in aws_secretsmanager_secret.client : name => secret.arn
    },
    alb                   = aws_lb.load.arn, target_group = aws_lb_target_group.api.arn,
    api_url               = "http://${aws_lb.load.dns_name}", issuer = local.issuer,
    namespace             = aws_service_discovery_private_dns_namespace.load.name,
    namespace_id          = aws_service_discovery_private_dns_namespace.load.id,
    namespace_hosted_zone = aws_service_discovery_private_dns_namespace.load.hosted_zone,
    discovery_services    = [for service in aws_service_discovery_service.load : service.id],
    repositories = {
      for name, repository in aws_ecr_repository.image : name => repository.repository_url
    },
    bucket         = aws_s3_bucket.artifacts.id,
    log_groups     = [for group in aws_cloudwatch_log_group.service : group.name],
    stop_group     = aws_scheduler_schedule_group.load.name,
    stop_schedules = [for schedule in aws_scheduler_schedule.stop : schedule.name], stop_at = var.stop_at

  }

}

