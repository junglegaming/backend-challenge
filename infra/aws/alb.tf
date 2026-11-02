resource "aws_lb" "load" {

  name                       = local.name
  internal                   = true
  load_balancer_type         = "application"
  subnets                    = [for subnet in aws_subnet.private : subnet.id]
  security_groups            = [aws_security_group.load["alb"].id]
  enable_deletion_protection = false

}
resource "aws_lb_target_group" "api" {

  name                 = local.name
  vpc_id               = aws_vpc.load.id
  target_type          = "ip"
  port                 = 3000
  protocol             = "HTTP"
  deregistration_delay = 30
  health_check {
    path                = "/health/live"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }

}
resource "aws_lb_listener" "http" {

  load_balancer_arn = aws_lb.load.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }

}
resource "aws_lb_listener_rule" "business" {

  for_each = {
    "10" = ["/wallets", "/wallets/*", "/wagering/transactions", "/wagering/transactions/*"], "20" = ["/providers/*/wagering/transactions/*", "/health/ready"]
  }
  listener_arn = aws_lb_listener.http.arn
  priority     = tonumber(each.key)
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
  condition {
    path_pattern {
      values = each.value
    }
  }

}

