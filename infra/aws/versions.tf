terraform {

  required_version = "= 1.17.1"
  required_providers {

    aws = {
      source = "hashicorp/aws", version = "= 6.71.0"
    }

  }
  # The operator supplies an absolute state path outside this repository.
  backend "local" {

  }

}

provider "aws" {

  region              = "us-east-2"
  profile             = "wagering-load"
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = {
      Project = "wagering-load", Session = var.session_id
    }
  }

}

locals {

  region = "us-east-2"
  name   = "wagering-load-${var.session_id}"
  roles  = toset(["api", "consumer", "worker", "keycloak", "migration"])
  counts = {
    api = 3, consumer = 3, worker = 2, keycloak = 1
  }

}

