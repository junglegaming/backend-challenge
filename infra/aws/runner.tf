resource "aws_iam_role" "runner" {

  name = "${local.name}-runner"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "ec2.amazonaws.com"
      }, Action = "sts:AssumeRole"
    }]
  })

}
resource "aws_iam_role_policy_attachment" "runner_ssm" {

  role       = aws_iam_role.runner.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"

}
resource "aws_iam_role_policy" "runner" {

  role = aws_iam_role.runner.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*"
      },
      {
        Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], Resource = [for repository in aws_ecr_repository.image : repository.arn]
      },
      {
        Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.artifacts.arn}/bundle/*"
      },
      {
        Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.artifacts.arn}/results/*"
      },
      {
        Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = concat([aws_db_instance.load.master_user_secret[0].secret_arn], [for secret in aws_secretsmanager_secret.client : secret.arn])
      },
      {
        Effect = "Allow", Action = ["sqs:GetQueueUrl", "sqs:GetQueueAttributes"], Resource = local.queue_arns
      },
      {
        Effect = "Allow", Action = ["sqs:SendMessage"], Resource = aws_sqs_queue.requests.arn
      },
      {
        Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"], Resource = aws_sqs_queue.events.arn
      }
    ]
  })

}
resource "aws_iam_instance_profile" "runner" {

  name = "${local.name}-runner"
  role = aws_iam_role.runner.name

}
resource "aws_instance" "runner" {

  ami                         = var.runner_ami
  instance_type               = "c7i.2xlarge"
  subnet_id                   = aws_subnet.private["primary"].id
  associate_public_ip_address = false
  vpc_security_group_ids      = [aws_security_group.load["runner"].id]
  iam_instance_profile        = aws_iam_instance_profile.runner.name
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  root_block_device {
    volume_size           = 40
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }
  user_data = <<-INIT
    #!/bin/bash
    set -eu
    # ECS-optimized AL2023 already provides Docker, SSM and AWS CLI; no public downloads.
    systemctl disable --now ecs.service || true
    install -d -m 0700 /opt/wagering-load
    # Do not start Docker synchronously inside cloud-init: that can deadlock cloud-final.
    systemctl enable docker.service
  INIT
  tags = {
    Name = "${local.name}-runner"
  }
  volume_tags = {
    Project = "wagering-load", Session = var.session_id
  }
  depends_on = [aws_iam_role_policy.runner, aws_iam_role_policy_attachment.runner_ssm, aws_vpc_endpoint.interface, aws_vpc_endpoint.s3, aws_s3_bucket_public_access_block.artifacts]

}

