resource "aws_ecr_repository" "image" {

  for_each             = toset(["app", "keycloak", "k6", "prometheus"])
  name                 = "${local.name}-${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "AES256"
  }

}
locals {

  images = {
    for name, repository in aws_ecr_repository.image : name => contains(keys(var.image_digests), name) ? "${repository.repository_url}@${var.image_digests[name]}" : "${repository.repository_url}:${var.source_commit}"
  }

}

