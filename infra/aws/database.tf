resource "aws_db_subnet_group" "load" {

  name       = local.name
  subnet_ids = [for subnet in aws_subnet.private : subnet.id]

}
resource "aws_db_parameter_group" "load" {

  name   = local.name
  family = "postgres17"
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
  parameter {
    name         = "max_connections"
    value        = "200"
    apply_method = "pending-reboot"
  }
  parameter {
    name         = "idle_in_transaction_session_timeout"
    value        = "10000"
    apply_method = "immediate"
  }

}
resource "aws_db_instance" "load" {

  identifier                  = local.name
  engine                      = "postgres"
  engine_version              = var.database_version
  instance_class              = "db.m7g.2xlarge"
  allocated_storage           = 100
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = "wagering"
  username                    = "wagering"
  manage_master_user_password = true
  availability_zone           = var.primary_az
  multi_az                    = false
  publicly_accessible         = false
  db_subnet_group_name        = aws_db_subnet_group.load.name
  parameter_group_name        = aws_db_parameter_group.load.name
  vpc_security_group_ids      = [aws_security_group.load["database"].id]
  backup_retention_period     = 0
  delete_automated_backups    = true
  skip_final_snapshot         = true
  deletion_protection         = false
  auto_minor_version_upgrade  = false
  apply_immediately           = true
  copy_tags_to_snapshot       = true

}

