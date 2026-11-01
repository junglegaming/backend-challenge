resource "aws_service_discovery_private_dns_namespace" "load" {

  name = "${local.name}.internal"
  vpc  = aws_vpc.load.id

}
resource "aws_service_discovery_service" "load" {

  for_each      = local.counts
  name          = each.key
  force_destroy = true
  dns_config {

    namespace_id = aws_service_discovery_private_dns_namespace.load.id
    dns_records {
      ttl  = 5
      type = "A"
    }
    routing_policy = "MULTIVALUE"

  }
  health_check_custom_config {
    failure_threshold = 1
  }

}

