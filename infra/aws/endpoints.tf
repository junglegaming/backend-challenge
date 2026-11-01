resource "aws_vpc_endpoint" "interface" {

  for_each            = toset(["sqs", "ecr.api", "ecr.dkr", "logs", "secretsmanager", "ssm", "ssmmessages", "ec2messages"])
  vpc_id              = aws_vpc.load.id
  service_name        = "com.amazonaws.us-east-2.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private["primary"].id]
  security_group_ids  = [aws_security_group.load["endpoints"].id]
  private_dns_enabled = true
  tags = {
    Name = "${local.name}-${each.key}"
  }

}
resource "aws_vpc_endpoint" "s3" {

  vpc_id            = aws_vpc.load.id
  service_name      = "com.amazonaws.us-east-2.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = "*", Action = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"], Resource = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*", "arn:aws:s3:::prod-us-east-2-starport-layer-bucket/*"]
    }]
  })
  tags = {
    Name = local.name
  }

}

