resource "aws_security_group" "load" {

  for_each    = toset(["alb", "api", "consumer", "worker", "keycloak", "migration", "database", "runner", "endpoints"])
  name        = "${local.name}-${each.key}"
  description = "Private ${each.key} in the disposable wagering measurement"
  vpc_id      = aws_vpc.load.id
  # Empty rules: explicit directional rules below; no default internet egress.

}
locals {

  links = merge(
    {
      runner_alb = {
        from = "runner", to = "alb", port = 80
        }, alb_api = {
        from = "alb", to = "api", port = 3000
      }
    },
    {
      for role in ["api", "consumer", "worker"] : "metrics_${role}" => {
        from = "runner", to = role, port = 3000
      }
    },
    {
      for role in ["api", "consumer", "worker", "migration", "runner"] : "sql_${role}" => {
        from = role, to = "database", port = 5432
      }
    },
    {
      for role in ["api", "consumer", "worker", "runner"] : "identity_${role}" => {
        from = role, to = "keycloak", port = 8080
      }
    },
    {
      for role in ["api", "consumer", "worker", "migration", "keycloak", "runner"] : "endpoint_${role}" => {
        from = role, to = "endpoints", port = 443
      }
    }
  )

}
resource "aws_vpc_security_group_ingress_rule" "private" {

  for_each                     = local.links
  security_group_id            = aws_security_group.load[each.value.to].id
  referenced_security_group_id = aws_security_group.load[each.value.from].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port

}
resource "aws_vpc_security_group_egress_rule" "private" {

  for_each                     = local.links
  security_group_id            = aws_security_group.load[each.value.from].id
  referenced_security_group_id = aws_security_group.load[each.value.to].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port

}
resource "aws_vpc_security_group_egress_rule" "s3" {

  for_each          = toset(["api", "consumer", "worker", "migration", "keycloak", "runner"])
  security_group_id = aws_security_group.load[each.key].id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443

}

