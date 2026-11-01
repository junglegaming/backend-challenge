resource "aws_vpc" "load" {

  cidr_block           = "10.72.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags = {
    Name = local.name
  }

}
resource "aws_subnet" "private" {

  for_each = {
    primary = {
      az = var.primary_az, cidr = "10.72.0.0/24"
      }, secondary = {
      az = var.secondary_az, cidr = "10.72.1.0/24"
    }
  }
  vpc_id                  = aws_vpc.load.id
  availability_zone       = each.value.az
  cidr_block              = each.value.cidr
  map_public_ip_on_launch = false
  tags = {
    Name = "${local.name}-${each.key}"
  }

}
resource "aws_route_table" "private" {

  vpc_id = aws_vpc.load.id
  tags = {
    Name = local.name
  }

}
resource "aws_route_table_association" "private" {

  for_each       = aws_subnet.private
  subnet_id      = each.value.id
  route_table_id = aws_route_table.private.id

}

