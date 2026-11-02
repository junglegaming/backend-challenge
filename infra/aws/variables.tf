variable "account_id" {

  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "Supply the explicitly verified member account ID."
  }

}
variable "session_id" {

  type = string
  validation {
    condition     = can(regex("^[a-z0-9]{6}$", var.session_id))
    error_message = "Session ID must contain six lowercase alphanumeric characters."
  }

}
variable "primary_az" {

  type = string
  validation {
    condition     = can(regex("^us-east-2[a-z]$", var.primary_az))
    error_message = "Only us-east-2 is authorized."
  }

}
variable "secondary_az" {

  type = string
  validation {
    condition     = can(regex("^us-east-2[a-z]$", var.secondary_az)) && var.secondary_az != var.primary_az
    error_message = "Use another AZ in us-east-2."
  }

}
variable "runner_ami" {

  type = string
  validation {
    condition     = can(regex("^ami-[a-f0-9]{17}$", var.runner_ami))
    error_message = "Pin the inspected ECS-optimized AL2023 x86_64 AMI."
  }

}
variable "database_version" {

  type = string
  validation {
    condition     = can(regex("^17\\.[0-9]+$", var.database_version))
    error_message = "Pin an available PostgreSQL 17 minor version."
  }

}
variable "source_commit" {

  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{40}$", var.source_commit))
    error_message = "Use the clean retained application commit."
  }

}
variable "session_started_at" {

  type = string
  validation {
    condition     = can(timeadd(var.session_started_at, "0s"))
    error_message = "Record the UTC time before first apply."
  }

}
variable "previous_runtime_seconds" {

  type    = number
  default = 0
  validation {
    condition     = var.previous_runtime_seconds >= 0 && floor(var.previous_runtime_seconds) == var.previous_runtime_seconds
    error_message = "Carry the complete previous runtime forward as nonnegative whole seconds."
  }

}
variable "stop_at" {

  type = string
  validation {

    condition     = try(timecmp(var.stop_at, timeadd(var.session_started_at, "10800s")) <= 0 && timecmp(var.stop_at, timeadd(var.session_started_at, "1200s")) > 0 && can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$", var.stop_at)), false)
    error_message = "The fixed stop deadline must respect the authorized three-hour session, including cleanup. Never reset it on reapply."

  }

}
variable "client_secrets" {

  type      = map(string)
  sensitive = true
  validation {

    condition     = length(var.client_secrets) == 3 && alltrue([for name in ["PROVIDER_A_SECRET", "PROVIDER_B_SECRET", "OPERATOR_SECRET"] : can(regex("^[a-f0-9]{64}$", var.client_secrets[name]))])
    error_message = "Supply three fresh random 32-byte hex secrets; local defaults are forbidden."

  }

}
variable "image_digests" {

  type = map(string)
  default = {

  }
  validation {
    condition     = alltrue([for name, value in var.image_digests : contains(["app", "keycloak", "k6", "prometheus"], name) && can(regex("^sha256:[a-f0-9]{64}$", value))])
    error_message = "Only exact digests for the four mirrored images are accepted."
  }

}
variable "run_database_name" {

  type    = string
  default = "wagering"
  validation {
    condition     = can(regex("^wagering(_[a-z0-9_]{1,40})?$", var.run_database_name))
    error_message = "Use an isolated experiment database name."
  }

}
variable "start_services" {

  type    = bool
  default = false
  validation {

    condition     = !var.start_services || (var.migration_verified && var.guardrails_verified && length(var.image_digests) == 4)
    error_message = "Verify migration exit zero, all six automatic stops and all four image digests before starting services."

  }

}
variable "migration_verified" {
  type    = bool
  default = false
}
variable "guardrails_verified" {
  type    = bool
  default = false
}

