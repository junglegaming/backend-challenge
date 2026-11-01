resource "aws_s3_bucket" "artifacts" {

  bucket        = "${local.name}-${var.account_id}-us-east-2"
  force_destroy = true

}
resource "aws_s3_bucket_public_access_block" "artifacts" {

  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

}
resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {

  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }

}
resource "aws_s3_bucket_policy" "tls" {

  bucket = aws_s3_bucket.artifacts.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Sid = "TLSOnly", Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"], Condition = {
        Bool = {
          "aws:SecureTransport" = "false"
        }
      }
    }]
  })

}
resource "aws_cloudwatch_log_group" "service" {

  for_each          = local.roles
  name              = "/${local.name}/${each.key}"
  retention_in_days = 1
  skip_destroy      = false

}
resource "aws_secretsmanager_secret" "client" {

  for_each                = toset(["PROVIDER_A_SECRET", "PROVIDER_B_SECRET", "OPERATOR_SECRET"])
  name                    = "${local.name}/${each.key}"
  recovery_window_in_days = 0

}
resource "aws_secretsmanager_secret_version" "client" {

  for_each      = aws_secretsmanager_secret.client
  secret_id     = each.value.id
  secret_string = var.client_secrets[each.key]

}

