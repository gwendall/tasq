locals {
  required_services = toset([
    "compute.googleapis.com",
    "iam.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
  ])

  common_labels = merge(var.labels, {
    application = "tasq"
    environment = "experimental"
    managed-by  = "terraform"
  })

  vm_member = "serviceAccount:${google_service_account.vm.email}"
}

resource "google_project_service" "required" {
  for_each = local.required_services

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_compute_network" "tasq" {
  name                    = "${var.name}-network"
  auto_create_subnetworks = false

  depends_on = [google_project_service.required]
}

resource "google_compute_subnetwork" "tasq" {
  name                     = "${var.name}-subnet"
  region                   = var.region
  network                  = google_compute_network.tasq.id
  ip_cidr_range            = "10.31.0.0/24"
  private_ip_google_access = true
}

resource "google_compute_address" "public" {
  name   = "${var.name}-ipv4"
  region = var.region
}

resource "google_compute_firewall" "https" {
  name    = "${var.name}-https"
  network = google_compute_network.tasq.name

  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["tasq-experimental-web"]

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}

resource "google_compute_firewall" "ssh_iap" {
  name    = "${var.name}-ssh-iap"
  network = google_compute_network.tasq.name

  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["tasq-experimental-iap-ssh"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_service_account" "vm" {
  account_id   = substr(replace("${var.name}-vm", "_", "-"), 0, 30)
  display_name = "Tasq experimental Compute Engine runtime"

  depends_on = [google_project_service.required]
}

data "google_secret_manager_secret" "server_config" {
  project   = var.project_id
  secret_id = var.server_config_secret_id

  depends_on = [google_project_service.required]
}

data "google_secret_manager_secret" "bootstrap" {
  project   = var.project_id
  secret_id = var.bootstrap_secret_id

  depends_on = [google_project_service.required]
}

data "google_secret_manager_secret" "enrollment_pepper" {
  project   = var.project_id
  secret_id = var.enrollment_pepper_secret_id

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_iam_member" "server_config" {
  project   = var.project_id
  secret_id = data.google_secret_manager_secret.server_config.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.vm_member
}

resource "google_secret_manager_secret_iam_member" "bootstrap" {
  project   = var.project_id
  secret_id = data.google_secret_manager_secret.bootstrap.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.vm_member
}

resource "google_secret_manager_secret_iam_member" "enrollment_pepper" {
  project   = var.project_id
  secret_id = data.google_secret_manager_secret.enrollment_pepper.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.vm_member
}

resource "google_storage_bucket" "backups" {
  name                        = var.backup_bucket_name
  project                     = var.project_id
  location                    = upper(var.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  labels = local.common_labels

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 3024000
  }

  retention_policy {
    retention_period = 3024000
    is_locked        = false
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket_iam_member" "backup_creator" {
  bucket = google_storage_bucket.backups.name
  role   = "roles/storage.objectCreator"
  member = local.vm_member
}

resource "google_storage_bucket_iam_member" "backup_viewer" {
  bucket = google_storage_bucket.backups.name
  role   = "roles/storage.objectViewer"
  member = local.vm_member
}

resource "google_compute_disk" "data" {
  name = "${var.name}-data"
  type = "pd-balanced"
  zone = var.zone
  size = var.data_disk_size_gb

  labels = local.common_labels

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.required]
}

data "google_compute_image" "cos" {
  family  = "cos-stable"
  project = "cos-cloud"
}

resource "google_compute_instance" "tasq" {
  name         = var.name
  machine_type = var.machine_type
  zone         = var.zone

  allow_stopping_for_update = true
  can_ip_forward            = false
  deletion_protection       = var.deletion_protection
  enable_display            = false

  tags   = ["tasq-experimental-web", "tasq-experimental-iap-ssh"]
  labels = local.common_labels

  boot_disk {
    auto_delete = true

    initialize_params {
      image = data.google_compute_image.cos.self_link
      size  = 20
      type  = "pd-balanced"
    }
  }

  attached_disk {
    source      = google_compute_disk.data.id
    device_name = "tasq-data"
    mode        = "READ_WRITE"
  }

  network_interface {
    subnetwork = google_compute_subnetwork.tasq.id

    access_config {
      nat_ip = google_compute_address.public.address
    }
  }

  metadata = {
    block-project-ssh-keys                = "TRUE"
    enable-oslogin                        = "TRUE"
    serial-port-enable                    = "FALSE"
    startup-script                        = file("${path.module}/scripts/startup.sh")
    tasq-init-script                      = file("${path.module}/scripts/init-data.sh")
    tasq-backup-script                    = file("${path.module}/scripts/backup.sh")
    tasq-restore-script                   = file("${path.module}/scripts/restore.sh")
    tasq-start-script                     = file("${path.module}/scripts/start-containers.sh")
    tasq-project-id                       = var.project_id
    tasq-domain                           = var.domain
    tasq-server-image                     = var.tasq_server_image
    tasq-caddy-image                      = var.caddy_image
    tasq-secret-fetcher-image             = var.secret_fetcher_image
    tasq-server-config-secret             = var.server_config_secret_id
    tasq-server-config-secret-version     = var.server_config_secret_version
    tasq-bootstrap-secret                 = var.bootstrap_secret_id
    tasq-bootstrap-secret-version         = var.bootstrap_secret_version
    tasq-enrollment-pepper-secret         = var.enrollment_pepper_secret_id
    tasq-enrollment-pepper-secret-version = var.enrollment_pepper_secret_version
    tasq-backup-bucket                    = google_storage_bucket.backups.name
    tasq-experimental-effects             = "false"
  }

  service_account {
    email  = google_service_account.vm.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  scheduling {
    automatic_restart   = true
    on_host_maintenance = "MIGRATE"
    preemptible         = false
    provisioning_model  = "STANDARD"
  }

  depends_on = [
    google_secret_manager_secret_iam_member.server_config,
    google_secret_manager_secret_iam_member.bootstrap,
    google_secret_manager_secret_iam_member.enrollment_pepper,
    google_storage_bucket_iam_member.backup_creator,
    google_storage_bucket_iam_member.backup_viewer,
  ]
}
