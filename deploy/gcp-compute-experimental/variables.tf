variable "project_id" {
  description = "Dedicated GCP project with active billing."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be one canonical GCP project ID."
  }
}

variable "region" {
  description = "Experimental deployment region. The first profile is intentionally Paris-only."
  type        = string
  default     = "europe-west9"

  validation {
    condition     = var.region == "europe-west9"
    error_message = "This experimental profile is frozen to europe-west9."
  }
}

variable "zone" {
  description = "Compute Engine zone inside the frozen Paris region."
  type        = string
  default     = "europe-west9-a"

  validation {
    condition     = startswith(var.zone, "europe-west9-")
    error_message = "zone must belong to europe-west9."
  }
}

variable "name" {
  description = "Prefix for experimental resources."
  type        = string
  default     = "tasq-experimental"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,38}[a-z0-9]$", var.name))
    error_message = "name must be a lowercase GCP resource prefix."
  }
}

variable "domain" {
  description = "Canonical DNS hostname already controlled by the maintainer. Terraform does not create its DNS record."
  type        = string

  validation {
    condition = (
      length(var.domain) >= 1 &&
      length(var.domain) <= 253 &&
      can(regex(
        "^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$",
        var.domain,
      ))
    )
    error_message = "domain must be one lowercase DNS hostname without scheme, path, port or wildcard."
  }
}

variable "tasq_server_image" {
  description = "Protected public Tasq Server image authority, pinned to an exact GHCR sha256 digest."
  type        = string

  validation {
    condition = can(regex(
      "^ghcr\\.io/gwendall/tasq-server@sha256:[0-9a-f]{64}$",
      var.tasq_server_image,
    ))
    error_message = "tasq_server_image must be ghcr.io/gwendall/tasq-server@sha256:<64 lowercase hex>."
  }
}

variable "caddy_image" {
  description = "Caddy reverse proxy pinned to an exact digest."
  type        = string
  default     = "caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"

  validation {
    condition     = can(regex("^caddy:[^@[:space:]]+@sha256:[0-9a-f]{64}$", var.caddy_image))
    error_message = "caddy_image must use an exact sha256 digest."
  }
}

variable "secret_fetcher_image" {
  description = "Google Cloud CLI helper image pinned to an exact digest; used only to fetch Secret Manager values and copy backups."
  type        = string

  validation {
    condition = can(regex(
      "^([a-z0-9.-]+/)+[a-z0-9._/-]+:[^@[:space:]]+@sha256:[0-9a-f]{64}$",
      var.secret_fetcher_image,
    ))
    error_message = "secret_fetcher_image must be a tagged image pinned to an exact sha256 digest."
  }
}

variable "server_config_secret_id" {
  description = "Existing Secret Manager secret containing exact Tasq Server config JSON."
  type        = string
  default     = "tasq-experimental-server-config"
}

variable "server_config_secret_version" {
  description = "Enabled numeric Secret Manager version containing the reviewed Server config."
  type        = string

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.server_config_secret_version))
    error_message = "server_config_secret_version must be one explicit numeric version, never latest."
  }
}

variable "bootstrap_secret_id" {
  description = "Existing Secret Manager secret containing exact deterministic bootstrap JSON."
  type        = string
  default     = "tasq-experimental-bootstrap"
}

variable "bootstrap_secret_version" {
  description = "Enabled numeric Secret Manager version containing the reviewed bootstrap manifest."
  type        = string

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.bootstrap_secret_version))
    error_message = "bootstrap_secret_version must be one explicit numeric version, never latest."
  }
}

variable "enrollment_pepper_secret_id" {
  description = "Existing Secret Manager secret containing the canonical base64url enrollment pepper."
  type        = string
  default     = "tasq-experimental-enrollment-pepper"
}

variable "enrollment_pepper_secret_version" {
  description = "Enabled numeric Secret Manager version containing the canonical enrollment pepper."
  type        = string

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.enrollment_pepper_secret_version))
    error_message = "enrollment_pepper_secret_version must be one explicit numeric version, never latest."
  }
}

variable "backup_bucket_name" {
  description = "Globally unique bucket name for off-VM Tasq application backups."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$", var.backup_bucket_name))
    error_message = "backup_bucket_name must be a valid globally unique Cloud Storage bucket name."
  }
}

variable "machine_type" {
  description = "Small bounded VM shape for the private experiment."
  type        = string
  default     = "e2-small"
}

variable "data_disk_size_gb" {
  description = "Persistent balanced disk size. It can be increased later but never reduced."
  type        = number
  default     = 50

  validation {
    condition     = var.data_disk_size_gb >= 20 && var.data_disk_size_gb <= 500
    error_message = "data_disk_size_gb must be between 20 and 500 GiB."
  }
}

variable "deletion_protection" {
  description = "Keep VM deletion protection enabled unless a maintainer explicitly approves teardown."
  type        = bool
  default     = true
}

variable "labels" {
  description = "Additional non-sensitive labels."
  type        = map(string)
  default     = {}
}
