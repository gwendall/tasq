output "public_ipv4" {
  description = "Create the domain A record with this address before expecting Caddy TLS readiness."
  value       = google_compute_address.public.address
}

output "canonical_origin" {
  value = "https://${var.domain}/"
}

output "server_image_authority" {
  value = var.tasq_server_image
}

output "resolved_cos_image" {
  description = "Resolved immutable COS image selected during this Terraform plan/apply."
  value       = data.google_compute_image.cos.self_link
}

output "backup_bucket" {
  value = google_storage_bucket.backups.url
}

output "iap_ssh_command" {
  value = "gcloud compute ssh ${google_compute_instance.tasq.name} --project ${var.project_id} --zone ${var.zone} --tunnel-through-iap"
}
